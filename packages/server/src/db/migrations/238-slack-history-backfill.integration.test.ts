import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import { createMigrator } from "../migrate";
import type { DB } from "../schema";

const PRE_MIGRATION = "237-crm-record-fields";
const MIGRATION = "238-slack-history-backfill";

async function migrateTo(db: Kysely<DB>, migration: string): Promise<void> {
  const result = await createMigrator(db).migrateTo(migration);
  expect(result.error).toBeUndefined();
}

function slice(id: string, conversationId: number, firstMessageId: number, origin: "live" | "history") {
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
    status: "open",
    origin,
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

    it("keys the open-slice index by origin and creates the Slack backfill tables", async () => {
      await migrateTo(db, MIGRATION);
      const conversation = await db
        .insertInto("conversations")
        .values({ platform: "slack", kind: "channel", provider_conversation_id: "C238" })
        .returning("id")
        .executeTakeFirstOrThrow();

      await db
        .insertInto("conversation_slices")
        .values([slice("live-open", conversation.id, 1, "live"), slice("history-open", conversation.id, 2, "history")])
        .execute();
      await expect(
        db
          .insertInto("conversation_slices")
          .values(slice("live-open-two", conversation.id, 3, "live"))
          .execute(),
      ).rejects.toThrow();

      await db
        .insertInto("slack_backfill_ranges")
        .values({
          id: "range-238",
          channel_id: "C238",
          conversation_id: conversation.id,
          kind: "initial",
          range_key: "initial",
          lower_ts: "1690000000.000000",
          upper_ts: "1700000000.000000",
        })
        .execute();
      await expect(
        db
          .insertInto("slack_backfill_ranges")
          .values({
            id: "range-238-dup",
            channel_id: "C238",
            conversation_id: conversation.id,
            kind: "gap",
            range_key: "initial",
            lower_ts: "1690000000.000000",
            upper_ts: "1700000000.000000",
          })
          .execute(),
      ).rejects.toThrow();
      await expect(
        db
          .insertInto("slack_backfill_ranges")
          .values({
            id: "range-238-bad",
            channel_id: "C239",
            conversation_id: conversation.id,
            kind: "unknown",
            range_key: "initial",
            lower_ts: "1690000000.000000",
            upper_ts: "1700000000.000000",
          })
          .execute(),
      ).rejects.toThrow();

      await db
        .insertInto("slack_backfill_threads")
        .values({ id: "thread-238", range_id: "range-238", thread_ts: "1699000000.000100" })
        .execute();
      await expect(
        db
          .insertInto("slack_backfill_threads")
          .values({ id: "thread-238-dup", range_id: "range-238", thread_ts: "1699000000.000100" })
          .execute(),
      ).rejects.toThrow();

      await db
        .insertInto("conversation_slice_stream_cursors")
        .values({
          conversation_id: conversation.id,
          stream_key: "channel::history",
          last_effective_at: "2026-09-01T00:00:00.000Z",
        })
        .execute();

      await migrateTo(db, PRE_MIGRATION);
      const remaining = await db
        .selectFrom("conversation_slices")
        .select("id")
        .where("conversation_id", "=", conversation.id)
        .execute();
      expect(remaining.map((row) => row.id)).toEqual(["live-open"]);
    });
  });
}

runSuite("238 Slack history backfill migration SQLite", createTestDb);
runSuite("238 Slack history backfill migration Postgres", createTestPgDb);
