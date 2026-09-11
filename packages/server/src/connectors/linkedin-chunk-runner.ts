import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import type { DB } from "../db/schema";
import {
  type ChunkEngineDeps,
  type ChunkEngineKnobs,
  type ChunkPendingBound,
  evaluateIdleClose,
  runChunkingPass,
} from "./chunk-engine";
import { idleCloseCandidatesQuery, runStreamTick } from "./chunk-engine-runner";
import type { ChunkGenerate } from "./chunk-generate";
import {
  LINKEDIN_CHUNK_LOAD_MARGIN,
  LINKEDIN_CHUNK_STREAM_KEY,
  type LinkedinChunkRosterSnapshot,
  createLinkedinChunkAdapter,
  loadPendingLinkedinHistory,
} from "./linkedin-chunk-adapter";
import { LINKEDIN_CONVERSATION_KIND, LINKEDIN_CONVERSATION_PLATFORM } from "./linkedin-ingest";

export interface RunLinkedinChunkConversationOptions {
  db: Kysely<DB>;
  logger: Logger;
  now: Date;
  conversationId: number;
  roster: LinkedinChunkRosterSnapshot;
  knobs: ChunkEngineKnobs;
  generate: ChunkGenerate | undefined;
}

export interface LinkedinChunkConversationRunResult {
  backfillWindows: number;
  liveWindows: number;
  slicesClosed: number;
  idleClosed: boolean;
  /** True when the history backlog outlived the window budget; the next run resumes it. */
  historyPendingRemaining: boolean;
  pendingRemaining: boolean;
  tickSkipped: boolean;
  failed: boolean;
  skippedReason?: string;
}

export function linkedinIdleCloseCandidatesQuery(db: Kysely<DB>, idleBefore: string) {
  return idleCloseCandidatesQuery(db, {
    platform: LINKEDIN_CONVERSATION_PLATFORM,
    kind: LINKEDIN_CONVERSATION_KIND,
    idleBefore,
  });
}

/**
 * Conversations whose history backlog the chunk stream has not consumed, oldest
 * row id first. The set-level twin of `linkedinIdleCloseCandidatesQuery`: both
 * name work the provider listing cannot, because a conversation drops out of
 * the listing as soon as the watermark passes its last activity.
 *
 * It finds the work only. `loadPendingLinkedinHistory` stays the one definition
 * of what is still pending for a conversation — the sweep hands each candidate
 * to the same runner the listing uses, and that is where the predicate bounds
 * and drains the next window.
 */
export function linkedinPendingHistoryCandidatesQuery(db: Kysely<DB>, limit: number) {
  return db
    .selectFrom("conversations")
    .select("conversations.id as conversation_id")
    .where("conversations.platform", "=", LINKEDIN_CONVERSATION_PLATFORM)
    .where("conversations.kind", "=", LINKEDIN_CONVERSATION_KIND)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("conversation_messages")
          .leftJoin("conversation_slice_stream_cursors", (join) =>
            join
              .onRef("conversation_slice_stream_cursors.conversation_id", "=", "conversation_messages.conversation_id")
              .on("conversation_slice_stream_cursors.stream_key", "=", LINKEDIN_CHUNK_STREAM_KEY),
          )
          .select("conversation_messages.id")
          .whereRef("conversation_messages.conversation_id", "=", "conversations.id")
          .where("conversation_messages.source", "=", "history")
          .where("conversation_messages.effective_at", "is not", null)
          .where((inner) =>
            inner.or([
              inner("conversation_slice_stream_cursors.last_message_id", "is", null),
              inner("conversation_messages.id", ">", inner.ref("conversation_slice_stream_cursors.last_message_id")),
            ]),
          ),
      ),
    )
    .orderBy("conversations.id")
    .limit(limit);
}

/**
 * How far the next backfill window may reach: the pending history rows ahead of
 * the stream cursor, cut at the first silence of `idleCloseHours` or more.
 *
 * Bounding at the last pending row instead would be wrong for the common
 * LinkedIn shape, where a whole conversation fits in one window: the LLM would
 * be handed a 20-day silence inside a single window and could merge across it,
 * but idle-close is a wall that applies to history too. Stopping at the row
 * before the gap leaves the next iteration's backfill idle-close to cut the
 * slice at the silence. The history filter is what keeps live rows from being
 * judged by the backfill idle rule, which compares message gaps rather than
 * wall clock.
 *
 * The gap is never measured against the first pending row — its predecessor is
 * the open slice tail that `evaluateIdleClose` already judges — so the bound is
 * always at or ahead of the first pending row and every iteration advances.
 * Scanning one window's worth of rows is enough to find the only gap that can
 * fall inside the next window, and keeps the loop off a full-history read.
 */
async function pendingHistoryBound(
  db: Kysely<DB>,
  conversationId: number,
  knobs: ChunkEngineKnobs,
): Promise<ChunkPendingBound | undefined> {
  const { rows } = await loadPendingLinkedinHistory(
    db,
    conversationId,
    knobs.windowMessages + LINKEDIN_CHUNK_LOAD_MARGIN,
  );
  const idleMs = knobs.idleCloseHours * 60 * 60 * 1000;
  let bound: ChunkPendingBound | undefined;
  for (const row of rows) {
    if (!row.effective_at) continue;
    if (bound && Date.parse(row.effective_at) - Date.parse(bound.effectiveAt) >= idleMs) break;
    bound = { id: row.id, effectiveAt: row.effective_at };
  }
  return bound;
}

/**
 * Runs the engine for one LinkedIn conversation: drain the history backlog in
 * backfill mode, close an idle tail, then take the live tick.
 *
 * The live tick is skipped while history remains, and deliberately so: live
 * mode reads only live rows, so ticking over an undrained backlog would push
 * the row-id cursor past history rows that were never chunked. A run that ends
 * with `historyPendingRemaining` resumes on the next one.
 *
 * `maxWindowsPerRun` is one budget across both halves — the tick gets whatever
 * the backfill loop left and is skipped when that is nothing — so a run costs
 * at most the windows the knob names, not twice them.
 */
export async function runLinkedinChunkConversation(
  options: RunLinkedinChunkConversationOptions,
): Promise<LinkedinChunkConversationRunResult> {
  const repo = createConversationSlicesRepository(options.db);
  const adapter = createLinkedinChunkAdapter({
    conversationId: options.conversationId,
    roster: options.roster,
    knobs: options.knobs,
  });
  const deps: ChunkEngineDeps = {
    db: options.db,
    logger: options.logger,
    generate:
      options.generate ?? (async () => Promise.reject(new Error("LinkedIn boundary generation has no generator"))),
    now: () => options.now.getTime(),
  };

  let backfillWindows = 0;
  let slicesClosed = 0;
  let historyPendingRemaining = false;
  let skippedReason: string | undefined;
  let budget = Math.max(1, options.knobs.maxWindowsPerRun);

  /**
   * One window per iteration, each bounded at the next silence and preceded by
   * a backfill idle-close. The two together are what make idle-close a wall
   * inside a history batch: the bound keeps a silence out of the window, and
   * the idle-close then cuts the open tail at it before the next window opens.
   * That is the WhatsApp page order without its backfill-graph bookkeeping.
   */
  for (;;) {
    const bound = await pendingHistoryBound(options.db, options.conversationId, options.knobs);
    if (!bound) break;
    if (!options.generate) {
      skippedReason = "no_generator";
      historyPendingRemaining = true;
      break;
    }
    if (budget <= 0) {
      historyPendingRemaining = true;
      break;
    }
    if (await evaluateIdleClose(deps, { adapter, mode: "backfill", pendingUntil: bound })) slicesClosed += 1;
    const pass = await runChunkingPass(deps, { adapter, mode: "backfill", maxWindows: 1, pendingUntil: bound });
    budget -= 1;
    backfillWindows += pass.windowsProcessed;
    slicesClosed += pass.slicesClosed;
    if (pass.skippedReason || (pass.windowsProcessed === 0 && pass.messagesProcessed === 0)) {
      if (pass.skippedReason) skippedReason = pass.skippedReason;
      historyPendingRemaining = true;
      break;
    }
  }

  if (historyPendingRemaining) {
    return {
      backfillWindows,
      liveWindows: 0,
      slicesClosed,
      idleClosed: false,
      historyPendingRemaining,
      pendingRemaining: true,
      tickSkipped: false,
      failed: false,
      ...(skippedReason ? { skippedReason } : {}),
    };
  }

  const idleClosed = await evaluateIdleClose(deps, { adapter, mode: "live" });
  if (idleClosed) slicesClosed += 1;

  if (budget <= 0) {
    return {
      backfillWindows,
      liveWindows: 0,
      slicesClosed,
      idleClosed,
      historyPendingRemaining: false,
      pendingRemaining: true,
      tickSkipped: true,
      failed: false,
      skippedReason: "window_budget_exhausted",
    };
  }

  const tick = await runStreamTick({
    db: options.db,
    logger: options.logger,
    now: options.now,
    adapter,
    generate: deps.generate,
    llmGated: true,
    hasGenerator: options.generate !== undefined,
    maxWindows: budget,
    readLastAttempt: async () =>
      (await repo.getStreamCursor(options.conversationId, LINKEDIN_CHUNK_STREAM_KEY))?.llm_last_attempt_at ?? null,
    stampAttempt: async ({ claimToken }) => {
      if (claimToken === null) return;
      await options.db
        .updateTable("conversation_slice_stream_cursors")
        .set({ llm_last_attempt_at: options.now.toISOString(), updated_at: options.now.toISOString() })
        .where("conversation_id", "=", options.conversationId)
        .where("stream_key", "=", LINKEDIN_CHUNK_STREAM_KEY)
        .where("claim_token", "=", claimToken)
        .execute();
    },
    stampWhen: "on_claim",
    logContext: { conversationId: options.conversationId, conversationUrn: options.roster.conversationUrn },
    failureMessage: "LinkedIn chunk stream failed",
    backoffMessage: "LinkedIn chunk provider backoff",
  });

  return {
    backfillWindows,
    liveWindows: tick.windowsProcessed,
    slicesClosed: slicesClosed + tick.slicesClosed,
    idleClosed,
    historyPendingRemaining: false,
    pendingRemaining: tick.pendingRemaining,
    tickSkipped: tick.tickSkipped,
    failed: tick.failed,
    ...((tick.skippedReason ?? skippedReason) ? { skippedReason: tick.skippedReason ?? skippedReason } : {}),
  };
}
