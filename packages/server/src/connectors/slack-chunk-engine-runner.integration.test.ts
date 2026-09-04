import { CompiledQuery, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger, createTestPgDb } from "../test-utils";
import type { ChunkEngineKnobs } from "./chunk-engine";
import { runSlackChunkEngine, runSlackChunkStream, slackIdleCloseCandidatesQuery } from "./slack-chunk-engine-runner";

const knobs: ChunkEngineKnobs = {
  windowMessages: 10,
  windowTokens: 7_500,
  minMessages: 1,
  targetMessages: 10,
  maxMessages: 80,
  maxTokens: 1_500,
  tickMinutes: 30,
  idleCloseHours: 96,
  provisionalRefreshMessages: 20,
  model: null,
  reasoningEffort: "high",
  burstThresholdMessages: null,
  topicRegistryCap: 30,
  groupWorkerPool: 2,
  maxWindowsPerRun: 8,
};

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>, explainPrefix: string): void {
  describe(label, () => {
    let db!: Kysely<DB>;
    let conversationId!: number;

    beforeEach(async () => {
      db = await createDb();
      const conversation = await createConversationRepository(db).getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: `C-${label}`,
      });
      conversationId = conversation.id;
    }, 30_000);

    afterEach(async () => {
      await db.destroy();
    });

    async function message(providerId: string, threadTs?: string): Promise<number> {
      const inserted = await createConversationRepository(db).insertMessage({
        conversationId,
        providerMessageId: providerId,
        senderJid: "U1",
        senderName: "Asha",
        text: providerId,
        providerThreadId: threadTs ?? providerId,
        providerParentMessageId: threadTs ?? null,
        isThreadReply: threadTs !== undefined,
        providerTimestamp: "2026-09-04T00:00:00.000Z",
        receivedAt: "2026-09-04T00:00:00.000Z",
      });
      return inserted.row.id;
    }

    const generate = async (prompt: string) => {
      const count = [...prompt.matchAll(/^\d+\. /gm)].length;
      return JSON.stringify({ segments: [{ start: 1, end: count, threads: ["topic"] }] });
    };

    it("uses the open ended_at partial index for idle candidates", async () => {
      const compiled = slackIdleCloseCandidatesQuery(db, "2026-09-05T00:00:00.000Z").compile();
      const explained = await db.executeQuery(
        CompiledQuery.raw(`${explainPrefix} ${compiled.sql}`, [...compiled.parameters]),
      );
      expect(JSON.stringify(explained.rows)).toContain("conversation_slices_open_ended_at_idx");
    });

    it("keeps interleaved channel and thread streams non-overlapping across runs", async () => {
      const root = await message("thread-root");
      const firstReply = await message("thread-reply-1", "thread-root");
      const channel = await message("channel-2");
      const secondReply = await message("thread-reply-2", "thread-root");
      await runSlackChunkEngine({
        db,
        logger: createTestLogger(),
        generate,
        channelKnobs: knobs,
        threadKnobs: knobs,
        discoveryPageRows: 100,
        discoveryMaxPages: 10,
        now: new Date("2026-09-05T00:00:00.000Z"),
      });
      const nextChannel = await message("channel-3");
      const nextReply = await message("thread-reply-3", "thread-root");
      await runSlackChunkEngine({
        db,
        logger: createTestLogger(),
        generate,
        channelKnobs: knobs,
        threadKnobs: knobs,
        discoveryPageRows: 100,
        discoveryMaxPages: 10,
        now: new Date("2026-09-05T00:31:00.000Z"),
      });

      const slices = await db
        .selectFrom("conversation_slices")
        .select(["provider_thread_id", "status", "denoised_message_ids"])
        .where("conversation_id", "=", conversationId)
        .orderBy("provider_thread_id")
        .execute();
      expect(slices).toHaveLength(2);
      expect(slices.every((slice) => slice.status === "open")).toBe(true);
      const memberships = slices.map((slice) => JSON.parse(slice.denoised_message_ids ?? "[]") as number[]);
      expect(memberships).toContainEqual([root, channel, nextChannel]);
      expect(memberships).toContainEqual([firstReply, secondReply, nextReply]);
      expect(new Set(memberships.flat()).size).toBe(6);
    });

    it("self-heals an active rollback stream before advancing", async () => {
      const first = await message("first");
      await db
        .insertInto("conversation_slice_stream_cursors")
        .values({ conversation_id: conversationId, stream_key: "channel", pending_since: "2026-09-05T00:00:00.000Z" })
        .execute();
      await runSlackChunkStream({
        db,
        logger: createTestLogger(),
        now: new Date("2026-09-05T00:00:00.000Z"),
        conversationId,
        streamKey: "channel",
        knobs,
        generate,
      });
      const oldOpen = await createConversationSlicesRepository(db).getOpenSlice(conversationId, null);
      const rollbackMessage = await message("rollback-closed");
      await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId,
        firstMessageId: rollbackMessage,
        lastMessageId: rollbackMessage,
        startedAt: "2026-09-01T00:00:00.000Z",
        endedAt: "2026-09-01T00:00:00.000Z",
        messageCount: 1,
        denoisedMessageIds: [rollbackMessage],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });
      await db
        .updateTable("conversation_slice_stream_cursors")
        .set({ last_message_id: rollbackMessage, pending_since: "2026-09-05T01:00:00.000Z" })
        .where("conversation_id", "=", conversationId)
        .where("stream_key", "=", "channel")
        .execute();
      const next = await message("next");

      await runSlackChunkStream({
        db,
        logger: createTestLogger(),
        now: new Date("2026-09-05T01:00:00.000Z"),
        conversationId,
        streamKey: "channel",
        knobs,
        generate,
      });

      const rows = await db
        .selectFrom("conversation_slices")
        .select(["id", "first_message_id", "status"])
        .where("conversation_id", "=", conversationId)
        .orderBy("first_message_id")
        .execute();
      const cursor = await createConversationSlicesRepository(db).getStreamCursor(conversationId, "channel");
      expect(rows.find((row) => row.id === oldOpen?.id)?.status).toBe("closed");
      expect(rows.at(-1)).toMatchObject({ first_message_id: next, status: "open" });
      expect(cursor?.last_message_id).toBe(next);
      expect(first).toBeLessThan(rollbackMessage);
    });
  });
}

runSuite("Slack chunk runner SQLite", createTestDb, "EXPLAIN QUERY PLAN");
runSuite("Slack chunk runner Postgres", createTestPgDb, "EXPLAIN");
