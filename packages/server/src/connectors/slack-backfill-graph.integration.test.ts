import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationFollowupsRepository } from "../db/repositories/conversation-followups";
import { createConversationRepository } from "../db/repositories/conversations";
import { createSlackBackfillRangeRepository } from "../db/repositories/slack-backfill-ranges";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { runChunkingPass } from "./chunk-engine";
import { admitSlackBackfillGraphPages } from "./slack-backfill-graph";
import { createSlackThreadChunkAdapter, resolveSlackChunkEngineKnobs } from "./slack-chunk-adapters";

const NOW = new Date("2026-09-11T00:00:00.000Z");
const THREAD_TS = "1789000000.000100";
const CHANNEL = "C600";

const knobs = resolveSlackChunkEngineKnobs(undefined);

async function seedRange(db: Kysely<DB>): Promise<{ conversationId: number; rangeId: string }> {
  const conversation = await createConversationRepository(db).getOrCreate({
    platform: "slack",
    kind: "channel",
    providerConversationId: CHANNEL,
  });
  const { row } = await createSlackBackfillRangeRepository(db).ensureRange({
    channelId: CHANNEL,
    conversationId: conversation.id,
    kind: "initial",
    rangeKey: "initial",
    lowerTs: "1757548800.000000",
    upperTs: "1789084800.000000",
  });
  await createSlackBackfillRangeRepository(db).setPhase(row.id, "fetched", NOW.toISOString());
  return { conversationId: conversation.id, rangeId: row.id };
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

function admit(db: Kysely<DB>) {
  return admitSlackBackfillGraphPages({
    db,
    logger: createTestLogger(),
    generate: undefined,
    channelKnobs: knobs.channel,
    threadKnobs: knobs.thread,
    now: NOW,
  });
}

describe("Slack backfill graph admission", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  }, 30_000);

  afterEach(async () => {
    await db.destroy();
  });

  it("slices history rows into history-origin slices and completes the range with no open history slice", async () => {
    const { conversationId, rangeId } = await seedRange(db);
    await insertRow(db, { conversationId, ts: "1788000000.000300", source: "history", rangeId });
    await insertRow(db, { conversationId, ts: "1788000000.000100", source: "history", rangeId });

    const first = await admit(db);
    expect(first.messagesRead).toEqual(2);
    const range = await createSlackBackfillRangeRepository(db).getById(rangeId);
    expect(range?.graph_cursor_id).not.toBeNull();
    expect(range?.graph_completed_at).toBeNull();

    const second = await admit(db);
    expect(second.rangesCompleted).toEqual(1);
    const completed = await createSlackBackfillRangeRepository(db).getById(rangeId);
    expect(completed?.phase).toEqual("complete");
    expect(completed?.graph_completed_at).not.toBeNull();

    const slices = await db.selectFrom("conversation_slices").select(["origin", "status"]).execute();
    expect(slices.length).toBeGreaterThan(0);
    expect(slices.every((slice) => slice.origin === "history" && slice.status === "closed")).toBe(true);
  });

  it("leaves the live open slice and live pending queries untouched", async () => {
    const { conversationId, rangeId } = await seedRange(db);
    await insertRow(db, { conversationId, ts: "1789000100.000100", source: "live" });
    await insertRow(db, { conversationId, ts: "1788000000.000100", source: "history", rangeId });

    const live = createSlackThreadChunkAdapter({ conversationId, threadTs: THREAD_TS, knobs: knobs.thread });
    const deps = {
      db,
      logger: createTestLogger(),
      generate: async () => Promise.reject(new Error("boundary generation must not run")),
    };
    await runChunkingPass(deps, { adapter: live, mode: "live" });
    const liveOpen = await db
      .selectFrom("conversation_slices")
      .selectAll()
      .where("origin", "=", "live")
      .where("status", "=", "open")
      .executeTakeFirstOrThrow();

    await admit(db);
    await admit(db);

    const stillOpen = await db
      .selectFrom("conversation_slices")
      .selectAll()
      .where("id", "=", liveOpen.id)
      .executeTakeFirstOrThrow();
    expect(stillOpen).toEqual(liveOpen);
    const second = await runChunkingPass(deps, { adapter: live, mode: "live" });
    expect(second.skippedReason).toBeUndefined();
  });

  it("leaves followup reminder queries unchanged when history rows land", async () => {
    const { conversationId, rangeId } = await seedRange(db);
    const followups = createConversationFollowupsRepository(db);
    const query = () =>
      followups.queryPersonalReminders({
        userId: randomUUID(),
        assigneeEntityIds: [],
        now: NOW.toISOString(),
      });
    const before = await query();
    await insertRow(db, { conversationId, ts: "1788000000.000100", source: "history", rangeId });
    expect(await query()).toEqual(before);
  });
});
