/**
 * The live tick that both chat connectors run around `runChunkingPass`.
 *
 * Slack and WhatsApp had independently grown the same four pieces of
 * scheduling: skip the stream while the last LLM attempt is still inside the
 * tick window, override that skip once enough indexable messages have piled
 * up, retry the pass through transient provider errors, and turn a thrown pass
 * into one counted stream failure instead of a lost run. Only the storage of
 * the last-attempt stamp is genuinely connector-specific, so it stays injected.
 */
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import type { DB } from "../db/schema";
import {
  type ChunkCursorState,
  type ChunkEngineDeps,
  type ChunkPendingBound,
  type ChunkStreamAdapter,
  runChunkingPass,
} from "./chunk-engine";
import { isRetryableProviderError } from "./provider-fallback";

const BURST_SCAN_MAX_PAGES = 4;
const MAX_PROVIDER_ATTEMPTS = 3;
const MINUTE_MS = 60_000;

/**
 * Retries a pass while the error is transient. Attempts are capped at three
 * with a 100/200 ms backoff; anything else rethrows immediately.
 *
 * This covers pass-level faults only. `resolveBoundarySegments` already
 * swallows a failed boundary call into a repair attempt and then into
 * `boundary_validation_failed`, so a provider 429 raised by `generate` never
 * reaches here for either connector.
 */
export async function withProviderBackoff<T>(
  run: () => Promise<T>,
  options: { logger: Logger; logContext: Record<string, unknown>; message: string },
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryableProviderError(error) || attempt >= MAX_PROVIDER_ATTEMPTS - 1) throw error;
      const waitMs = Math.min(100 * 2 ** attempt, 1000);
      options.logger.warn({ ...options.logContext, attempt: attempt + 1, waitMs }, options.message);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

export interface ChunkStreamTickOptions {
  db: Kysely<DB>;
  logger: Logger;
  now: Date;
  adapter: ChunkStreamAdapter;
  generate: ChunkEngineDeps["generate"];
  onOpenChunkShrunk?: ChunkEngineDeps["onOpenChunkShrunk"];
  /**
   * Streams whose boundaries never reach the LLM (Slack threads) skip the gate,
   * the stamp and the backoff entirely — there is no provider call to pace.
   */
  llmGated: boolean;
  /** False when no generator is configured; the tick then skips without stamping an attempt. */
  hasGenerator: boolean;
  readLastAttempt?: () => Promise<string | null>;
  stampAttempt?: (claim: { claimToken: string | null }) => Promise<void>;
  /**
   * WhatsApp stamps before the pass, so a lost claim still consumes the tick;
   * Slack stamps from `onPassClaimed`, so only a claimed pass consumes it. The
   * two are load-bearing and deliberately not unified.
   */
  stampWhen?: "before_pass" | "on_claim";
  maxWindows?: number;
  historyStartId?: number | null;
  pendingUntil?: ChunkPendingBound;
  onPassComplete?: NonNullable<Parameters<typeof runChunkingPass>[1]["onPassComplete"]>;
  logContext: Record<string, unknown>;
  failureMessage: string;
  backoffMessage: string;
}

export interface ChunkStreamTickResult {
  windowsProcessed: number;
  slicesClosed: number;
  messagesProcessed: number;
  pendingRemaining: boolean;
  openSliceId: string | null;
  skippedReason?: string;
  tickSkipped: boolean;
  failed: boolean;
}

function skippedTick(skippedReason?: string, tickSkipped = false): ChunkStreamTickResult {
  return {
    windowsProcessed: 0,
    slicesClosed: 0,
    messagesProcessed: 0,
    pendingRemaining: true,
    openSliceId: null,
    tickSkipped,
    failed: false,
    ...(skippedReason ? { skippedReason } : {}),
  };
}

/**
 * Counts indexable pending messages over at most four adapter pages, so burst
 * detection stays bounded when a stream is full of non-indexable noise.
 */
async function countPendingIndexable(
  options: ChunkStreamTickOptions,
  threshold: number,
  historyStartId: number | null,
): Promise<number> {
  const state = await options.adapter.cursor.get(options.db);
  if (!state) return 0;
  let cursor: ChunkCursorState = state;
  let count = 0;
  for (let page = 0; page < BURST_SCAN_MAX_PAGES; page += 1) {
    const loaded = await options.adapter.loadOpenAndPending(options.db, undefined, cursor, threshold, {
      mode: "live",
      historyStartId,
    });
    count += loaded.pendingRaw.filter((message) => options.adapter.isIndexable(message)).length;
    if (count >= threshold || !loaded.pageFull) break;
    const tail = loaded.pendingRaw.at(-1);
    if (!tail) break;
    cursor = {
      ...cursor,
      lastEffectiveAt: options.adapter.order === "effective_time" ? tail.effectiveAt : cursor.lastEffectiveAt,
      lastMessageId: tail.id,
    };
  }
  return count;
}

/** True when enough indexable messages have queued to override the tick gate. */
async function burstOverridesTick(options: ChunkStreamTickOptions): Promise<boolean> {
  const knobs = options.adapter.knobs;
  const open = await createConversationSlicesRepository(options.db).getOpenSlice(
    options.adapter.conversationId,
    options.adapter.providerThreadId,
  );
  const threshold =
    knobs.burstThresholdMessages !== null
      ? Math.max(1, knobs.burstThresholdMessages)
      : Math.max(1, knobs.windowMessages - (open?.message_count ?? 0));
  const historyStartId = open?.first_message_id ?? options.historyStartId ?? null;
  return (await countPendingIndexable(options, threshold, historyStartId)) >= threshold;
}

export async function runStreamTick(options: ChunkStreamTickOptions): Promise<ChunkStreamTickResult> {
  if (options.llmGated) {
    if (!options.hasGenerator) return skippedTick("no_generator");
    const lastAttempt = (await options.readLastAttempt?.()) ?? null;
    const lastAttemptMs = lastAttempt ? Date.parse(lastAttempt) : Number.NaN;
    const insideTick =
      Number.isFinite(lastAttemptMs) &&
      options.now.getTime() - lastAttemptMs < options.adapter.knobs.tickMinutes * MINUTE_MS;
    if (insideTick && !(await burstOverridesTick(options))) return skippedTick(undefined, true);
    if (options.stampWhen === "before_pass") await options.stampAttempt?.({ claimToken: null });
  }

  const deps: ChunkEngineDeps = {
    db: options.db,
    logger: options.logger,
    generate: options.generate,
    now: () => options.now.getTime(),
    ...(options.onOpenChunkShrunk ? { onOpenChunkShrunk: options.onOpenChunkShrunk } : {}),
  };
  const stampOnClaim = options.llmGated && options.stampWhen === "on_claim" ? options.stampAttempt : undefined;
  try {
    const result = await withProviderBackoff(
      () =>
        runChunkingPass(deps, {
          adapter: options.adapter,
          mode: "live",
          ...(options.maxWindows !== undefined ? { maxWindows: options.maxWindows } : {}),
          ...(options.pendingUntil ? { pendingUntil: options.pendingUntil } : {}),
          ...(options.historyStartId !== undefined ? { historyStartId: options.historyStartId } : {}),
          ...(stampOnClaim ? { onPassClaimed: stampOnClaim } : {}),
          ...(options.onPassComplete ? { onPassComplete: options.onPassComplete } : {}),
        }),
      { logger: options.logger, logContext: options.logContext, message: options.backoffMessage },
    );
    return { ...result, tickSkipped: false, failed: false };
  } catch (err) {
    options.logger.warn({ err, ...options.logContext }, options.failureMessage);
    return {
      windowsProcessed: 0,
      slicesClosed: 0,
      messagesProcessed: 0,
      pendingRemaining: true,
      openSliceId: null,
      tickSkipped: false,
      failed: true,
    };
  }
}
