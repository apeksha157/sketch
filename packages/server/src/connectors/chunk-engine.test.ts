import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import type { ConversationSliceRow } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import { createUserRepository } from "../db/repositories/users";
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
import { chunkWhatsAppIndexingGroups } from "./whatsapp-chunker";
import { createWhatsAppChunkStreamAdapter, evaluateIdleClose, runLlmChunkingPass } from "./whatsapp-llm-chunker";

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

async function insertMessagesBatched(
  db: Kysely<DB>,
  rows: Array<{
    conversationId: number;
    providerMessageId: string;
    senderName?: string;
    isBot?: boolean;
    text: string;
    receivedAt: string;
  }>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 500) {
    await db
      .insertInto("conversation_messages")
      .values(
        rows.slice(offset, offset + 500).map((row) => ({
          conversation_id: row.conversationId,
          provider_message_id: row.providerMessageId,
          event_key: null,
          sender_name: row.senderName ?? "Asha",
          sender_user_id: null,
          is_bot: row.isBot ? 1 : 0,
          text: row.text,
          attachments: null,
          provider_thread_id: null,
          provider_parent_message_id: null,
          provider_timestamp: null,
          received_at: row.receivedAt,
          source: "live",
          effective_at: row.receivedAt,
        })),
      )
      .execute();
  }
}

async function seedIndexedFile(db: Kysely<DB>, fileId: string, sliceId: string): Promise<void> {
  await createUserRepository(db).create({ id: "chunk-owner", name: "Chunk Owner", email: "chunk@example.com" });
  const config = await createConnectorRepository(db).createConfig({
    connectorType: "whatsapp",
    authType: "system",
    credentials: JSON.stringify({ type: "system" }),
    scopeConfig: "{}",
    createdBy: "chunk-owner",
  });
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: config.id,
      provider_file_id: sliceId,
      file_name: fileId,
      file_type: "whatsapp_conversation_slice",
      content_category: "document",
      source: "whatsapp",
      synced_at: "2026-07-07T09:00:00.000Z",
    })
    .execute();
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
    nextPendingMessage: async () =>
      messages.find((message) => cursor.lastMessageId === null || message.id > cursor.lastMessageId),
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

  it("keeps pending work marked when the cursor claim is unavailable", async () => {
    const adapter = fakeAdapter(makeMessages(1));
    adapter.cursor.claim = async () => false;

    const result = await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      { adapter, mode: "live" },
    );

    expect(result).toMatchObject({ pendingRemaining: true, skippedReason: "claim_unavailable" });
  });

  it("keeps pending work marked after boundary validation fails", async () => {
    const result = await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "not json" },
      { adapter: fakeAdapter(makeMessages(2), { boundaries: "llm" }), mode: "live" },
    );

    expect(result).toMatchObject({ pendingRemaining: true, skippedReason: "boundary_validation_failed" });
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
      {
        adapter,
        mode: "live",
        maxWindows: 1,
        pendingUntil: { effectiveAt: makeMessages(2)[1]?.effectiveAt ?? "", id: 2 },
      },
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
      {
        adapter,
        mode: "live",
        maxWindows: 2,
        pendingUntil: { effectiveAt: makeMessages(8)[7]?.effectiveAt ?? "", id: 8 },
      },
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
      {
        adapter,
        mode: "live",
        maxWindows: 1,
        pendingUntil: { effectiveAt: makeMessages(1)[0]?.effectiveAt ?? "", id: 1 },
      },
    );
    const previousOpen = await db.selectFrom("conversation_slices").select("id").executeTakeFirstOrThrow();

    await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      {
        adapter,
        mode: "live",
        maxWindows: 1,
        pendingUntil: { effectiveAt: makeMessages(6)[5]?.effectiveAt ?? "", id: 6 },
      },
    );
    const insertedOpen = await db
      .selectFrom("conversation_slices")
      .select("id")
      .where("status", "=", "open")
      .executeTakeFirstOrThrow();
    const growResult = await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      {
        adapter,
        mode: "live",
        maxWindows: 1,
        pendingUntil: { effectiveAt: makeMessages(6)[5]?.effectiveAt ?? "", id: 6 },
      },
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

  it("bounds one WhatsApp pass pending read for a 5,000-row conversation", async () => {
    const groupJid = "bounded-read@g.us";
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    await insertMessagesBatched(
      db,
      Array.from({ length: 5_000 }, (_, index) => ({
        conversationId: conversation.id,
        providerMessageId: `bounded-${index}`,
        senderName: "Asha",
        text: "roadmap update",
        receivedAt: new Date(Date.parse("2026-07-07T09:00:00.000Z") + index * 1_000).toISOString(),
      })),
    );
    const deps = { db, logger: createTestLogger(), generate: async () => "unreachable" };
    const adapter = createWhatsAppChunkStreamAdapter(deps, { conversationId: conversation.id, groupJid, knobs });
    const loadOpenAndPending = adapter.loadOpenAndPending;
    const pendingRowsRead: number[] = [];
    adapter.loadOpenAndPending = async (...args) => {
      const loaded = await loadOpenAndPending(...args);
      pendingRowsRead.push(loaded.pendingRaw.length);
      return loaded;
    };
    adapter.boundaries = "single-segment";
    adapter.rosterSnapshot = async () => "[]";

    await runChunkingPass(deps, { adapter, mode: "live", maxWindows: 1 });

    expect(pendingRowsRead).toEqual([knobs.windowMessages + 50]);
  });

  it("scopes the row_id overlap guard to its stream with a null-safe predicate", async () => {
    const messages = makeMessages(3).map((message) => ({ ...message, id: message.id + 99 }));
    const slices = createConversationSlicesRepository(db);
    await slices.insertIfAbsent({
      id: "other-stream",
      conversationId: 1,
      firstMessageId: 101,
      lastMessageId: 103,
      startedAt: messages[1]?.effectiveAt ?? "",
      endedAt: messages[2]?.effectiveAt ?? "",
      messageCount: 2,
      denoisedMessageIds: [101, 103],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      providerThreadId: "stream-b",
      status: "closed",
    });
    await slices.insertIfAbsent({
      id: "null-stream",
      conversationId: 1,
      firstMessageId: 99,
      lastMessageId: 101,
      startedAt: messages[0]?.effectiveAt ?? "",
      endedAt: messages[2]?.effectiveAt ?? "",
      messageCount: 2,
      denoisedMessageIds: [99, 101],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      providerThreadId: null,
      status: "closed",
    });
    const otherStreamResult = await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      {
        adapter: fakeAdapter(messages, { conversationId: 1, providerThreadId: "stream-a", order: "row_id" }),
        mode: "live",
        maxWindows: 1,
      },
    );
    await db.deleteFrom("conversation_slices").where("provider_thread_id", "=", "stream-a").execute();
    await slices.insertIfAbsent({
      id: "same-stream",
      conversationId: 1,
      firstMessageId: 100,
      lastMessageId: 103,
      startedAt: messages[0]?.effectiveAt ?? "",
      endedAt: messages[2]?.effectiveAt ?? "",
      messageCount: 3,
      denoisedMessageIds: [100, 101, 103],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      providerThreadId: "stream-a",
      status: "closed",
    });
    const sameStreamResult = await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      {
        adapter: fakeAdapter(messages, { conversationId: 1, providerThreadId: "stream-a", order: "row_id" }),
        mode: "live",
        maxWindows: 1,
      },
    );
    const nullStreamResult = await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      {
        adapter: fakeAdapter(messages, { conversationId: 1, providerThreadId: null, order: "row_id" }),
        mode: "live",
        maxWindows: 1,
      },
    );

    expect(otherStreamResult.windowsProcessed).toBe(1);
    expect(sameStreamResult.skippedReason).toBe("overlap_guard");
    expect(nullStreamResult).toMatchObject({ pendingRemaining: true, skippedReason: "overlap_guard" });
  });

  it("overrides the tick gate when indexable messages follow a full noise page", async () => {
    const groupJid = "burst-after-noise@g.us";
    const groups = createWhatsAppGroupRepository(db);
    await groups.upsert({
      jid: groupJid,
      name: "Burst After Noise",
      description: null,
      updated_at: "2026-07-07T09:00:00.000Z",
    });
    const group = await groups.setIndexEnabled(groupJid, true, {
      chunkMinMessages: 1,
      chunkWindowMessages: 250,
      chunkBurstThresholdMessages: 250,
    });
    if (!group) throw new Error("Failed to enable burst group");
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    await insertMessagesBatched(
      db,
      Array.from({ length: 550 }, (_, index) => ({
        conversationId: conversation.id,
        providerMessageId: `burst-after-noise-${index}`,
        isBot: index < 300,
        text: index < 300 ? "noise" : "roadmap update",
        receivedAt: new Date(Date.parse("2026-07-07T09:00:00.000Z") + index * 1_000).toISOString(),
      })),
    );
    let generateCalls = 0;

    const result = await chunkWhatsAppIndexingGroups({
      db,
      groups: [{ ...group, chunkLastLlmAttemptAt: "2026-07-07T09:55:00.000Z" }],
      logger: createTestLogger(),
      now: new Date("2026-07-07T10:00:00.000Z"),
      llmGenerate: async (prompt) => {
        generateCalls += 1;
        const count = prompt.match(/^\d+\. /gmu)?.length ?? 0;
        return JSON.stringify({ segments: [{ start: 1, end: count, threads: ["roadmap"] }] });
      },
    });

    expect(generateCalls).toBeGreaterThan(0);
    expect(result.messagesProcessed).toBe(550);
  });

  it("drains a full WhatsApp noise page before slicing indexable rows", async () => {
    const groupJid = "noise-drain@g.us";
    const groups = createWhatsAppGroupRepository(db);
    await groups.upsert({
      jid: groupJid,
      name: "Noise Drain",
      description: null,
      updated_at: "2026-07-07T09:00:00.000Z",
    });
    const group = await groups.setIndexEnabled(groupJid, true, { chunkMinMessages: 1, chunkWindowMessages: 210 });
    if (!group) throw new Error("Failed to enable noise drain group");
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    await insertMessagesBatched(
      db,
      Array.from({ length: 305 }, (_, index) => ({
        conversationId: conversation.id,
        providerMessageId: `noise-drain-${index}`,
        senderName: index < 300 ? "Bot" : "Asha",
        isBot: index < 300,
        text: index < 300 ? "noise" : "roadmap update",
        receivedAt: new Date(Date.parse("2026-07-07T09:00:00.000Z") + index * 1_000).toISOString(),
      })),
    );
    const result = await chunkWhatsAppIndexingGroups({
      db,
      groups: [group],
      logger: createTestLogger(),
      now: new Date("2026-07-07T10:00:00.000Z"),
      llmGenerate: async (prompt) => {
        const count = [...prompt.matchAll(/^\d+\. \[/gmu)].length;
        return JSON.stringify({ segments: [{ start: 1, end: count, threads: ["roadmap"] }] });
      },
    });
    const slice = await db
      .selectFrom("conversation_slices")
      .select(["message_count", "denoised_message_ids"])
      .where("conversation_id", "=", conversation.id)
      .executeTakeFirst();

    expect(result.messagesProcessed).toBe(305);
    expect(slice).toEqual({ message_count: 5, denoised_message_ids: JSON.stringify([301, 302, 303, 304, 305]) });
  });

  it("caps a WhatsApp backlog per run and resumes from the cursor", async () => {
    const groupJid = "run-budget@g.us";
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    await insertMessagesBatched(
      db,
      Array.from({ length: 700 }, (_, index) => ({
        conversationId: conversation.id,
        providerMessageId: `run-budget-${index}`,
        senderName: "Asha",
        text: "roadmap update",
        receivedAt: new Date(Date.parse("2026-07-07T09:00:00.000Z") + index * 1_000).toISOString(),
      })),
    );
    let generateCalls = 0;
    const deps = {
      db,
      logger: createTestLogger(),
      generate: async (prompt: string) => {
        generateCalls += 1;
        const messageCount = prompt.match(/^\d+\. /gmu)?.length ?? 0;
        return JSON.stringify({ segments: [{ start: 1, end: messageCount, threads: ["roadmap"] }] });
      },
    };
    const budgetKnobs = { ...knobs, windowMessages: 250, maxWindowsPerRun: 2 };

    const first = await runLlmChunkingPass(deps, {
      conversationId: conversation.id,
      groupJid,
      knobs: budgetKnobs,
      mode: "live",
    });
    const firstCursor = await createConversationSlicesRepository(db).getCursor(conversation.id);
    const second = await runLlmChunkingPass(deps, {
      conversationId: conversation.id,
      groupJid,
      knobs: budgetKnobs,
      mode: "live",
    });
    const secondCursor = await createConversationSlicesRepository(db).getCursor(conversation.id);

    expect(generateCalls).toBe(3);
    expect(first).toMatchObject({ windowsProcessed: 2, pendingRemaining: true });
    expect(firstCursor?.last_message_id).toBeLessThan(700);
    expect(second).toMatchObject({ windowsProcessed: 1, pendingRemaining: false });
    expect(secondCursor?.last_message_id).toBe(700);
  });

  it("force-closes an orphaned row_id open slice before planning", async () => {
    const sliceRepo = createConversationSlicesRepository(db);
    const rowMessages = [100, 149, 201].map((id, index) => ({
      ...(makeMessages(3)[index] as ChunkEngineMessage),
      id,
      providerMessageId: `row-${id}`,
    }));
    await sliceRepo.insertIfAbsent({
      id: "orphaned-open",
      conversationId: 1,
      firstMessageId: 100,
      lastMessageId: 149,
      startedAt: rowMessages[0]?.effectiveAt ?? "",
      endedAt: rowMessages[1]?.effectiveAt ?? "",
      messageCount: 2,
      denoisedMessageIds: [100, 149],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      providerThreadId: "stream-a",
      status: "open",
    });
    await sliceRepo.insertIfAbsent({
      id: "later-closed",
      conversationId: 1,
      firstMessageId: 150,
      lastMessageId: 200,
      startedAt: rowMessages[1]?.effectiveAt ?? "",
      endedAt: rowMessages[1]?.effectiveAt ?? "",
      messageCount: 51,
      denoisedMessageIds: [150, 200],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      providerThreadId: "stream-a",
      status: "closed",
    });
    await db
      .insertInto("conversation_slice_stream_cursors")
      .values({
        conversation_id: 1,
        stream_key: "stream-a",
        last_message_id: 200,
        updated_at: "2026-07-07T09:00:00.000Z",
      })
      .execute();
    const adapter = fakeAdapter(rowMessages, {
      providerThreadId: "stream-a",
      streamKey: "stream-a",
      order: "row_id",
      cursor: createStreamChunkCursorStore(1, "stream-a"),
      flushReason: (kind) => (kind === "idle" ? "gap" : "llm_boundary"),
      loadOpenAndPending: async (_db, open, cursor) => ({
        openRaw: open ? rowMessages.filter((message) => message.id <= 149) : [],
        pendingRaw: rowMessages.filter((message) => message.id > (cursor.lastMessageId ?? 0)),
        pageFull: false,
      }),
      nextPendingMessage: async (_db, cursor) =>
        rowMessages.find((message) => message.id > (cursor.lastMessageId ?? 0)),
    });

    const result = await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      { adapter, mode: "live", maxWindows: 1 },
    );
    const repaired = await sliceRepo.getById("orphaned-open");
    const currentOpen = await sliceRepo.getOpenSlice(1, "stream-a");

    expect(result.windowsProcessed).toBe(1);
    expect(repaired).toMatchObject({ status: "closed", flush_reason: "gap", last_message_id: 149 });
    expect(currentOpen).toMatchObject({ first_message_id: 201, last_message_id: 201 });
  });

  it("keeps a WhatsApp live open slice beside a higher-id closed backfill slice", async () => {
    const groupJid = "backfill-coexistence@g.us";
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const messages = createConversationRepository(db);
    const liveStart = await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "live-start",
      senderName: "Asha",
      text: "live start",
      receivedAt: "2026-07-07T09:00:00.000Z",
    });
    const liveEnd = await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "live-end",
      senderName: "Asha",
      text: "live end",
      receivedAt: "2026-07-07T09:01:00.000Z",
    });
    const historyStart = await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "history-start",
      senderName: "Asha",
      text: "history start",
      providerTimestamp: "2026-07-06T09:00:00.000Z",
      receivedAt: "2026-07-07T09:02:00.000Z",
      source: "history",
    });
    const historyEnd = await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "history-end",
      senderName: "Asha",
      text: "history end",
      providerTimestamp: "2026-07-06T09:01:00.000Z",
      receivedAt: "2026-07-07T09:03:00.000Z",
      source: "history",
    });
    const liveNext = await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "live-next",
      senderName: "Asha",
      text: "live next",
      receivedAt: "2026-07-07T09:04:00.000Z",
    });
    const sliceRepo = createConversationSlicesRepository(db);
    await sliceRepo.insertIfAbsent({
      id: "whatsapp-live-open",
      conversationId: conversation.id,
      firstMessageId: liveStart.row.id,
      lastMessageId: liveEnd.row.id,
      startedAt: liveStart.row.effectiveAt,
      endedAt: liveEnd.row.effectiveAt,
      messageCount: 2,
      denoisedMessageIds: [liveStart.row.id, liveEnd.row.id],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      status: "open",
    });
    await sliceRepo.insertIfAbsent({
      id: "whatsapp-backfill-closed",
      conversationId: conversation.id,
      firstMessageId: historyStart.row.id,
      lastMessageId: historyEnd.row.id,
      startedAt: historyStart.row.effectiveAt,
      endedAt: historyEnd.row.effectiveAt,
      messageCount: 2,
      denoisedMessageIds: [historyStart.row.id, historyEnd.row.id],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      status: "closed",
    });
    await sliceRepo.advanceCursor({
      conversationId: conversation.id,
      lastEffectiveAt: liveEnd.row.effectiveAt,
      lastMessageId: liveEnd.row.id,
    });
    const deps = { db, logger: createTestLogger(), generate: async () => "unreachable" };
    const adapter = createWhatsAppChunkStreamAdapter(deps, { conversationId: conversation.id, groupJid, knobs });
    adapter.boundaries = "single-segment";
    adapter.rosterSnapshot = async () => "[]";

    const result = await runChunkingPass(deps, { adapter, mode: "live", maxWindows: 1 });
    const liveOpen = await sliceRepo.getById("whatsapp-live-open");

    expect(result.windowsProcessed).toBe(1);
    expect(liveOpen).toMatchObject({ status: "open", last_message_id: liveNext.row.id });
  });

  it("excludes unadmitted history before the live open slice from live pending rows", async () => {
    const groupJid = "live-source-scope@g.us";
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const messages = createConversationRepository(db);
    const history = await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "unadmitted-history",
      senderName: "Asha",
      text: "old history",
      providerTimestamp: "invalid",
      receivedAt: "2026-07-07T10:00:00.000Z",
      source: "history",
    });
    const liveStart = await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "live-source-start",
      senderName: "Asha",
      text: "live start",
      receivedAt: "2026-07-07T09:00:00.000Z",
    });
    const liveNext = await messages.insertMessage({
      conversationId: conversation.id,
      providerMessageId: "live-source-next",
      senderName: "Asha",
      text: "live next",
      receivedAt: "2026-07-07T09:01:00.000Z",
    });
    const sliceRepo = createConversationSlicesRepository(db);
    await sliceRepo.insertIfAbsent({
      id: "live-source-open",
      conversationId: conversation.id,
      firstMessageId: liveStart.row.id,
      lastMessageId: liveStart.row.id,
      startedAt: liveStart.row.effectiveAt,
      endedAt: liveStart.row.effectiveAt,
      messageCount: 1,
      denoisedMessageIds: [liveStart.row.id],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      status: "open",
    });
    await sliceRepo.advanceCursor({
      conversationId: conversation.id,
      lastEffectiveAt: liveStart.row.effectiveAt,
      lastMessageId: liveStart.row.id,
    });
    const open = await sliceRepo.getOpenSlice(conversation.id);
    const cursor = await sliceRepo.getCursor(conversation.id);
    if (!cursor) throw new Error("Missing live cursor");
    const deps = { db, logger: createTestLogger(), generate: async () => "unreachable" };
    const adapter = createWhatsAppChunkStreamAdapter(deps, { conversationId: conversation.id, groupJid, knobs });

    const loaded = await adapter.loadOpenAndPending(
      db,
      open,
      { lastEffectiveAt: cursor.last_effective_at, lastMessageId: cursor.last_message_id, claimToken: null },
      knobs.windowMessages,
    );

    expect(history.row.id).toBeLessThan(liveStart.row.id);
    expect(loaded.pendingRaw.map((message) => message.id)).toEqual([liveNext.row.id]);
  });

  it("requeues a linked WhatsApp open slice when a boundary revision closes a shorter range", async () => {
    const groupJid = "range-requeue@g.us";
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const messageRows: Array<{ id: number; effectiveAt: string }> = [];
    for (let index = 0; index < 5; index += 1) {
      messageRows.push(
        (
          await createConversationRepository(db).insertMessage({
            conversationId: conversation.id,
            providerMessageId: `range-requeue-${index}`,
            senderName: "Asha",
            text: "roadmap update",
            receivedAt: new Date(Date.parse("2026-07-07T09:00:00.000Z") + index * 60_000).toISOString(),
          })
        ).row,
      );
    }
    const deps = { db, logger: createTestLogger(), generate: async () => "unreachable" };
    await runLlmChunkingPass(
      { ...deps, generate: async () => JSON.stringify({ segments: [{ start: 1, end: 3, threads: ["roadmap"] }] }) },
      {
        conversationId: conversation.id,
        groupJid,
        knobs,
        mode: "live",
        maxWindows: 1,
        pendingUntil: { effectiveAt: messageRows[2]?.effectiveAt ?? "", id: messageRows[2]?.id ?? 0 },
      },
    );
    const sliceRepo = createConversationSlicesRepository(db);
    const originalOpen = await sliceRepo.getOpenSlice(conversation.id);
    await seedIndexedFile(db, "linked-range-file", originalOpen?.id ?? "");
    await db
      .updateTable("conversation_slices")
      .set({ indexed_file_id: "linked-range-file" })
      .where("id", "=", originalOpen?.id ?? "")
      .execute();

    await runLlmChunkingPass(
      {
        ...deps,
        generate: async () =>
          JSON.stringify({
            segments: [
              { start: 1, end: 2, threads: ["roadmap"] },
              { start: 3, end: 5, threads: ["next"] },
            ],
          }),
      },
      { conversationId: conversation.id, groupJid, knobs, mode: "live", maxWindows: 1 },
    );
    const revised = originalOpen ? await sliceRepo.getById(originalOpen.id) : undefined;

    expect(revised).toMatchObject({
      status: "closed",
      denoised_message_ids: JSON.stringify([messageRows[0]?.id, messageRows[1]?.id]),
      indexed_file_id: null,
    });
  });

  it("requeues a linked WhatsApp open slice when a single-segment revision shrinks membership", async () => {
    const groupJid = "single-segment-shrink@g.us";
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const messageRows: Array<{ id: number; effectiveAt: string }> = [];
    for (let index = 0; index < 4; index += 1) {
      messageRows.push(
        (
          await createConversationRepository(db).insertMessage({
            conversationId: conversation.id,
            providerMessageId: `single-segment-shrink-${index}`,
            senderName: "Asha",
            text: "roadmap update",
            receivedAt: new Date(Date.parse("2026-07-07T09:00:00.000Z") + index * 60_000).toISOString(),
          })
        ).row,
      );
    }
    const deps = {
      db,
      logger: createTestLogger(),
      generate: async (prompt: string) => {
        const count = [...prompt.matchAll(/^\d+\. \[/gmu)].length;
        return JSON.stringify({ segments: [{ start: 1, end: count, threads: ["roadmap"] }] });
      },
    };
    await runLlmChunkingPass(deps, {
      conversationId: conversation.id,
      groupJid,
      knobs,
      mode: "live",
      maxWindows: 1,
      pendingUntil: { effectiveAt: messageRows[2]?.effectiveAt ?? "", id: messageRows[2]?.id ?? 0 },
    });
    const sliceRepo = createConversationSlicesRepository(db);
    const originalOpen = await sliceRepo.getOpenSlice(conversation.id);
    await seedIndexedFile(db, "linked-single-segment-file", originalOpen?.id ?? "");
    await db
      .updateTable("conversation_slices")
      .set({ indexed_file_id: "linked-single-segment-file" })
      .where("id", "=", originalOpen?.id ?? "")
      .execute();
    await db
      .updateTable("conversation_messages")
      .set({ is_bot: 1 })
      .where("id", "=", messageRows[2]?.id ?? 0)
      .execute();

    await runLlmChunkingPass(deps, {
      conversationId: conversation.id,
      groupJid,
      knobs,
      mode: "live",
      maxWindows: 1,
    });
    const revised = originalOpen ? await sliceRepo.getById(originalOpen.id) : undefined;

    expect(revised).toMatchObject({
      status: "open",
      denoised_message_ids: JSON.stringify([messageRows[0]?.id, messageRows[1]?.id, messageRows[3]?.id]),
      indexed_file_id: null,
    });
  });

  it("keeps a linked WhatsApp file on an unchanged idle close", async () => {
    const groupJid = "idle-link@g.us";
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    for (let index = 0; index < 2; index += 1) {
      await createConversationRepository(db).insertMessage({
        conversationId: conversation.id,
        providerMessageId: `idle-link-${index}`,
        senderName: "Asha",
        text: "roadmap update",
        receivedAt: new Date(Date.parse("2026-07-01T09:00:00.000Z") + index * 60_000).toISOString(),
      });
    }
    const deps = {
      db,
      logger: createTestLogger(),
      generate: async () => JSON.stringify({ segments: [{ start: 1, end: 2, threads: ["roadmap"] }] }),
    };
    await runLlmChunkingPass(deps, {
      conversationId: conversation.id,
      groupJid,
      knobs,
      mode: "live",
      maxWindows: 1,
    });
    const sliceRepo = createConversationSlicesRepository(db);
    const open = await sliceRepo.getOpenSlice(conversation.id);
    await seedIndexedFile(db, "linked-idle-file", open?.id ?? "");
    await db
      .updateTable("conversation_slices")
      .set({ indexed_file_id: "linked-idle-file" })
      .where("id", "=", open?.id ?? "")
      .execute();

    const closed = await evaluateIdleClose(
      { ...deps, now: () => Date.parse("2026-07-07T09:00:00.000Z") },
      { conversationId: conversation.id, knobs, mode: "live" },
    );
    const idleClosed = open ? await sliceRepo.getById(open.id) : undefined;

    expect(closed).toBe(true);
    expect(idleClosed).toMatchObject({ status: "closed", indexed_file_id: "linked-idle-file" });
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
