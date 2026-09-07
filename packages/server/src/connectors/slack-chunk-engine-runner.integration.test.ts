import {
  CompiledQuery,
  type Kysely,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger, createTestPgDb } from "../test-utils";
import type { ChunkEngineKnobs } from "./chunk-engine";
import { runSlackChunkEngine, runSlackChunkStream, slackIdleCloseCandidatesQuery } from "./slack-chunk-engine-runner";
import { SLACK_ROUTER_STREAM_KEY } from "./slack-chunk-messages";

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

/**
 * Fails every full `conversation_slice_stream_cursors` read for one
 * conversation, which is what the tick gate does before the pass starts. A
 * transient fault there must be absorbed by the tick, not rejected out of the
 * `Promise.all` that fans streams out.
 */
class StreamCursorReadFault implements KyselyPlugin {
  constructor(private readonly conversationId: number) {}

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return args.node;
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const hit = args.result.rows.some(
      (row) =>
        "llm_last_attempt_at" in row &&
        Number((row as { conversation_id?: unknown }).conversation_id) === this.conversationId,
    );
    if (hit) throw new Error("stream cursor read failed");
    return args.result;
  }
}

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

    it("absorbs a failing stream gate as one failure and still runs the idle lane", async () => {
      const repo = createConversationRepository(db);
      const now = new Date("2026-09-05T00:00:00.000Z");
      await message("healthy-1");
      await message("healthy-2");

      const faulty = await repo.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: `C-fault-${label}`,
      });
      for (const providerId of ["fault-1", "fault-2"]) {
        await repo.insertMessage({
          conversationId: faulty.id,
          providerMessageId: providerId,
          senderJid: "U9",
          senderName: "Bo",
          text: providerId,
          providerThreadId: providerId,
          providerTimestamp: "2026-09-04T00:00:00.000Z",
          receivedAt: "2026-09-04T00:00:00.000Z",
        });
      }

      const idle = await repo.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: `C-idle-${label}`,
      });
      const idleMessage = await repo.insertMessage({
        conversationId: idle.id,
        providerMessageId: "idle-1",
        senderJid: "U8",
        senderName: "Cai",
        text: "idle-1",
        providerThreadId: "idle-1",
        providerTimestamp: "2026-08-01T00:00:00.000Z",
        receivedAt: "2026-08-01T00:00:00.000Z",
      });
      await db
        .insertInto("conversation_slices")
        .values({
          id: `idle-open-slice-${label}`,
          conversation_id: idle.id,
          first_message_id: idleMessage.row.id,
          last_message_id: idleMessage.row.id,
          started_at: "2026-08-01T00:00:00.000Z",
          ended_at: "2026-08-01T00:00:00.000Z",
          message_count: 1,
          denoised_message_ids: JSON.stringify([idleMessage.row.id]),
          flush_reason: "gap" as const,
          roster_snapshot: "[]",
          salience_verdict: "kept",
          status: "open" as const,
        })
        .execute();
      await db
        .insertInto("conversation_slice_stream_cursors")
        .values({
          conversation_id: idle.id,
          stream_key: SLACK_ROUTER_STREAM_KEY,
          last_message_id: idleMessage.row.id,
        })
        .execute();

      const summary = await runSlackChunkEngine({
        db: db.withPlugin(new StreamCursorReadFault(faulty.id)),
        logger: createTestLogger(),
        generate,
        channelKnobs: knobs,
        threadKnobs: knobs,
        discoveryPageRows: 100,
        discoveryMaxPages: 10,
        now,
      });

      expect(summary.streamFailures).toBe(1);
      expect(summary.idleCloses).toBe(1);
      expect(summary.windowsRun).toBeGreaterThan(0);
      const healthySlices = await db
        .selectFrom("conversation_slices")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .execute();
      expect(healthySlices.length).toBeGreaterThan(0);
      const faultySlices = await db
        .selectFrom("conversation_slices")
        .select("id")
        .where("conversation_id", "=", faulty.id)
        .execute();
      expect(faultySlices).toHaveLength(0);
      const idleSlice = await db
        .selectFrom("conversation_slices")
        .select(["status", "flush_reason"])
        .where("conversation_id", "=", idle.id)
        .executeTakeFirstOrThrow();
      expect(idleSlice.status).toBe("closed");
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
