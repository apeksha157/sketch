import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import {
  type ChunkEngineMessage,
  type ChunkStreamAdapter,
  createStreamChunkCursorStore,
  runChunkingPass,
} from "./chunk-engine";
import { createWhatsAppChunkStreamAdapter } from "./whatsapp-llm-chunker";

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

describe("chunk engine on Postgres", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  }, 30_000);

  afterEach(async () => {
    await db.destroy();
  });

  it("applies a WhatsApp window when roster alias enrichment fails", async () => {
    const now = "2026-07-07T09:00:00.000Z";
    const groupJid = `${randomUUID()}@g.us`;
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "whatsapp",
      kind: "group",
      providerConversationId: groupJid,
    });
    const message = await createConversationRepository(db).insertMessage({
      conversationId: conversation.id,
      providerMessageId: randomUUID(),
      senderName: "Asha",
      text: "roadmap update",
      receivedAt: now,
    });
    const deps = {
      db,
      logger: createTestLogger(),
      generate: async () => JSON.stringify({ segments: [{ start: 1, end: 1, threads: ["roadmap"] }] }),
    };
    const adapter = createWhatsAppChunkStreamAdapter(deps, { conversationId: conversation.id, groupJid, knobs });
    let rosterDb: Kysely<DB> | undefined;
    adapter.rosterSnapshot = async (snapshotDb) => {
      rosterDb = snapshotDb;
      await sql`SELECT * FROM table_that_does_not_exist`.execute(snapshotDb).catch(() => undefined);
      return "[]";
    };

    const result = await runChunkingPass(deps, { adapter, mode: "live", maxWindows: 1 });
    const slice = await db
      .selectFrom("conversation_slices")
      .select(["conversation_id", "status"])
      .where("conversation_id", "=", conversation.id)
      .executeTakeFirstOrThrow();
    const cursor = await adapter.cursor.get(db);

    expect(result).toMatchObject({ windowsProcessed: 1, openSliceId: expect.any(String) });
    expect(rosterDb).toBe(db);
    expect(slice).toEqual({ conversation_id: conversation.id, status: "open" });
    expect(cursor).toMatchObject({ lastEffectiveAt: now, lastMessageId: message.row.id });
  });

  it("repairs an orphaned open slice for a non-null stream", async () => {
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "slack",
      kind: "channel",
      providerConversationId: randomUUID(),
    });
    const providerThreadId = "1710000000.000100";
    const rowMessages: ChunkEngineMessage[] = [100, 149, 201].map((id, index) => ({
      id,
      providerMessageId: `row-${id}`,
      effectiveAt: new Date(Date.parse("2026-07-07T09:00:00.000Z") + index * 60_000).toISOString(),
      receivedAt: new Date(Date.parse("2026-07-07T09:00:00.000Z") + index * 60_000).toISOString(),
      text: "roadmap update",
      attachments: null,
      isBot: false,
    }));
    const slices = createConversationSlicesRepository(db);
    await slices.insertIfAbsent({
      id: randomUUID(),
      conversationId: conversation.id,
      firstMessageId: 100,
      lastMessageId: 149,
      startedAt: rowMessages[0]?.effectiveAt ?? "",
      endedAt: rowMessages[1]?.effectiveAt ?? "",
      messageCount: 2,
      denoisedMessageIds: [100, 149],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      providerThreadId,
      status: "open",
    });
    await slices.insertIfAbsent({
      id: randomUUID(),
      conversationId: conversation.id,
      firstMessageId: 150,
      lastMessageId: 200,
      startedAt: rowMessages[1]?.effectiveAt ?? "",
      endedAt: rowMessages[1]?.effectiveAt ?? "",
      messageCount: 51,
      denoisedMessageIds: [150, 200],
      flushReason: "llm_boundary",
      rosterSnapshot: "[]",
      salienceVerdict: "kept",
      providerThreadId,
      status: "closed",
    });
    await db
      .insertInto("conversation_slice_stream_cursors")
      .values({
        conversation_id: conversation.id,
        stream_key: providerThreadId,
        last_message_id: 200,
        updated_at: "2026-07-07T09:00:00.000Z",
      })
      .execute();
    const cursor = createStreamChunkCursorStore(conversation.id, providerThreadId);
    const adapter: ChunkStreamAdapter = {
      conversationId: conversation.id,
      streamKey: providerThreadId,
      providerThreadId,
      cursor,
      loadOpenAndPending: async (_db, open, state) => ({
        openRaw: open ? rowMessages.filter((message) => message.id <= 149) : [],
        pendingRaw: rowMessages.filter((message) => message.id > (state.lastMessageId ?? 0)),
        pageFull: false,
      }),
      nextPendingMessage: async (_db, state) => rowMessages.find((message) => message.id > (state.lastMessageId ?? 0)),
      tailMessage: async (_db, messageId) => rowMessages.find((message) => message.id === messageId),
      isIndexable: () => true,
      senderLabel: () => "Asha",
      order: "row_id",
      boundaries: "single-segment",
      promptHeader: "unreachable",
      generateLabel: () => "unreachable",
      flushReason: (kind) => (kind === "idle" ? "gap" : "llm_boundary"),
      rosterSnapshot: async () => "[]",
      usesTopicRegistry: false,
      knobs,
    };

    const result = await runChunkingPass(
      { db, logger: createTestLogger(), generate: async () => "unreachable" },
      { adapter, mode: "live", maxWindows: 1 },
    );
    const repaired = await db
      .selectFrom("conversation_slices")
      .select(["status", "flush_reason"])
      .where("conversation_id", "=", conversation.id)
      .where("provider_thread_id", "=", providerThreadId)
      .where("first_message_id", "=", 100)
      .executeTakeFirstOrThrow();

    expect(result.windowsProcessed).toBe(1);
    expect(repaired).toEqual({ status: "closed", flush_reason: "gap" });
  });
});
