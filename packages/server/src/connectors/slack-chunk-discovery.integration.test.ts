import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import { createTestDb, createTestPgDb } from "../test-utils";
import { discoverSlackChunkStreams } from "./slack-chunk-discovery";

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>): void {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
    }, 30_000);

    afterEach(async () => {
      await db.destroy();
    });

    async function conversation(providerId: string): Promise<number> {
      const row = await createConversationRepository(db).getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: providerId,
      });
      return row.id;
    }

    async function message(conversationId: number, providerId: string, threadTs?: string): Promise<number> {
      const inserted = await createConversationRepository(db).insertMessage({
        conversationId,
        providerMessageId: providerId,
        senderJid: "U1",
        senderName: "Asha",
        text: providerId,
        providerThreadId: threadTs ?? providerId,
        providerParentMessageId: threadTs ?? null,
        isThreadReply: threadTs !== undefined,
        providerTimestamp: "2026-09-05T00:00:00.000Z",
        receivedAt: "2026-09-05T00:00:00.000Z",
      });
      return inserted.row.id;
    }

    it("folds top-level provider thread ids into one channel stream and creates a missing router", async () => {
      const conversationId = await conversation("C-fold");
      const first = await message(conversationId, "100.1");
      const second = await message(conversationId, "100.2");
      await message(conversationId, "100.3", "100.1");

      const result = await discoverSlackChunkStreams({
        db,
        now: new Date("2026-09-05T01:00:00.000Z"),
        pageRows: 100,
        maxPages: 10,
      });

      const rows = await db
        .selectFrom("conversation_slice_stream_cursors")
        .select(["stream_key", "last_message_id", "pending_since"])
        .where("conversation_id", "=", conversationId)
        .orderBy("stream_key")
        .execute();
      expect(result.pages).toBe(1);
      expect(rows).toEqual([
        { stream_key: "100.1", last_message_id: null, pending_since: "2026-09-05T01:00:00.000Z" },
        { stream_key: "::router", last_message_id: Math.max(first, second) + 1, pending_since: null },
        { stream_key: "channel", last_message_id: null, pending_since: "2026-09-05T01:00:00.000Z" },
      ]);
    });

    it("pages per conversation, replays after a page crash, and discovers a late row below the old bound", async () => {
      const firstConversation = await conversation("C-first");
      const secondConversation = await conversation("C-second");
      const firstId = await message(firstConversation, "first-1");
      const secondId = await message(secondConversation, "second-1");
      const laterFirstId = await message(firstConversation, "first-2");

      const firstRun = await discoverSlackChunkStreams({
        db,
        now: new Date("2026-09-05T01:00:00.000Z"),
        pageRows: 1,
        maxPages: 1,
      });
      const firstRouters = await db
        .selectFrom("conversation_slice_stream_cursors")
        .select(["conversation_id", "last_message_id"])
        .where("stream_key", "=", "::router")
        .orderBy("conversation_id")
        .execute();
      expect(firstRun.pages).toBe(1);
      expect(firstRouters).toEqual([
        { conversation_id: firstConversation, last_message_id: firstId },
        { conversation_id: secondConversation, last_message_id: secondId },
      ]);

      await discoverSlackChunkStreams({
        db,
        now: new Date("2026-09-05T01:01:00.000Z"),
        pageRows: 1,
        maxPages: 10,
      });
      const advanced = await db
        .selectFrom("conversation_slice_stream_cursors")
        .select("last_message_id")
        .where("conversation_id", "=", firstConversation)
        .where("stream_key", "=", "::router")
        .executeTakeFirstOrThrow();
      expect(advanced.last_message_id).toBe(laterFirstId);

      const lateId = await message(firstConversation, "first-late");
      expect(lateId).toBeLessThan(laterFirstId + 100);
      await discoverSlackChunkStreams({
        db,
        now: new Date("2026-09-05T01:02:00.000Z"),
        pageRows: 100,
        maxPages: 10,
      });
      const lateRouter = await db
        .selectFrom("conversation_slice_stream_cursors")
        .select("last_message_id")
        .where("conversation_id", "=", firstConversation)
        .where("stream_key", "=", "::router")
        .executeTakeFirstOrThrow();
      const channelRows = await db
        .selectFrom("conversation_slice_stream_cursors")
        .select("stream_key")
        .where("conversation_id", "=", firstConversation)
        .where("stream_key", "=", "channel")
        .execute();
      expect(lateRouter.last_message_id).toBe(lateId);
      expect(channelRows).toHaveLength(1);
    });
  });
}

runSuite("Slack chunk discovery SQLite", createTestDb);
runSuite("Slack chunk discovery Postgres", createTestPgDb);
