import { randomUUID } from "node:crypto";
import type { Kysely, Selectable, Transaction } from "kysely";
import { forEachChunk } from "../../connectors/sync-utils";
import type { DB, LinkedinReindexConversationsTable } from "../schema";

export type LinkedinReindexPhase = "pending" | "fetched" | "complete" | "failed" | "exhausted";
export type LinkedinReindexRow = Selectable<LinkedinReindexConversationsTable>;

/** `exhausted` is re-armed on boot, so it is not terminal; a queued conversation is one of these. */
export const LINKEDIN_REINDEX_NON_TERMINAL_PHASES: LinkedinReindexPhase[] = ["pending", "fetched", "exhausted"];
export const LINKEDIN_REINDEX_MAX_ATTEMPTS = 5;

export interface LinkedinReindexEnqueueRow {
  runId: string;
  connectorConfigId: string;
  accountId: string;
  conversationUrn: string;
  leadId: string | null;
}

export type LinkedinReindexPhaseCounts = Record<LinkedinReindexPhase, number>;

type LinkedinReindexDb = Kysely<DB> | Transaction<DB>;

/** One key per conversation, for set membership across the two identifying columns. */
export function linkedinReindexConversationKey(accountId: string, conversationUrn: string): string {
  return `${accountId} ${conversationUrn}`;
}

function truncateError(error: string): string {
  return error.slice(0, 1024);
}

export function createLinkedinReindexRepository(db: LinkedinReindexDb) {
  return {
    /**
     * Conflict-ignore on the run's unique key, so the same run enqueued twice —
     * a double-pressed button, a retried request — adds nothing.
     */
    async enqueue(rows: LinkedinReindexEnqueueRow[]): Promise<number> {
      if (rows.length === 0) return 0;
      let queued = 0;
      await forEachChunk(rows, async (batch) => {
        const result = await db
          .insertInto("linkedin_reindex_conversations")
          .values(
            batch.map((row) => ({
              id: randomUUID(),
              run_id: row.runId,
              connector_config_id: row.connectorConfigId,
              account_id: row.accountId,
              conversation_urn: row.conversationUrn,
              lead_id: row.leadId,
            })),
          )
          .onConflict((oc) =>
            oc.columns(["connector_config_id", "account_id", "conversation_urn", "run_id"]).doNothing(),
          )
          .executeTakeFirst();
        queued += Number(result.numInsertedOrUpdatedRows ?? 0);
      });
      return queued;
    },

    /**
     * Which of the given candidates are already queued. Enqueue skips them: a
     * second press must not re-fetch work that is still in flight.
     */
    async listQueuedConversations(input: {
      connectorConfigId: string;
      conversationUrns: string[];
    }): Promise<Set<string>> {
      if (input.conversationUrns.length === 0) return new Set();
      const queued = new Set<string>();
      await forEachChunk([...new Set(input.conversationUrns)], async (batch) => {
        const rows = await db
          .selectFrom("linkedin_reindex_conversations")
          .select(["account_id", "conversation_urn"])
          .distinct()
          .where("connector_config_id", "=", input.connectorConfigId)
          .where("conversation_urn", "in", batch)
          .where("phase", "in", LINKEDIN_REINDEX_NON_TERMINAL_PHASES)
          .execute();
        for (const row of rows) queued.add(linkedinReindexConversationKey(row.account_id, row.conversation_urn));
      });
      return queued;
    },

    /**
     * The next batch of fetchable rows, oldest first. Ownership is implicit:
     * one worker per process drains this table, as `SlackBackfillWorker` does,
     * so a read is a claim and no lease column is needed.
     */
    async claimPending(now: string, limit: number): Promise<LinkedinReindexRow[]> {
      return db
        .selectFrom("linkedin_reindex_conversations")
        .selectAll()
        .where("phase", "=", "pending")
        .where((eb) => eb.or([eb("next_retry_at", "is", null), eb("next_retry_at", "<=", now)]))
        .orderBy("created_at")
        .orderBy("id")
        .limit(limit)
        .execute();
    },

    /** The roster a reindex carries, for a conversation the engine has never cut a slice for. */
    async findFetchedConversation(input: {
      connectorConfigId: string;
      accountId: string;
      conversationUrn: string;
    }): Promise<LinkedinReindexRow | undefined> {
      return db
        .selectFrom("linkedin_reindex_conversations")
        .selectAll()
        .where("connector_config_id", "=", input.connectorConfigId)
        .where("account_id", "=", input.accountId)
        .where("conversation_urn", "=", input.conversationUrn)
        .where("phase", "=", "fetched")
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();
    },

    async countFetched(): Promise<number> {
      const row = await db
        .selectFrom("linkedin_reindex_conversations")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("phase", "=", "fetched")
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async markFetched(input: {
      id: string;
      leadId: string | null;
      leadName: string | null;
      ownerName: string | null;
      now: string;
    }): Promise<void> {
      await db
        .updateTable("linkedin_reindex_conversations")
        .set({
          phase: "fetched",
          lead_id: input.leadId,
          lead_name: input.leadName,
          owner_name: input.ownerName,
          attempts: 0,
          next_retry_at: null,
          last_error: null,
          updated_at: input.now,
        })
        .where("id", "=", input.id)
        .execute();
    },

    /**
     * The cutover's own close: the archive that swaps a conversation's
     * generation ends its reindex too, inside that transaction.
     */
    async markComplete(input: {
      connectorConfigId: string;
      accountId: string;
      conversationUrn: string;
      now: string;
    }): Promise<number> {
      const result = await db
        .updateTable("linkedin_reindex_conversations")
        .set({ phase: "complete", next_retry_at: null, last_error: null, updated_at: input.now })
        .where("connector_config_id", "=", input.connectorConfigId)
        .where("account_id", "=", input.accountId)
        .where("conversation_urn", "=", input.conversationUrn)
        .where("phase", "in", LINKEDIN_REINDEX_NON_TERMINAL_PHASES)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },

    /** Terminal: Aimfox no longer has the thread. The legacy files stay, so the timeline is never blank. */
    async markFailed(id: string, error: string, now: string): Promise<void> {
      await db
        .updateTable("linkedin_reindex_conversations")
        .set({ phase: "failed", last_error: truncateError(error), next_retry_at: null, updated_at: now })
        .where("id", "=", id)
        .execute();
    },

    /** Retries back off until the attempt budget is spent; the row then parks in `exhausted`. */
    async recordFailure(input: {
      id: string;
      error: string;
      now: string;
      retryAt: string;
      maxAttempts?: number;
    }): Promise<LinkedinReindexPhase> {
      const row = await db
        .selectFrom("linkedin_reindex_conversations")
        .select(["attempts", "phase"])
        .where("id", "=", input.id)
        .executeTakeFirstOrThrow();
      const attempts = row.attempts + 1;
      const exhausted = attempts >= (input.maxAttempts ?? LINKEDIN_REINDEX_MAX_ATTEMPTS);
      await db
        .updateTable("linkedin_reindex_conversations")
        .set({
          attempts,
          last_error: truncateError(input.error),
          next_retry_at: exhausted ? null : input.retryAt,
          ...(exhausted ? { phase: "exhausted" as const } : {}),
          updated_at: input.now,
        })
        .where("id", "=", input.id)
        .execute();
      return exhausted ? "exhausted" : (row.phase as LinkedinReindexPhase);
    },

    /**
     * Puts rows that spent their attempt budget back on the ladder. Unscoped on
     * boot, scoped to one connector when its operator presses re-index again —
     * the press is about that connector, and nothing else should be disturbed.
     */
    async rearmExhausted(now: string, connectorConfigId?: string): Promise<number> {
      let query = db
        .updateTable("linkedin_reindex_conversations")
        .set({ phase: "pending", attempts: 0, next_retry_at: null, updated_at: now })
        .where("phase", "=", "exhausted");
      if (connectorConfigId !== undefined) query = query.where("connector_config_id", "=", connectorConfigId);
      const result = await query.executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },

    /** One count per phase for one connector, zero-filled so the progress line is never ambiguous. */
    async countsByPhase(connectorConfigId: string): Promise<LinkedinReindexPhaseCounts> {
      const rows = await db
        .selectFrom("linkedin_reindex_conversations")
        .select((eb) => ["phase", eb.fn.countAll<number>().as("count")])
        .where("connector_config_id", "=", connectorConfigId)
        .groupBy("phase")
        .execute();
      const counts: LinkedinReindexPhaseCounts = { pending: 0, fetched: 0, complete: 0, failed: 0, exhausted: 0 };
      for (const row of rows) {
        if (row.phase in counts) counts[row.phase as LinkedinReindexPhase] = Number(row.count);
      }
      return counts;
    },
  };
}
