import { readSourceMeta } from "../db/repositories/connectors";
import { parseTimestampMs } from "../timestamps";

/**
 * Emission anchor persisted on an indexed conversation slice file. It records
 * what the last emission saw and what the last *enrichment* saw, which is what
 * lets a growing open slice re-embed cheaply without re-running the LLM.
 */
export interface ConversationSliceEmissionAnchor extends Record<string, unknown> {
  firstMessageId: number;
  messageCount: number;
  emittedAt: string;
  enrichedMessageCount: number;
  enrichedAt: string;
}

/**
 * Timestamps are validated by parsing, not just by type: an anchor whose
 * `enrichedAt` cannot be read is worthless for the time gate, and treating it
 * as absent forces a full refresh instead of silently pinning a slice at
 * tier one forever.
 */
export function parseEmissionAnchor(sourceMeta: string | null): ConversationSliceEmissionAnchor | null {
  const parsed = readSourceMeta({ source_meta: sourceMeta });
  if (
    !parsed ||
    !Number.isInteger(parsed.firstMessageId) ||
    !Number.isInteger(parsed.messageCount) ||
    typeof parsed.emittedAt !== "string" ||
    Number.isNaN(Date.parse(parsed.emittedAt)) ||
    !Number.isInteger(parsed.enrichedMessageCount) ||
    typeof parsed.enrichedAt !== "string" ||
    Number.isNaN(Date.parse(parsed.enrichedAt))
  ) {
    return null;
  }
  return parsed as unknown as ConversationSliceEmissionAnchor;
}

/**
 * Chooses between a full re-enrichment and an embeddings-only refresh for a
 * slice about to be emitted. A closed slice or a slice with no readable anchor
 * always refreshes fully; an open slice stays at tier one only while its
 * boundary is unchanged, it has not shrunk, and neither the message-count gate
 * nor the wall-clock gate has expired since the last enrichment.
 */
export function emissionRefreshTier(input: {
  status: string;
  firstMessageId: number;
  messageCount: number;
  previous: ConversationSliceEmissionAnchor | null;
  refreshMessages: number;
  refreshMaxMinutes: number;
  now: Date;
}): "full" | "embeddings_only" {
  if (input.status === "closed" || !input.previous) return "full";
  if (
    input.firstMessageId !== input.previous.firstMessageId ||
    input.messageCount < input.previous.messageCount ||
    input.messageCount - input.previous.enrichedMessageCount >= input.refreshMessages
  ) {
    return "full";
  }
  const enrichedAt = parseTimestampMs(input.previous.enrichedAt);
  if (enrichedAt === null || input.now.getTime() - enrichedAt >= input.refreshMaxMinutes * 60_000) {
    return "full";
  }
  return "embeddings_only";
}

/**
 * Builds the anchor to persist alongside an emission. An embeddings-only
 * refresh carries the previous enrichment stamps forward so the gates keep
 * measuring from the last real enrichment rather than resetting on every tick.
 */
export function buildEmissionAnchor(input: {
  firstMessageId: number;
  messageCount: number;
  emittedAt: string;
  refreshTier: "full" | "embeddings_only";
  previous: ConversationSliceEmissionAnchor | null;
}): ConversationSliceEmissionAnchor {
  return {
    firstMessageId: input.firstMessageId,
    messageCount: input.messageCount,
    emittedAt: input.emittedAt,
    enrichedMessageCount:
      input.refreshTier === "full" ? input.messageCount : (input.previous?.enrichedMessageCount ?? input.messageCount),
    enrichedAt: input.refreshTier === "full" ? input.emittedAt : (input.previous?.enrichedAt ?? input.emittedAt),
  };
}
