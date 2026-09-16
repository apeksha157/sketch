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
import {
  createSlackHistoryChunkAdapter,
  createSlackThreadChunkAdapter,
  resolveSlackChunkEngineKnobs,
  slackHistoryStreamKey,
} from "./slack-chunk-adapters";

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
  input: { conversationId: number; ts: string; source: "live" | "history"; rangeId?: string; threadTs?: string },
): Promise<number> {
  const threadTs = input.threadTs ?? THREAD_TS;
  const captured = await createConversationRepository(db).insertMessage({
    conversationId: input.conversationId,
    providerMessageId: input.ts,
    senderJid: "U1",
    senderName: "Asha",
    text: `message ${input.ts}`,
    providerThreadId: threadTs,
    providerParentMessageId: threadTs,
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
    expect(first.rangesCompleted).toEqual(1);
    const completed = await createSlackBackfillRangeRepository(db).getById(rangeId);
    expect(completed?.phase).toEqual("complete");
    expect(completed?.graph_completed_at).not.toBeNull();

    const slices = await db.selectFrom("conversation_slices").select(["origin", "status"]).execute();
    expect(slices.length).toBeGreaterThan(0);
    expect(slices.every((slice) => slice.origin === "history" && slice.status === "closed")).toBe(true);
  });

  it("reads a range past WhatsApp's 500-message page in one sync under the Slack caps", async () => {
    const { conversationId, rangeId } = await seedRange(db);
    for (let index = 0; index < 600; index += 1) {
      const ts = `1788000000.${String(index + 1).padStart(6, "0")}`;
      await insertRow(db, { conversationId, ts, source: "history", rangeId, threadTs: ts });
    }

    const summary = await admit(db);
    expect(summary.messagesRead).toEqual(600);
    expect(summary.rangesCompleted).toEqual(1);
  });

  it("finishes a multi-thread range in one pass when the oldest thread is already consumed", async () => {
    const { conversationId, rangeId } = await seedRange(db);
    await insertRow(db, {
      conversationId,
      ts: "1788000000.000100",
      source: "history",
      rangeId,
      threadTs: "1788000000.000100",
    });
    await insertRow(db, {
      conversationId,
      ts: "1788100000.000100",
      source: "history",
      rangeId,
      threadTs: "1788100000.000100",
    });
    await insertRow(db, {
      conversationId,
      ts: "1788100000.000200",
      source: "history",
      rangeId,
      threadTs: "1788100000.000100",
    });
    await insertRow(db, {
      conversationId,
      ts: "1788200000.000100",
      source: "history",
      rangeId,
      threadTs: "1788200000.000100",
    });

    const pass = await admit(db);

    expect(pass.rangesCompleted).toEqual(1);
    const range = await createSlackBackfillRangeRepository(db).getById(rangeId);
    expect(range?.graph_completed_at).not.toBeNull();
    const open = await db.selectFrom("conversation_slices").select("id").where("status", "=", "open").execute();
    expect(open).toEqual([]);
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

  it("keeps the range cursor and completion behind a stream the engine could not claim", async () => {
    const { conversationId, rangeId } = await seedRange(db);
    const oldest = await insertRow(db, { conversationId, ts: "1788000000.000100", source: "history", rangeId });
    const newest = await insertRow(db, { conversationId, ts: "1788000000.000300", source: "history", rangeId });
    await db
      .insertInto("conversation_slice_stream_cursors")
      .values({
        conversation_id: conversationId,
        stream_key: slackHistoryStreamKey(THREAD_TS, rangeId),
        claim_token: "held-elsewhere",
        claimed_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      })
      .execute();

    await admit(db);
    await admit(db);
    const ranges = createSlackBackfillRangeRepository(db);
    const blocked = await ranges.getById(rangeId);
    expect(blocked?.graph_cursor_id).toBeNull();
    expect(blocked?.graph_completed_at).toBeNull();
    expect(blocked?.graph_last_served_at).not.toBeNull();

    await db
      .updateTable("conversation_slice_stream_cursors")
      .set({ claim_token: null, claimed_at: null })
      .where("conversation_id", "=", conversationId)
      .execute();
    await admit(db);
    await admit(db);
    const completed = await ranges.getById(rangeId);
    expect(completed?.graph_completed_at).not.toBeNull();
    const slices = await db
      .selectFrom("conversation_slices")
      .select(["origin", "status", "first_message_id", "last_message_id"])
      .execute();
    expect(slices).toEqual([
      { origin: "history", status: "closed", first_message_id: oldest, last_message_id: newest },
    ]);
  });

  it("closes only the finished range's open history slices", async () => {
    const otherThread = "1789000000.000900";
    const { conversationId, rangeId } = await seedRange(db);
    const ranges = createSlackBackfillRangeRepository(db);
    const { row: later } = await ranges.ensureRange({
      channelId: CHANNEL,
      conversationId,
      kind: "gap",
      rangeKey: "gap-1",
      lowerTs: "1788500000.000000",
      upperTs: "1789084800.000000",
    });
    await ranges.setPhase(later.id, "fetched", NOW.toISOString());
    await insertRow(db, {
      conversationId,
      ts: "1788600000.000100",
      source: "history",
      rangeId: later.id,
      threadTs: otherThread,
    });
    await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => Promise.reject(new Error("must not run")) },
      {
        adapter: createSlackHistoryChunkAdapter({
          conversationId,
          threadTs: otherThread,
          rangeId: later.id,
          knobs: knobs.thread,
        }),
        mode: "backfill",
      },
    );
    const laterOpen = await db
      .selectFrom("conversation_slices")
      .selectAll()
      .where("provider_thread_id", "=", otherThread)
      .where("status", "=", "open")
      .executeTakeFirstOrThrow();

    await insertRow(db, { conversationId, ts: "1788000000.000100", source: "history", rangeId });
    await admit(db);

    expect((await ranges.getById(rangeId))?.graph_completed_at).not.toBeNull();
    const stillOpen = await db
      .selectFrom("conversation_slices")
      .selectAll()
      .where("id", "=", laterOpen.id)
      .executeTakeFirstOrThrow();
    expect(stillOpen.status).toEqual("open");
  });

  /**
   * The canvas-ai outage: 12,678 facts parked awaiting human review or a second
   * sighting sat above the 5,000 open-fact ceiling, so a fully fetched year of
   * Slack history was never admitted at all — not slowly, never.
   */
  it("admits history when every open fact is parked well past the pressure ceiling", async () => {
    const { conversationId, rangeId } = await seedRange(db);
    await insertRow(db, { conversationId, ts: "1788000000.000100", source: "history", rangeId });
    await db
      .insertInto("connector_configs")
      .values({
        id: "slack-connector",
        connector_type: "slack",
        auth_type: "system",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();
    for (let index = 0; index < 6_000; index += 1) {
      await db
        .insertInto("indexed_file_facts")
        .values({
          id: `parked-${index}`,
          fact_key: `parked-${index}`,
          source: "test",
          fact_type: "test",
          relation: "test",
          raw: "{}",
          connector_config_id: "slack-connector",
          materialization_deferred_at: "2026-07-01T00:00:00.000Z",
        })
        .execute();
    }

    const summary = await admit(db);

    expect(summary.skippedForPressure).toBe(false);
    expect(summary.messagesRead).toEqual(1);
    expect(summary.rangesCompleted).toEqual(1);
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
