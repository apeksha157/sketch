import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import { createMigrator } from "../migrate";
import type { DB } from "../schema";
import { up } from "./229-slack-chunk-engine-streams";

const PRE_MIGRATION = "225-indexed-file-raw-contents";

async function migrateTo(db: Kysely<DB>, migration: string): Promise<void> {
  const result = await createMigrator(db).migrateTo(migration);
  expect(result.error).toBeUndefined();
}

async function seedConversation(db: Kysely<DB>, platform: "slack" | "whatsapp", providerId: string): Promise<number> {
  const row = await db
    .insertInto("conversations")
    .values({
      platform,
      kind: platform === "slack" ? "channel" : "group",
      provider_conversation_id: providerId,
      display_name: providerId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

function slice(id: string, conversationId: number, firstMessageId: number, status: "open" | "closed") {
  return {
    id,
    conversation_id: conversationId,
    first_message_id: firstMessageId,
    last_message_id: firstMessageId,
    started_at: "2026-09-01T00:00:00.000Z",
    ended_at: "2026-09-01T00:00:00.000Z",
    message_count: 1,
    denoised_message_ids: `[${firstMessageId}]`,
    flush_reason: "gap",
    roster_snapshot: "[]",
    salience_verdict: null,
    salience_signals: null,
    salience_claim_token: null,
    salience_claimed_at: null,
    indexed_file_id: null,
    provider_thread_id: null,
    status,
    facts_enriched_content_hash: null,
  };
}

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>): void {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      await migrateTo(db, PRE_MIGRATION);
    }, 30_000);

    afterEach(async () => {
      await db.destroy();
    });

    it("migrates stream state, permits one open slice per Slack stream, and rolls back safely", async () => {
      const slackId = await seedConversation(db, "slack", "C228");
      const whatsappId = await seedConversation(db, "whatsapp", "228@g.us");
      await db
        .insertInto("conversation_slices")
        .values([
          slice("slack-channel", slackId, 1, "open"),
          slice("slack-legacy", slackId, 2, "closed"),
          { ...slice("slack-dropped", slackId, 3, "closed"), salience_verdict: "dropped" },
          slice("whatsapp-open", whatsappId, 4, "open"),
          slice("whatsapp-null", whatsappId, 5, "closed"),
        ])
        .execute();
      await db
        .insertInto("conversation_slice_stream_cursors")
        .values([
          { conversation_id: slackId, stream_key: "channel" },
          { conversation_id: slackId, stream_key: "1710000000.000001" },
          { conversation_id: slackId, stream_key: "::router" },
        ])
        .execute();

      await migrateTo(db, "229-slack-chunk-engine-streams");

      const legacy = await db
        .selectFrom("conversation_slices")
        .select(["id", "salience_verdict", "legacy_unjudged_at"])
        .where("id", "in", ["slack-legacy", "slack-dropped", "whatsapp-null"])
        .orderBy("id")
        .execute();
      expect(legacy).toEqual([
        { id: "slack-dropped", salience_verdict: "dropped", legacy_unjudged_at: null },
        { id: "slack-legacy", salience_verdict: "kept", legacy_unjudged_at: expect.anything() },
        { id: "whatsapp-null", salience_verdict: null, legacy_unjudged_at: null },
      ]);
      const cursors = await db
        .selectFrom("conversation_slice_stream_cursors")
        .select(["stream_key", "pending_since", "llm_last_attempt_at"])
        .orderBy("stream_key")
        .execute();
      expect(cursors).toEqual([
        { stream_key: "1710000000.000001", pending_since: expect.anything(), llm_last_attempt_at: null },
        { stream_key: "::router", pending_since: null, llm_last_attempt_at: null },
        { stream_key: "channel", pending_since: expect.anything(), llm_last_attempt_at: null },
      ]);

      await db
        .insertInto("conversation_slices")
        .values({ ...slice("slack-thread-one", slackId, 10, "open"), provider_thread_id: "1710000000.000001" })
        .execute();
      await db
        .insertInto("conversation_slices")
        .values({ ...slice("slack-thread-two", slackId, 11, "open"), provider_thread_id: "1710000000.000002" })
        .execute();
      await expect(
        db
          .insertInto("conversation_slices")
          .values(slice("slack-channel-two", slackId, 12, "open"))
          .execute(),
      ).rejects.toThrow();

      await migrateTo(db, PRE_MIGRATION);

      const opens = await db
        .selectFrom("conversation_slices")
        .select(["id", "status", "flush_reason"])
        .where("id", "in", ["slack-channel", "slack-thread-one", "slack-thread-two", "whatsapp-open"])
        .orderBy("id")
        .execute();
      expect(opens).toEqual([
        { id: "slack-channel", status: "closed", flush_reason: "gap" },
        { id: "slack-thread-one", status: "closed", flush_reason: "gap" },
        { id: "slack-thread-two", status: "closed", flush_reason: "gap" },
        { id: "whatsapp-open", status: "open", flush_reason: "gap" },
      ]);
    });
  });
}

runSuite("228 Slack chunk engine streams migration SQLite", createTestDb);
runSuite("228 Slack chunk engine streams migration Postgres", createTestPgDb);

describe("228 Slack chunk engine streams migration retry safety", () => {
  it("runs up twice on SQLite", async () => {
    const db = await createTestDb();
    try {
      await up(db as unknown as Kysely<unknown>);
      await up(db as unknown as Kysely<unknown>);
    } finally {
      await db.destroy();
    }
  });
});
