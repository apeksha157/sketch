import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger, getSharedPgDb } from "../test-utils";
import { repairSlackChunkStreamsOnStartup } from "./slack-chunk-adapters";

async function seedConversation(db: Kysely<DB>, platform: "slack" | "whatsapp", providerId: string) {
  return db
    .insertInto("conversations")
    .values({
      platform,
      kind: platform === "slack" ? "channel" : "group",
      provider_conversation_id: providerId,
      display_name: providerId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}

function slice(
  id: string,
  conversationId: number,
  firstMessageId: number,
  status: "open" | "closed",
  providerThreadId: string | null,
) {
  return {
    id,
    conversation_id: conversationId,
    first_message_id: firstMessageId,
    last_message_id: firstMessageId,
    started_at: "2026-09-01T00:00:00.000Z",
    ended_at: "2026-09-01T00:00:00.000Z",
    message_count: 1,
    denoised_message_ids: `[${firstMessageId}]`,
    flush_reason: "llm_boundary",
    roster_snapshot: "[]",
    salience_verdict: null,
    salience_signals: null,
    salience_claim_token: null,
    salience_claimed_at: null,
    indexed_file_id: null,
    provider_thread_id: providerThreadId,
    status,
    facts_enriched_content_hash: null,
  };
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

    it("repairs only orphaned Slack streams and flips legacy verdicts idempotently", async () => {
      const slack = await seedConversation(db, "slack", "C-repair");
      const whatsapp = await seedConversation(db, "whatsapp", "repair@g.us");
      await db
        .insertInto("conversation_slices")
        .values([
          slice("slack-open-channel", slack.id, 1, "open", null),
          slice("slack-later-channel", slack.id, 2, "closed", null),
          slice("slack-open-thread", slack.id, 3, "open", "thread-1"),
          { ...slice("whatsapp-open", whatsapp.id, 4, "open", null), salience_verdict: "kept" },
        ])
        .execute();

      const first = await repairSlackChunkStreamsOnStartup(db, createTestLogger());
      const firstRows = await db
        .selectFrom("conversation_slices")
        .select(["id", "status", "flush_reason", "salience_verdict", "legacy_unjudged_at"])
        .where("id", "in", ["slack-open-channel", "slack-later-channel", "slack-open-thread", "whatsapp-open"])
        .orderBy("id")
        .execute();
      const legacyAt = firstRows.find((row) => row.id === "slack-later-channel")?.legacy_unjudged_at;
      expect(first).toEqual({ orphanedOpenSlicesClosed: 1, legacyVerdictsKept: 2 });
      expect(firstRows).toEqual([
        expect.objectContaining({ id: "slack-later-channel", status: "closed", salience_verdict: "kept" }),
        expect.objectContaining({
          id: "slack-open-channel",
          status: "closed",
          flush_reason: "gap",
          salience_verdict: "kept",
        }),
        expect.objectContaining({ id: "slack-open-thread", status: "open", salience_verdict: null }),
        expect.objectContaining({
          id: "whatsapp-open",
          status: "open",
          salience_verdict: "kept",
          legacy_unjudged_at: null,
        }),
      ]);
      expect(legacyAt).toBeTruthy();

      const second = await repairSlackChunkStreamsOnStartup(db, createTestLogger());
      const unchanged = await db
        .selectFrom("conversation_slices")
        .select("legacy_unjudged_at")
        .where("id", "=", "slack-later-channel")
        .executeTakeFirstOrThrow();
      expect(second).toEqual({ orphanedOpenSlicesClosed: 0, legacyVerdictsKept: 0 });
      expect(unchanged.legacy_unjudged_at).toBe(legacyAt);
    });
  });
}

runSuite("Slack chunk startup repair SQLite", createTestDb);
runSuite("Slack chunk startup repair Postgres", getSharedPgDb, true);
