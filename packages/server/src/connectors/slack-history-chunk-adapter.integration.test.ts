import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger, getSharedPgDb } from "../test-utils";
import { runChunkingPass } from "./chunk-engine";
import {
  createSlackHistoryChunkAdapter,
  createSlackThreadChunkAdapter,
  repairSlackChunkStreamsOnStartup,
} from "./slack-chunk-adapters";

const knobs = {
  windowMessages: 20,
  windowTokens: 7_500,
  minMessages: 1,
  targetMessages: 40,
  maxMessages: 80,
  maxTokens: 1_500,
  tickMinutes: 30,
  idleCloseHours: 96,
  provisionalRefreshMessages: 15,
  model: null,
  reasoningEffort: "high" as const,
  burstThresholdMessages: null,
  topicRegistryCap: 30,
  groupWorkerPool: 4,
  maxWindowsPerRun: 4,
};

const THREAD_TS = "1698000000.000100";

/** Thread streams are single-segment, so no boundary generation ever runs. */
function deps(db: Kysely<DB>) {
  return {
    db,
    logger: createTestLogger(),
    generate: async () => Promise.reject(new Error("boundary generation must not run")),
  };
}

async function seedChannel(db: Kysely<DB>): Promise<number> {
  const conversation = await createConversationRepository(db).getOrCreate({
    platform: "slack",
    kind: "channel",
    providerConversationId: `C${randomUUID().slice(0, 8)}`,
  });
  return conversation.id;
}

async function insertRow(
  db: Kysely<DB>,
  input: { conversationId: number; ts: string; source: "live" | "history"; rangeId?: string },
): Promise<number> {
  const captured = await createConversationRepository(db).insertMessage({
    conversationId: input.conversationId,
    providerMessageId: input.ts,
    senderJid: "U1",
    senderName: "Asha",
    text: `message ${input.ts}`,
    providerThreadId: THREAD_TS,
    providerParentMessageId: THREAD_TS,
    isThreadReply: true,
    providerTimestamp: new Date(Number(input.ts) * 1000).toISOString(),
    receivedAt: new Date(Number(input.ts) * 1000).toISOString(),
    source: input.source,
    ...(input.rangeId ? { backfillRangeId: input.rangeId } : {}),
  });
  return captured.row.id;
}

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>, shared = false): void {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      if (shared) await sql`BEGIN`.execute(db);
    }, 30_000);

    afterEach(async () => {
      if (shared) await sql`ROLLBACK`.execute(db);
      else await db.destroy();
    });

    it("keeps a live open slice and a history pass on the same stream independent", async () => {
      const conversationId = await seedChannel(db);
      const rangeId = randomUUID();
      await insertRow(db, { conversationId, ts: "1700000100", source: "live" });
      await insertRow(db, { conversationId, ts: "1699000100", source: "history", rangeId });
      await insertRow(db, { conversationId, ts: "1700000200", source: "live" });
      await insertRow(db, { conversationId, ts: "1699000200", source: "history", rangeId });

      const live = createSlackThreadChunkAdapter({ conversationId, threadTs: THREAD_TS, knobs });
      await runChunkingPass(deps(db), { adapter: live, mode: "live" });
      const history = createSlackHistoryChunkAdapter({ conversationId, threadTs: THREAD_TS, rangeId, knobs });
      await runChunkingPass(deps(db), { adapter: history, mode: "backfill" });

      const repo = createConversationSlicesRepository(db);
      const liveOpen = await repo.getOpenSlice(conversationId, THREAD_TS, "live");
      const historyOpen = await repo.getOpenSlice(conversationId, THREAD_TS, "history");
      expect(liveOpen).toBeDefined();
      expect(historyOpen).toBeDefined();
      expect(liveOpen?.id).not.toEqual(historyOpen?.id);
      const slices = await db
        .selectFrom("conversation_slices")
        .select(["origin", "first_message_id", "last_message_id"])
        .where("conversation_id", "=", conversationId)
        .orderBy("origin")
        .orderBy("first_message_id")
        .execute();
      expect(slices.filter((row) => row.origin === "live")).toHaveLength(1);
      expect(slices.filter((row) => row.origin === "history")).toHaveLength(1);
    });

    it("leaves the live stream alone when history slices interleave by row id", async () => {
      const conversationId = await seedChannel(db);
      const rangeId = randomUUID();
      const liveFirst = await insertRow(db, { conversationId, ts: "1700000100", source: "live" });
      await insertRow(db, { conversationId, ts: "1699000100", source: "history", rangeId });
      await insertRow(db, { conversationId, ts: "1700000200", source: "live" });

      const live = createSlackThreadChunkAdapter({ conversationId, threadTs: THREAD_TS, knobs });
      await runChunkingPass(deps(db), { adapter: live, mode: "live" });
      const repo = createConversationSlicesRepository(db);
      const liveOpen = await repo.getOpenSlice(conversationId, THREAD_TS, "live");
      expect(liveOpen?.first_message_id).toEqual(liveFirst);

      const history = createSlackHistoryChunkAdapter({ conversationId, threadTs: THREAD_TS, rangeId, knobs });
      await runChunkingPass(deps(db), { adapter: history, mode: "backfill" });
      await sql`UPDATE conversation_slices SET status = 'closed' WHERE origin = 'history'`.execute(db);

      await insertRow(db, { conversationId, ts: "1700000300", source: "live" });
      const second = await runChunkingPass(deps(db), { adapter: live, mode: "live" });
      expect(second.skippedReason).toBeUndefined();
      const stillOpen = await repo.getOpenSlice(conversationId, THREAD_TS, "live");
      expect(stillOpen?.id).toEqual(liveOpen?.id);

      const repaired = await repairSlackChunkStreamsOnStartup(db, createTestLogger());
      expect(repaired.orphanedOpenSlicesClosed).toEqual(0);
    });

    it("advances the history cursor by (effective_at, id) without re-reading rows", async () => {
      const conversationId = await seedChannel(db);
      const rangeId = randomUUID();
      const newest = await insertRow(db, { conversationId, ts: "1699000300", source: "history", rangeId });
      const oldest = await insertRow(db, { conversationId, ts: "1699000100", source: "history", rangeId });
      expect(oldest).toBeGreaterThan(newest);

      const history = createSlackHistoryChunkAdapter({ conversationId, threadTs: THREAD_TS, rangeId, knobs });
      const first = await runChunkingPass(deps(db), { adapter: history, mode: "backfill" });
      expect(first.messagesProcessed).toEqual(2);
      const cursor = await createConversationSlicesRepository(db).getStreamCursor(
        conversationId,
        `${THREAD_TS}::history`,
      );
      expect(cursor?.last_message_id).toEqual(newest);
      expect(cursor?.last_effective_at).toEqual(new Date(1699000300 * 1000).toISOString());

      const second = await runChunkingPass(deps(db), { adapter: history, mode: "backfill" });
      expect(second.messagesProcessed).toEqual(0);
    });
  });
}

runSuite("Slack history chunk adapter SQLite", createTestDb);
runSuite("Slack history chunk adapter Postgres", getSharedPgDb, true);
