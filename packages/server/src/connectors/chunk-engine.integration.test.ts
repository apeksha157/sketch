import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import { runChunkingPass } from "./chunk-engine";
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
});
