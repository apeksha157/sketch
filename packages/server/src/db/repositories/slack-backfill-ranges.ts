import { randomUUID } from "node:crypto";
import type { Kysely, Selectable, Transaction } from "kysely";
import type { DB, SlackBackfillRangesTable, SlackBackfillThreadsTable } from "../schema";

export type SlackBackfillRangeKind = "initial" | "gap" | "manual";
export type SlackBackfillRangePhase =
  | "pending"
  | "fetching_history"
  | "fetching_threads"
  | "fetched"
  | "complete"
  | "failed"
  | "exhausted";

export type SlackBackfillRangeRow = Selectable<SlackBackfillRangesTable>;
export type SlackBackfillThreadRow = Selectable<SlackBackfillThreadsTable>;

/** `exhausted` is re-armed by reconciliation, so it is not terminal. */
export const SLACK_BACKFILL_TERMINAL_PHASES: SlackBackfillRangePhase[] = ["complete", "failed"];
export const SLACK_BACKFILL_MAX_ATTEMPTS = 5;

export interface SlackBackfillChannelSummary {
  channelId: string;
  conversationId: number | null;
  storedRows: number;
  ranges: number;
  nonTerminalRanges: number;
  newestStoredTs: string | null;
}

type BackfillDb = Kysely<DB> | Transaction<DB>;

function truncateError(error: string): string {
  return error.slice(0, 1024);
}

export function createSlackBackfillRangeRepository(db: BackfillDb) {
  return {
    async getById(id: string): Promise<SlackBackfillRangeRow | undefined> {
      return db.selectFrom("slack_backfill_ranges").selectAll().where("id", "=", id).executeTakeFirst();
    },

    /**
     * Conflict-ignore on `(channel_id, range_key)` so a bot-join event and a
     * concurrent reconciliation sweep cannot open two ranges for one window.
     */
    async ensureRange(input: {
      channelId: string;
      conversationId: number;
      kind: SlackBackfillRangeKind;
      rangeKey: string;
      lowerTs: string;
      upperTs: string;
    }): Promise<{ row: SlackBackfillRangeRow; created: boolean }> {
      const result = await db
        .insertInto("slack_backfill_ranges")
        .values({
          id: randomUUID(),
          channel_id: input.channelId,
          conversation_id: input.conversationId,
          kind: input.kind,
          range_key: input.rangeKey,
          lower_ts: input.lowerTs,
          upper_ts: input.upperTs,
        })
        .onConflict((oc) => oc.columns(["channel_id", "range_key"]).doNothing())
        .executeTakeFirst();
      const row = await db
        .selectFrom("slack_backfill_ranges")
        .selectAll()
        .where("channel_id", "=", input.channelId)
        .where("range_key", "=", input.rangeKey)
        .executeTakeFirstOrThrow();
      return { row, created: Number(result.numInsertedOrUpdatedRows ?? 0) > 0 };
    },

    async findNextFetchable(now: string): Promise<SlackBackfillRangeRow | undefined> {
      return db
        .selectFrom("slack_backfill_ranges")
        .selectAll()
        .where("phase", "in", ["pending", "fetching_history", "fetching_threads"])
        .where((eb) => eb.or([eb("next_retry_at", "is", null), eb("next_retry_at", "<=", now)]))
        .orderBy("created_at")
        .orderBy("id")
        .limit(1)
        .executeTakeFirst();
    },

    async setPhase(id: string, phase: SlackBackfillRangePhase, now: string): Promise<void> {
      await db
        .updateTable("slack_backfill_ranges")
        .set({ phase, next_retry_at: null, last_error: null, updated_at: now })
        .where("id", "=", id)
        .execute();
    },

    async advanceHistoryCursor(input: {
      id: string;
      cursor: string | null;
      fetched: number;
      now: string;
    }): Promise<void> {
      const range = await db
        .selectFrom("slack_backfill_ranges")
        .select("messages_fetched")
        .where("id", "=", input.id)
        .executeTakeFirstOrThrow();
      await db
        .updateTable("slack_backfill_ranges")
        .set({
          history_cursor: input.cursor,
          messages_fetched: range.messages_fetched + input.fetched,
          attempts: 0,
          next_retry_at: null,
          last_error: null,
          updated_at: input.now,
        })
        .where("id", "=", input.id)
        .execute();
    },

    async queueThreads(rangeId: string, threadTss: string[], now: string): Promise<void> {
      if (threadTss.length === 0) return;
      await db
        .insertInto("slack_backfill_threads")
        .values(
          [...new Set(threadTss)].map((threadTs) => ({
            id: randomUUID(),
            range_id: rangeId,
            thread_ts: threadTs,
            updated_at: now,
          })),
        )
        .onConflict((oc) => oc.columns(["range_id", "thread_ts"]).doNothing())
        .execute();
    },

    async nextPendingThread(rangeId: string): Promise<SlackBackfillThreadRow | undefined> {
      return db
        .selectFrom("slack_backfill_threads")
        .selectAll()
        .where("range_id", "=", rangeId)
        .where("status", "=", "pending")
        .orderBy("thread_ts")
        .limit(1)
        .executeTakeFirst();
    },

    async advanceThreadCursor(input: { id: string; cursor: string | null; now: string }): Promise<void> {
      await db
        .updateTable("slack_backfill_threads")
        .set({ reply_cursor: input.cursor, updated_at: input.now })
        .where("id", "=", input.id)
        .execute();
    },

    async completeThread(id: string, now: string): Promise<void> {
      await db
        .updateTable("slack_backfill_threads")
        .set({ status: "done", reply_cursor: null, updated_at: now })
        .where("id", "=", id)
        .execute();
    },

    async markFailed(id: string, error: string, now: string): Promise<void> {
      await db
        .updateTable("slack_backfill_ranges")
        .set({ phase: "failed", last_error: truncateError(error), next_retry_at: null, updated_at: now })
        .where("id", "=", id)
        .execute();
    },

    /**
     * Retries back off until the attempt budget is spent; the range then parks
     * in `exhausted` until the next reconciliation sweep re-arms it.
     */
    async recordFailure(input: {
      id: string;
      error: string;
      now: string;
      retryAt: string;
      maxAttempts?: number;
    }): Promise<SlackBackfillRangePhase> {
      const range = await db
        .selectFrom("slack_backfill_ranges")
        .select(["attempts", "phase"])
        .where("id", "=", input.id)
        .executeTakeFirstOrThrow();
      const attempts = range.attempts + 1;
      const exhausted = attempts >= (input.maxAttempts ?? SLACK_BACKFILL_MAX_ATTEMPTS);
      await db
        .updateTable("slack_backfill_ranges")
        .set({
          attempts,
          last_error: truncateError(input.error),
          next_retry_at: exhausted ? null : input.retryAt,
          ...(exhausted ? { phase: "exhausted" as const } : {}),
          updated_at: input.now,
        })
        .where("id", "=", input.id)
        .execute();
      return exhausted ? "exhausted" : (range.phase as SlackBackfillRangePhase);
    },

    async rearmExhausted(now: string): Promise<number> {
      const result = await db
        .updateTable("slack_backfill_ranges")
        .set({ phase: "pending", attempts: 0, next_retry_at: null, updated_at: now })
        .where("phase", "=", "exhausted")
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },

    /**
     * Oldest range first inside a channel (initial before gaps), then the
     * least-recently-served channel, so no channel can starve the others.
     */
    async findNextGraphCandidate(input: { excludedConversationIds: number[] }): Promise<
      SlackBackfillRangeRow | undefined
    > {
      let query = db
        .selectFrom("slack_backfill_ranges")
        .selectAll()
        .where("phase", "=", "fetched")
        .where("graph_completed_at", "is", null)
        .where("graph_halted_at", "is", null);
      if (input.excludedConversationIds.length > 0) {
        query = query.where("conversation_id", "not in", input.excludedConversationIds);
      }
      return query
        .orderBy("graph_last_served_at", "asc")
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(1)
        .executeTakeFirst();
    },

    async advanceGraphCursor(input: {
      id: string;
      effectiveAt: string | null;
      messageId: number | null;
      now: string;
    }): Promise<void> {
      await db
        .updateTable("slack_backfill_ranges")
        .set({
          graph_cursor_effective_at: input.effectiveAt,
          graph_cursor_id: input.messageId,
          graph_last_served_at: input.now,
          updated_at: input.now,
        })
        .where("id", "=", input.id)
        .where("graph_completed_at", "is", null)
        .execute();
    },

    async completeGraph(id: string, now: string): Promise<boolean> {
      const result = await db
        .updateTable("slack_backfill_ranges")
        .set({ phase: "complete", graph_completed_at: now, graph_last_served_at: now, updated_at: now })
        .where("id", "=", id)
        .where("graph_completed_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) === 1;
    },

    async haltGraph(id: string, reason: string, now: string): Promise<void> {
      await db
        .updateTable("slack_backfill_ranges")
        .set({ graph_halted_at: now, last_error: truncateError(reason), updated_at: now })
        .where("id", "=", id)
        .where("graph_halted_at", "is", null)
        .execute();
    },

    async hasNonTerminalRange(channelId: string): Promise<boolean> {
      const row = await db
        .selectFrom("slack_backfill_ranges")
        .select("id")
        .where("channel_id", "=", channelId)
        .where("phase", "not in", SLACK_BACKFILL_TERMINAL_PHASES)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    /**
     * One row per requested channel with everything both triggers need: whether
     * the channel has stored rows, how many ranges exist and how many are still
     * running, and the newest stored Slack ts to anchor a gap's lower bound.
     */
    async summarizeChannels(channelIds: string[]): Promise<SlackBackfillChannelSummary[]> {
      if (channelIds.length === 0) return [];
      const conversations = await db
        .selectFrom("conversations")
        .select(["id", "provider_conversation_id"])
        .where("platform", "=", "slack")
        .where("kind", "=", "channel")
        .where("provider_conversation_id", "in", channelIds)
        .execute();
      const conversationIdByChannel = new Map(
        conversations.map((row) => [row.provider_conversation_id, row.id] as const),
      );
      const conversationIds = conversations.map((row) => row.id);
      const messageStats =
        conversationIds.length === 0
          ? []
          : await db
              .selectFrom("conversation_messages")
              .select((eb) => [
                "conversation_id",
                eb.fn.countAll<number>().as("stored_rows"),
                eb.fn.max<string | null>("provider_message_id").as("newest_ts"),
              ])
              .where("conversation_id", "in", conversationIds)
              .groupBy("conversation_id")
              .execute();
      const statsByConversation = new Map(messageStats.map((row) => [row.conversation_id, row] as const));
      const rangeRows = await db
        .selectFrom("slack_backfill_ranges")
        .select(["channel_id", "phase"])
        .where("channel_id", "in", channelIds)
        .execute();

      return channelIds.map((channelId) => {
        const conversationId = conversationIdByChannel.get(channelId) ?? null;
        const stats = conversationId === null ? undefined : statsByConversation.get(conversationId);
        const ranges = rangeRows.filter((row) => row.channel_id === channelId);
        return {
          channelId,
          conversationId,
          storedRows: Number(stats?.stored_rows ?? 0),
          ranges: ranges.length,
          nonTerminalRanges: ranges.filter(
            (row) => !SLACK_BACKFILL_TERMINAL_PHASES.includes(row.phase as SlackBackfillRangePhase),
          ).length,
          newestStoredTs: stats?.newest_ts ?? null,
        };
      });
    },
  };
}
