import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationSliceRow } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import {
  type ChunkCursorState,
  type ChunkEngineMessage,
  type ChunkStreamAdapter,
  createStreamChunkCursorStore,
  runChunkingPass,
} from "./chunk-engine";
import { runLlmChunkingPass } from "./whatsapp-llm-chunker";

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
};

function makeMessages(count: number, text = "four words"): ChunkEngineMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    providerMessageId: `m-${index + 1}`,
    effectiveAt: new Date(Date.parse("2026-07-07T09:00:00.000Z") + index * 60_000).toISOString(),
    receivedAt: new Date(Date.parse("2026-07-07T09:00:00.000Z") + index * 60_000).toISOString(),
    text,
    attachments: null,
    isBot: false,
  }));
}

function fakeAdapter(messages: ChunkEngineMessage[], overrides: Partial<ChunkStreamAdapter> = {}): ChunkStreamAdapter {
  let cursor: ChunkCursorState = { lastEffectiveAt: null, lastMessageId: null, claimToken: null };
  return {
    conversationId: 1,
    streamKey: null,
    providerThreadId: null,
    cursor: {
      claim: async (_db, input) => {
        if (cursor.claimToken) return false;
        cursor = { ...cursor, claimToken: input.claimToken };
        return true;
      },
      get: async () => cursor,
      advance: async (_db, input) => {
        if (cursor.claimToken !== input.claimToken) return undefined;
        cursor = {
          lastEffectiveAt: input.message.effectiveAt,
          lastMessageId: input.message.id,
          claimToken: input.claimToken,
        };
        return cursor;
      },
      renew: async (_db, input) => cursor.claimToken === input.claimToken,
      release: async (_db, input) => {
        if (cursor.claimToken !== input.claimToken) return false;
        cursor = { ...cursor, claimToken: null };
        return true;
      },
      isAfterCursor: (message, current) =>
        current.lastEffectiveAt === null ||
        message.effectiveAt > current.lastEffectiveAt ||
        (message.effectiveAt === current.lastEffectiveAt && message.id > (current.lastMessageId ?? 0)),
      matches: (left, right) =>
        left.lastEffectiveAt === right.lastEffectiveAt && left.lastMessageId === right.lastMessageId,
    },
    loadOpenAndPending: async (_db, open) => {
      const openIds = new Set<number>(open?.denoised_message_ids ? JSON.parse(open.denoised_message_ids) : []);
      return {
        openRaw: messages.filter((message) => openIds.has(message.id)),
        pendingRaw: messages.filter((message) =>
          cursor.lastEffectiveAt === null
            ? true
            : message.effectiveAt > cursor.lastEffectiveAt ||
              (message.effectiveAt === cursor.lastEffectiveAt && message.id > (cursor.lastMessageId ?? 0)),
        ),
        pageFull: false,
      };
    },
    tailMessage: async (_db, messageId) => messages.find((message) => message.id === messageId),
    isIndexable: () => true,
    senderLabel: () => "Asha",
    order: "effective_time",
    boundaries: "single-segment",
    promptHeader: "You are the conversation boundary engine.",
    generateLabel: (kind) => (kind === "repair" ? "chunkBoundaryRepair" : "chunkBoundary"),
    flushReason: () => "llm_boundary",
    rosterSnapshot: async () => "[]",
    usesTopicRegistry: false,
    knobs,
    ...overrides,
  };
}

describe("chunk engine adapter contract", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await createConversationRepository(db).getOrCreate({
      platform: "slack",
      kind: "channel",
      providerConversationId: "C123",
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("uses one 1-based segment without calling the generator or topic registry", async () => {
    let generateCalls = 0;
    const adapter = fakeAdapter(makeMessages(3));

    const result = await runChunkingPass(
      {
        db,
        logger: createTestLogger(),
        generate: async () => {
          generateCalls += 1;
          return "unreachable";
        },
      },
      { adapter, mode: "live", maxWindows: 1 },
    );
    const slice = await db.selectFrom("conversation_slices").selectAll().executeTakeFirstOrThrow();
    const topics = await db.selectFrom("conversation_topics").select("id").execute();

    expect(result.windowsProcessed).toBe(1);
    expect(slice.denoised_message_ids).toBe("[1,2,3]");
    expect(generateCalls).toBe(0);
    expect(topics).toEqual([]);
  });

  it("force-splits a single segment at both message and token hard caps", async () => {
    const byMessages = fakeAdapter(makeMessages(5), { knobs: { ...knobs, maxMessages: 2 } });
    await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      { adapter: byMessages, mode: "live", maxWindows: 1 },
    );
    const messageSlices = await db
      .selectFrom("conversation_slices")
      .select(["first_message_id", "last_message_id"])
      .orderBy("first_message_id")
      .execute();
    expect(messageSlices).toEqual([
      { first_message_id: 1, last_message_id: 2 },
      { first_message_id: 3, last_message_id: 4 },
      { first_message_id: 5, last_message_id: 5 },
    ]);

    await db.deleteFrom("conversation_slices").execute();
    const byTokens = fakeAdapter(makeMessages(3, "one two three four"), {
      knobs: { ...knobs, maxTokens: 5 },
    });
    await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      { adapter: byTokens, mode: "live", maxWindows: 1 },
    );
    const tokenSlices = await db
      .selectFrom("conversation_slices")
      .select(["first_message_id", "last_message_id"])
      .orderBy("first_message_id")
      .execute();
    expect(tokenSlices).toEqual([
      { first_message_id: 1, last_message_id: 1 },
      { first_message_id: 2, last_message_id: 2 },
      { first_message_id: 3, last_message_id: 3 },
    ]);
  });

  it("bisects only the new suffix after repeated LLM validation failure", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const adapter = fakeAdapter(makeMessages(8), { boundaries: "llm", usesTopicRegistry: true });

    await runChunkingPass(
      {
        db,
        logger: createTestLogger(),
        generate: async () => JSON.stringify({ segments: [{ start: 1, end: 2, threads: ["thread"] }] }),
      },
      { adapter, mode: "live", maxWindows: 1, pendingMessageIds: [1, 2] },
    );

    const result = await runChunkingPass(
      {
        db,
        logger: createTestLogger(),
        generate: async (prompt) => {
          prompts.push(prompt);
          calls += 1;
          if (calls <= 2) return "not json";
          return JSON.stringify({ segments: [{ start: 1, end: calls === 3 ? 5 : 8, threads: ["thread"] }] });
        },
      },
      { adapter, mode: "live", maxWindows: 2, pendingMessageIds: [3, 4, 5, 6, 7, 8] },
    );

    expect(result.windowsProcessed).toBe(2);
    expect(prompts[0]?.match(/\[OPEN CHUNK\]/gu)).toHaveLength(2);
    expect(prompts[0]?.match(/\[NEW\]/gu)).toHaveLength(6);
    expect(prompts[2]?.match(/\[OPEN CHUNK\]/gu)).toHaveLength(2);
    expect(prompts[2]?.match(/\[NEW\]/gu)).toHaveLength(3);
    expect(prompts[3]?.match(/\[OPEN CHUNK\]/gu)).toHaveLength(5);
    expect(prompts[3]?.match(/\[NEW\]/gu)).toHaveLength(3);
    expect(prompts[3]?.match(/^\d+\. /gmu)).toHaveLength(8);
  });

  it("uses the force-split reason for an existing open slice and inserted closed slices", async () => {
    const adapter = fakeAdapter(makeMessages(6), {
      knobs: { ...knobs, windowMessages: 5, maxMessages: 2 },
      flushReason: (kind) => (kind === "force_split" ? "max_size" : "llm_boundary"),
    });

    await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      { adapter, mode: "live", maxWindows: 1, pendingMessageIds: [1] },
    );
    const previousOpen = await db.selectFrom("conversation_slices").select("id").executeTakeFirstOrThrow();

    await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      { adapter, mode: "live", maxWindows: 1, pendingMessageIds: [2, 3, 4, 5, 6] },
    );
    const insertedOpen = await db
      .selectFrom("conversation_slices")
      .select("id")
      .where("status", "=", "open")
      .executeTakeFirstOrThrow();
    const growResult = await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      { adapter, mode: "live", maxWindows: 1, pendingMessageIds: [6] },
    );
    const slices = await db
      .selectFrom("conversation_slices")
      .select(["id", "first_message_id", "last_message_id", "flush_reason", "status"])
      .orderBy("first_message_id")
      .execute();

    expect(growResult.openSliceId).toBe(insertedOpen.id);
    expect(slices).toEqual([
      {
        id: previousOpen.id,
        first_message_id: 1,
        last_message_id: 2,
        flush_reason: "max_size",
        status: "closed",
      },
      {
        id: expect.any(String),
        first_message_id: 3,
        last_message_id: 4,
        flush_reason: "max_size",
        status: "closed",
      },
      {
        id: insertedOpen.id,
        first_message_id: 5,
        last_message_id: 6,
        flush_reason: "llm_boundary",
        status: "open",
      },
    ]);
  });

  it("persists the adapter flush reason and requests a roster snapshot for each window", async () => {
    let rosterCalls = 0;
    const adapter = fakeAdapter(makeMessages(4), {
      boundaries: "llm",
      usesTopicRegistry: true,
      flushReason: (kind) => (kind === "boundary" ? "max_age" : "gap"),
      rosterSnapshot: async (_db: Kysely<DB>) => {
        rosterCalls += 1;
        return JSON.stringify({ window: rosterCalls });
      },
    });

    await runChunkingPass(
      {
        db,
        logger: createTestLogger(),
        generate: async () =>
          JSON.stringify({
            segments: [
              { start: 1, end: 2, threads: ["one"] },
              { start: 3, end: 4, threads: ["two"] },
            ],
          }),
      },
      { adapter, mode: "live", maxWindows: 1 },
    );
    const closed = await db
      .selectFrom("conversation_slices")
      .select(["flush_reason", "roster_snapshot"])
      .where("status", "=", "closed")
      .executeTakeFirstOrThrow();

    expect(closed).toEqual({ flush_reason: "max_age", roster_snapshot: '{"window":1}' });
    expect(rosterCalls).toBe(1);
  });

  it("writes the WhatsApp roster snapshot produced for the window", async () => {
    const groupJid = "roster@g.us";
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const groupRepo = createWhatsAppGroupRepository(db);
    await groupRepo.upsert({
      jid: groupJid,
      name: "Roster group",
      description: null,
      tool_progress: null,
      agent_user_id: null,
      updated_at: "2026-07-07T09:00:00.000Z",
    });
    await groupRepo.refreshParticipants(
      groupJid,
      [{ participantJid: "919999999999@s.whatsapp.net", phoneE164: "+919999999999" }],
      "2026-07-07T09:00:00.000Z",
    );
    await createConversationRepository(db).insertMessage({
      conversationId: conversation.id,
      providerMessageId: "wa-1",
      senderJid: "919999999999@s.whatsapp.net",
      senderName: "Asha",
      text: "roadmap update",
      receivedAt: "2026-07-07T09:00:00.000Z",
    });

    await runLlmChunkingPass(
      {
        db,
        logger: createTestLogger(),
        generate: async () => JSON.stringify({ segments: [{ start: 1, end: 1, threads: ["roadmap"] }] }),
      },
      { conversationId: conversation.id, groupJid, knobs, mode: "live", maxWindows: 1 },
    );
    const slice = await db
      .selectFrom("conversation_slices")
      .select("roster_snapshot")
      .where("conversation_id", "=", conversation.id)
      .executeTakeFirstOrThrow();
    const snapshot = JSON.parse(slice.roster_snapshot) as { participants: Array<{ displayName: string }> };

    expect(snapshot.participants).toHaveLength(1);
    expect(snapshot.participants[0]?.displayName).toBe("Asha");
  });

  it("renews Slack stream cursor claims only for the active token", async () => {
    const store = createStreamChunkCursorStore(1, "channel");
    const claimed = await store.claim(db, {
      claimToken: "active",
      now: "2026-07-07T09:00:00.000Z",
      staleBefore: "2026-07-07T08:30:00.000Z",
    });

    expect(claimed).toBe(true);
    await expect(store.renew(db, { claimToken: "stale", now: "2026-07-07T09:01:00.000Z" })).resolves.toBe(false);
    await expect(store.renew(db, { claimToken: "active", now: "2026-07-07T09:02:00.000Z" })).resolves.toBe(true);
    await expect(
      store.advance(db, { claimToken: "active", message: makeMessages(1)[0] as ChunkEngineMessage }),
    ).resolves.toMatchObject({ lastMessageId: 1, claimToken: "active" });
  });
});
