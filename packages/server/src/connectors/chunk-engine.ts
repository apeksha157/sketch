import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Logger } from "pino";
import {
  type ConversationSliceCursorRow,
  type ConversationSliceFlushReason,
  type ConversationSliceOrigin,
  type ConversationSliceRow,
  type ConversationSliceStreamCursorRow,
  createConversationSlicesRepository,
} from "../db/repositories/conversation-slices";
import { createConversationTopicsRepository } from "../db/repositories/conversation-topics";
import type { DB } from "../db/schema";
import { estimateTokens } from "./chunking";

export interface ChunkEngineDeps {
  db: Kysely<DB>;
  logger: Logger;
  generate: (
    prompt: string,
    opts: {
      model: string | null;
      reasoningEffort: "low" | "medium" | "high";
      maxTokens?: number;
      label?: string;
    },
  ) => Promise<string>;
  now?: () => number;
  onOpenChunkShrunk?: (indexedFileId: string) => Promise<void>;
}

export interface BoundarySegment {
  start: number;
  end: number;
  threads: string[];
}

export interface ChunkEngineMessage {
  id: number;
  providerMessageId: string;
  effectiveAt: string;
  receivedAt: string;
  text: string;
  attachments: string | null;
  isBot: boolean;
}

export interface ChunkEngineKnobs {
  windowMessages: number;
  windowTokens: number;
  minMessages: number;
  targetMessages: number;
  maxMessages: number;
  maxTokens: number;
  tickMinutes: number;
  idleCloseHours: number;
  provisionalRefreshMessages: number;
  model: string | null;
  reasoningEffort: "low" | "medium" | "high";
  burstThresholdMessages: number | null;
  topicRegistryCap: number;
  groupWorkerPool: number;
  maxWindowsPerRun: number;
}

export interface ChunkPendingBound {
  effectiveAt: string;
  id: number;
}

export interface ChunkPendingOptions {
  mode: "live" | "backfill";
  pendingUntil?: ChunkPendingBound;
  historyStartId?: number | null;
}

export interface ChunkCursorState {
  lastEffectiveAt: string | null;
  lastMessageId: number | null;
  claimToken: string | null;
  pendingSince?: string | null;
}

interface ChunkCursorClaimInput {
  claimToken: string;
  now: string;
  staleBefore: string;
}

interface ChunkCursorMutationInput {
  claimToken: string;
}

interface ChunkCursorAdvanceInput extends ChunkCursorMutationInput {
  message: ChunkEngineMessage;
}

export interface ChunkCursorStore {
  claim(db: Kysely<DB>, input: ChunkCursorClaimInput): Promise<boolean>;
  get(db: Kysely<DB>): Promise<ChunkCursorState | undefined>;
  advance(db: Kysely<DB>, input: ChunkCursorAdvanceInput): Promise<ChunkCursorState | undefined>;
  renew(db: Kysely<DB>, input: ChunkCursorMutationInput & { now: string }): Promise<boolean>;
  release(db: Kysely<DB>, input: ChunkCursorMutationInput): Promise<boolean>;
  isAfterCursor(message: ChunkEngineMessage, cursor: ChunkCursorState): boolean;
  matches(left: ChunkCursorState, right: ChunkCursorState): boolean;
}

export interface ChunkStreamAdapter {
  conversationId: number;
  streamKey: string | null;
  providerThreadId: string | null;
  cursor: ChunkCursorStore;
  loadOpenAndPending(
    db: Kysely<DB>,
    open: ConversationSliceRow | undefined,
    cursor: ChunkCursorState,
    cap: number,
    options: ChunkPendingOptions,
  ): Promise<{ openRaw: ChunkEngineMessage[]; pendingRaw: ChunkEngineMessage[]; pageFull: boolean }>;
  nextPendingMessage(
    db: Kysely<DB>,
    cursor: ChunkCursorState,
    options: ChunkPendingOptions,
  ): Promise<ChunkEngineMessage | undefined>;
  tailMessage(db: Kysely<DB>, messageId: number): Promise<ChunkEngineMessage | undefined>;
  isIndexable(message: ChunkEngineMessage): boolean;
  senderLabel(message: ChunkEngineMessage): string;
  order: "effective_time" | "row_id";
  origin?: ConversationSliceOrigin;
  boundaries: "llm" | "single-segment";
  promptHeader: string;
  generateLabel(kind: "boundary" | "repair"): string;
  flushReason(kind: "boundary" | "idle" | "force_split"): ConversationSliceFlushReason;
  rosterSnapshot(db: Kysely<DB>): Promise<string>;
  usesTopicRegistry: boolean;
  onSliceClosed?(trx: Transaction<DB>, slice: ConversationSliceRow): Promise<void>;
  onBoundaryValidationFailed?(logger: Logger, mode: "live" | "backfill"): void;
  knobs: ChunkEngineKnobs;
}

/** Slices are keyed by `(conversation, thread, origin)`; live is the default. */
function adapterOrigin(adapter: ChunkStreamAdapter): ConversationSliceOrigin {
  return adapter.origin ?? "live";
}

function logBoundaryValidationFailure(logger: Logger, adapter: ChunkStreamAdapter, mode: "live" | "backfill"): void {
  if (adapter.onBoundaryValidationFailed) {
    adapter.onBoundaryValidationFailed(logger, mode);
    return;
  }
  logger.warn({ conversationId: adapter.conversationId, streamKey: adapter.streamKey, mode }, "chunking_skipped");
}

function compositeCursorState(row: ConversationSliceCursorRow): ChunkCursorState {
  return {
    lastEffectiveAt: row.last_effective_at,
    lastMessageId: row.last_message_id,
    claimToken: row.claim_token,
  };
}

function streamCursorState(row: ConversationSliceStreamCursorRow): ChunkCursorState {
  return {
    lastEffectiveAt: row.last_effective_at,
    lastMessageId: row.last_message_id,
    claimToken: row.claim_token,
    pendingSince: row.pending_since,
  };
}

export function createCompositeChunkCursorStore(conversationId: number): ChunkCursorStore {
  return {
    claim: async (db, input) => createConversationSlicesRepository(db).claimCursor({ conversationId, ...input }),
    get: async (db) => {
      const row = await createConversationSlicesRepository(db).getCursor(conversationId);
      return row ? compositeCursorState(row) : undefined;
    },
    advance: async (db, input) => {
      const row = await createConversationSlicesRepository(db).advanceCursorIfClaimed({
        conversationId,
        lastEffectiveAt: input.message.effectiveAt,
        lastMessageId: input.message.id,
        claimToken: input.claimToken,
      });
      return row ? compositeCursorState(row) : undefined;
    },
    renew: (db, input) => createConversationSlicesRepository(db).renewCursorClaim({ conversationId, ...input }),
    release: (db, input) => createConversationSlicesRepository(db).releaseCursorClaim({ conversationId, ...input }),
    isAfterCursor: (message, cursor) => {
      if (cursor.lastEffectiveAt === null || cursor.lastMessageId === null) return true;
      const cursorMs = effectiveMs(cursor.lastEffectiveAt);
      const messageMs = effectiveMs(message.effectiveAt);
      return messageMs > cursorMs || (messageMs === cursorMs && message.id > cursor.lastMessageId);
    },
    matches: (left, right) =>
      left.lastEffectiveAt === right.lastEffectiveAt && left.lastMessageId === right.lastMessageId,
  };
}

export function createStreamChunkCursorStore(conversationId: number, streamKey: string): ChunkCursorStore {
  return {
    claim: async (db, input) =>
      createConversationSlicesRepository(db).claimStreamCursorIfPending({ conversationId, streamKey, ...input }),
    get: async (db) => {
      const row = await createConversationSlicesRepository(db).getStreamCursor(conversationId, streamKey);
      return row ? streamCursorState(row) : undefined;
    },
    advance: async (db, input) => {
      const row = await createConversationSlicesRepository(db).advanceStreamCursorIfClaimed({
        conversationId,
        streamKey,
        lastMessageId: input.message.id,
        claimToken: input.claimToken,
      });
      return row ? streamCursorState(row) : undefined;
    },
    renew: (db, input) =>
      createConversationSlicesRepository(db).renewStreamCursorClaim({ conversationId, streamKey, ...input }),
    release: (db, input) =>
      createConversationSlicesRepository(db).releaseStreamCursorClaim({ conversationId, streamKey, ...input }),
    isAfterCursor: (message, cursor) => cursor.lastMessageId === null || message.id > cursor.lastMessageId,
    matches: (left, right) => left.lastMessageId === right.lastMessageId,
  };
}

/**
 * Same stream-cursor row and claim protocol as the id-only store, but ordered by
 * `(effective_at, id)` so a stream whose row ids are not chronological (Slack
 * history, fetched newest-first) never rewinds its cursor.
 */
export function createCompositeStreamChunkCursorStore(conversationId: number, streamKey: string): ChunkCursorStore {
  const idOnly = createStreamChunkCursorStore(conversationId, streamKey);
  return {
    ...idOnly,
    advance: async (db, input) => {
      const row = await createConversationSlicesRepository(db).advanceStreamCursorCompositeIfClaimed({
        conversationId,
        streamKey,
        lastEffectiveAt: input.message.effectiveAt,
        lastMessageId: input.message.id,
        claimToken: input.claimToken,
      });
      return row ? streamCursorState(row) : undefined;
    },
    isAfterCursor: (message, cursor) => {
      if (cursor.lastEffectiveAt === null || cursor.lastMessageId === null) return true;
      const cursorMs = effectiveMs(cursor.lastEffectiveAt);
      const messageMs = effectiveMs(message.effectiveAt);
      return messageMs > cursorMs || (messageMs === cursorMs && message.id > cursor.lastMessageId);
    },
    matches: (left, right) =>
      left.lastEffectiveAt === right.lastEffectiveAt && left.lastMessageId === right.lastMessageId,
  };
}

const CLAIM_STALE_MS = 30 * 60 * 1000;

/**
 * Reasoning models spend output tokens thinking before they answer, and the
 * provider counts both against this cap. At high effort a full boundary window
 * exhausted 2048 tokens on reasoning alone and returned empty text, so the cap
 * is sized for the reasoning, not the small JSON answer. It is a ceiling only;
 * callers pay for the tokens actually used.
 */
const BOUNDARY_MAX_OUTPUT_TOKENS = 16_384;
interface SortableMessage extends ChunkEngineMessage {
  senderLabel: string;
  effectiveMs: number;
  rawIndex: number;
}

interface BoundaryWindow {
  open: ConversationSliceRow | undefined;
  cursor: ChunkCursorState;
  pageFull: boolean;
  allRaw: SortableMessage[];
  openMessages: SortableMessage[];
  newMessages: SortableMessage[];
  messages: SortableMessage[];
}

interface PlannedBoundarySlice {
  firstMessageId: number;
  lastMessageId: number;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  denoisedMessageIds: number[];
  threads: string[];
}

interface ApplyResult {
  closed: number;
  openSliceId: string | null;
  messagesProcessed: number;
  shrunkIndexedFileId: string | null;
}

class ClaimLostError extends Error {
  constructor() {
    super("Chunking claim was lost");
  }
}

class OverlapGuardError extends Error {
  constructor() {
    super("Chunk boundary overlaps an existing slice");
  }
}

class BoundaryCoverageError extends Error {}

function nowMs(deps: ChunkEngineDeps): number {
  return deps.now?.() ?? Date.now();
}

function nowIso(deps: ChunkEngineDeps): string {
  return new Date(nowMs(deps)).toISOString();
}

function effectiveMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortMessages(messages: ChunkEngineMessage[], adapter: ChunkStreamAdapter): SortableMessage[] {
  return messages
    .map((message) => ({
      ...message,
      senderLabel: adapter.senderLabel(message),
      effectiveMs: effectiveMs(message.effectiveAt),
      rawIndex: 0,
    }))
    .sort((left, right) =>
      adapter.order === "effective_time"
        ? left.effectiveMs - right.effectiveMs || left.id - right.id
        : left.id - right.id,
    )
    .map((message, rawIndex) => ({ ...message, rawIndex }));
}

function parseDenoisedIds(slice: ConversationSliceRow | undefined): number[] {
  if (!slice?.denoised_message_ids) return [];
  try {
    const parsed = JSON.parse(slice.denoised_message_ids) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === "number") : [];
  } catch {
    return [];
  }
}

function sliceHasSameContent(row: ConversationSliceRow, planned: PlannedBoundarySlice): boolean {
  return (
    row.first_message_id === planned.firstMessageId &&
    row.last_message_id === planned.lastMessageId &&
    row.started_at === planned.startedAt &&
    row.ended_at === planned.endedAt &&
    row.message_count === planned.messageCount &&
    row.denoised_message_ids === JSON.stringify(planned.denoisedMessageIds)
  );
}

function normalizeThreads(threads: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const thread of threads) {
    const value = thread.trim();
    const key = value.replace(/\s+/gu, " ").toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

function parseBoundaryJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

export function validateBoundarySegments(raw: string, messageCount: number): BoundarySegment[] {
  let parsed: unknown;
  try {
    parsed = parseBoundaryJson(raw);
  } catch {
    throw new BoundaryCoverageError("response is not valid JSON");
  }

  const segments = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "segments" in parsed
      ? (parsed as { segments?: unknown }).segments
      : undefined;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new BoundaryCoverageError("response must contain a non-empty segments array");
  }

  const validated: BoundarySegment[] = [];
  let expectedStart = 1;
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") throw new BoundaryCoverageError("segment is not an object");
    const value = segment as { start?: unknown; end?: unknown; threads?: unknown };
    if (!Number.isInteger(value.start) || !Number.isInteger(value.end)) {
      throw new BoundaryCoverageError("segment boundaries must be integers");
    }
    if (!Array.isArray(value.threads) || value.threads.some((thread) => typeof thread !== "string")) {
      throw new BoundaryCoverageError("segment threads must be strings");
    }
    if (value.start !== expectedStart) throw new BoundaryCoverageError("segments have a gap or overlap");
    if ((value.start as number) < 1 || (value.end as number) < (value.start as number)) {
      throw new BoundaryCoverageError("segment boundaries are out of order");
    }
    if ((value.end as number) > messageCount) throw new BoundaryCoverageError("segment is out of range");
    validated.push({
      start: value.start as number,
      end: value.end as number,
      threads: normalizeThreads(value.threads),
    });
    expectedStart = (value.end as number) + 1;
  }
  if (expectedStart !== messageCount + 1) throw new BoundaryCoverageError("segments do not cover the full window");
  return validated;
}

function segmentCount(segment: BoundarySegment): number {
  return segment.end - segment.start + 1;
}

function mergeSegment(left: BoundarySegment, right: BoundarySegment): BoundarySegment {
  return {
    start: left.start,
    end: right.end,
    threads: normalizeThreads([...left.threads, ...right.threads]),
  };
}

function sharesThread(left: BoundarySegment, right: BoundarySegment): boolean {
  const rightNames = new Set(normalizeThreads(right.threads).map((thread) => thread.toLocaleLowerCase()));
  return normalizeThreads(left.threads).some((thread) => rightNames.has(thread.toLocaleLowerCase()));
}

function consolidateAdjacentSegments(segments: BoundarySegment[], targetMessages: number): BoundarySegment[] {
  const result: BoundarySegment[] = [];
  for (const segment of segments) {
    const previous = result[result.length - 1];
    if (
      previous &&
      sharesThread(previous, segment) &&
      segmentCount(previous) + segmentCount(segment) <= targetMessages
    ) {
      result[result.length - 1] = mergeSegment(previous, segment);
    } else {
      result.push(segment);
    }
  }
  return result;
}

function mergeInteriorBelowFloor(segments: BoundarySegment[], minMessages: number): BoundarySegment[] {
  const result = [...segments];
  let index = 1;
  while (index < result.length - 1) {
    if (segmentCount(result[index] as BoundarySegment) >= minMessages) {
      index += 1;
      continue;
    }
    const current = result[index] as BoundarySegment;
    const left = result[index - 1] as BoundarySegment;
    const right = result[index + 1] as BoundarySegment;
    if (sharesThread(current, left) || !sharesThread(current, right)) {
      result.splice(index - 1, 2, mergeSegment(left, current));
      index = Math.max(1, index - 1);
    } else {
      result.splice(index, 2, mergeSegment(current, right));
    }
  }
  return result;
}

function deferTailAdjacentBreak(segments: BoundarySegment[], minMessages: number): BoundarySegment[] {
  if (segments.length < 2) return segments;
  const tailAdjacentIndex = segments.length - 2;
  const tailAdjacent = segments[tailAdjacentIndex];
  const tail = segments[tailAdjacentIndex + 1];
  if (!tailAdjacent || !tail || segmentCount(tailAdjacent) >= minMessages) return segments;
  return [...segments.slice(0, tailAdjacentIndex), mergeSegment(tailAdjacent, tail)];
}

function forceSplitSegments(
  segments: BoundarySegment[],
  messages: Array<Pick<ChunkEngineMessage, "text">>,
  maxMessages: number,
  maxTokens: number,
): BoundarySegment[] {
  const result: BoundarySegment[] = [];
  for (const segment of segments) {
    let start = segment.start;
    let tokens = 0;
    let count = 0;
    for (let index = segment.start; index <= segment.end; index += 1) {
      const message = messages[index - 1];
      if (!message) continue;
      const messageTokens = estimateTokens(message.text);
      const oversizedSingle = count === 0 && messageTokens > maxTokens;
      const exceeds = count > 0 && (count >= maxMessages || tokens + messageTokens > maxTokens);
      if (exceeds) {
        result.push({ start, end: index - 1, threads: [...segment.threads] });
        start = index;
        count = 0;
        tokens = 0;
      }
      count += 1;
      tokens += messageTokens;
      if (oversizedSingle) {
        result.push({ start, end: index, threads: [...segment.threads] });
        start = index + 1;
        count = 0;
        tokens = 0;
      }
    }
    if (start <= segment.end) result.push({ start, end: segment.end, threads: [...segment.threads] });
  }
  return result;
}

export function enforceBoundarySize(
  segments: BoundarySegment[],
  messages: Array<Pick<ChunkEngineMessage, "text">>,
  knobs: Pick<ChunkEngineKnobs, "minMessages" | "targetMessages" | "maxMessages" | "maxTokens">,
): BoundarySegment[] {
  let result = consolidateAdjacentSegments(segments, knobs.targetMessages);
  result = mergeInteriorBelowFloor(result, knobs.minMessages);
  result = deferTailAdjacentBreak(result, knobs.minMessages);
  result = forceSplitSegments(result, messages, knobs.maxMessages, knobs.maxTokens);
  return result;
}

function buildPlannedSlice(
  sortedRaw: SortableMessage[],
  denoisedMessages: SortableMessage[],
  segment: BoundarySegment,
  order: ChunkStreamAdapter["order"],
): PlannedBoundarySlice {
  const kept = denoisedMessages.slice(segment.start - 1, segment.end);
  const firstKept = kept[0];
  const lastKept = kept[kept.length - 1];
  if (!firstKept || !lastKept) throw new Error("Cannot build an empty chunk slice");
  const rawRange = sortedRaw.slice(firstKept.rawIndex, lastKept.rawIndex + 1);
  const rangeIds = rawRange.map((message) => message.id);
  return {
    firstMessageId: Math.min(...rangeIds),
    lastMessageId: Math.max(...rangeIds),
    startedAt:
      order === "effective_time"
        ? firstKept.effectiveAt
        : kept.reduce((min, message) => (message.effectiveAt < min ? message.effectiveAt : min), firstKept.effectiveAt),
    endedAt:
      order === "effective_time"
        ? lastKept.effectiveAt
        : kept.reduce((max, message) => (message.effectiveAt > max ? message.effectiveAt : max), lastKept.effectiveAt),
    messageCount: kept.length,
    denoisedMessageIds: kept.map((message) => message.id),
    threads: normalizeThreads(segment.threads),
  };
}

function takeWindowSuffix(
  openMessages: SortableMessage[],
  newMessages: SortableMessage[],
  knobs: ChunkEngineKnobs,
): SortableMessage[] {
  const currentTokens = openMessages.reduce((sum, message) => sum + estimateTokens(message.text), 0);
  const suffix: SortableMessage[] = [];
  let tokens = currentTokens;
  for (const message of newMessages) {
    const nextCount = openMessages.length + suffix.length + 1;
    const nextTokens = tokens + estimateTokens(message.text);
    const overMessages = suffix.length > 0 && nextCount > knobs.windowMessages;
    const overTokens = suffix.length > 0 && nextTokens > knobs.windowTokens;
    if (overMessages || overTokens) break;
    suffix.push(message);
    tokens = nextTokens;
  }
  if (suffix.length === 0 && newMessages[0]) suffix.push(newMessages[0]);
  return suffix;
}

function isAtOrBefore(
  adapter: ChunkStreamAdapter,
  message: Pick<SortableMessage, "effectiveAt" | "id">,
  bound: Pick<SortableMessage, "effectiveAt" | "id">,
): boolean {
  return (
    (adapter.order === "row_id" && message.id <= bound.id) ||
    (adapter.order === "effective_time" &&
      (message.effectiveAt < bound.effectiveAt ||
        (message.effectiveAt === bound.effectiveAt && message.id <= bound.id)))
  );
}

/**
 * The read-only no-hit path preserves the supplied open row; `decideAndApply`
 * revalidates the claim, cursor, and open slice before boundary writes, while
 * `advanceNoiseCursor` revalidates the claim and cursor before noise-only writes.
 */
async function repairOrphanedOpenSlice(
  db: Kysely<DB>,
  adapter: ChunkStreamAdapter,
  open: ConversationSliceRow | undefined,
  cursor: ChunkCursorState,
): Promise<ConversationSliceRow | undefined> {
  if (adapter.order !== "row_id" || !open) return open;
  const laterClosed = await db
    .selectFrom("conversation_slices")
    .select("id")
    .where("conversation_id", "=", adapter.conversationId)
    .where((eb) =>
      eb.or([
        eb("provider_thread_id", "=", adapter.providerThreadId),
        eb.and([
          eb("provider_thread_id", "is", null),
          eb(eb.cast(eb.val(adapter.providerThreadId), "text"), "is", null),
        ]),
      ]),
    )
    .where("status", "=", "closed")
    .where("origin", "=", adapterOrigin(adapter))
    .where("first_message_id", ">", open.first_message_id)
    .limit(1)
    .executeTakeFirst();
  if (!laterClosed) return open;
  return db.transaction().execute(async (trx) => {
    const currentCursor = await adapter.cursor.get(trx);
    if (
      !currentCursor ||
      currentCursor.claimToken !== cursor.claimToken ||
      !adapter.cursor.matches(currentCursor, cursor)
    ) {
      throw new ClaimLostError();
    }
    const sliceRepo = createConversationSlicesRepository(trx);
    const currentOpen = await sliceRepo.getOpenSlice(
      adapter.conversationId,
      adapter.providerThreadId,
      adapterOrigin(adapter),
    );
    if (currentOpen?.id !== open.id) throw new ClaimLostError();
    const closed = await sliceRepo.closeOpenSlice(open.id, adapter.flushReason("idle"));
    if (!closed) throw new ClaimLostError();
    await adapter.onSliceClosed?.(trx, closed);
    return undefined;
  });
}

/**
 * The raw range is derived from the open span and bounded pending page, so
 * `(conversation_id, first_message_id)` is no longer a pure function of the
 * full message set. This is safe because overlap validation, slice writes,
 * and cursor advancement happen together in one apply transaction.
 */
async function loadWindow(
  db: Kysely<DB>,
  adapter: ChunkStreamAdapter,
  mode: "live" | "backfill",
  pendingUntil?: ChunkPendingBound,
  fallbackHistoryStartId?: number | null,
): Promise<BoundaryWindow> {
  const cursor = await adapter.cursor.get(db);
  if (!cursor) throw new Error("Chunking cursor was not claimed");
  let open = await createConversationSlicesRepository(db).getOpenSlice(
    adapter.conversationId,
    adapter.providerThreadId,
    adapterOrigin(adapter),
  );
  open = await repairOrphanedOpenSlice(db, adapter, open, cursor);
  const loaded = await adapter.loadOpenAndPending(db, open, cursor, adapter.knobs.windowMessages, {
    mode,
    pendingUntil,
    historyStartId: open?.first_message_id ?? fallbackHistoryStartId ?? null,
  });
  const rawById = new Map([...loaded.openRaw, ...loaded.pendingRaw].map((message) => [message.id, message]));
  const allRaw = sortMessages([...rawById.values()], adapter);
  const openIds = new Set(parseDenoisedIds(open));
  const openMessages = allRaw.filter(
    (message) =>
      adapter.isIndexable(message) &&
      (openIds.size > 0
        ? openIds.has(message.id)
        : open !== undefined &&
          message.effectiveMs >= effectiveMs(open.started_at) &&
          message.effectiveMs <= effectiveMs(open.ended_at)),
  );
  const newMessages = allRaw.filter(
    (message) =>
      adapter.isIndexable(message) &&
      adapter.cursor.isAfterCursor(message, cursor) &&
      (!pendingUntil ||
        (adapter.order === "row_id"
          ? message.id <= pendingUntil.id
          : message.effectiveAt < pendingUntil.effectiveAt ||
            (message.effectiveAt === pendingUntil.effectiveAt && message.id <= pendingUntil.id))),
  );
  const suffix = takeWindowSuffix(openMessages, newMessages, adapter.knobs);
  return {
    open,
    cursor,
    pageFull: loaded.pageFull,
    allRaw,
    openMessages,
    newMessages,
    messages: [...openMessages, ...suffix],
  };
}

function renderBoundaryPrompt(
  promptHeader: string,
  registry: Array<{ name: string; one_liner: string | null }>,
  messages: SortableMessage[],
  openIds: Set<number>,
): string {
  const registryBlock = registry.length
    ? registry.map((topic) => `- ${topic.name}${topic.one_liner ? ` — ${topic.one_liner}` : ""}`).join("\n")
    : "- None";
  const messageBlock = messages
    .map((message, index) => {
      const marker = openIds.has(message.id) ? "OPEN CHUNK" : "NEW";
      return `${index + 1}. [${marker}] ${message.effectiveAt} ${message.senderLabel}: ${message.text}`;
    })
    .join("\n");
  return [
    promptHeader,
    "Identify contiguous topic segments over the numbered messages.",
    "The OPEN CHUNK messages are atomic context, but its boundary may be revised.",
    'Return JSON only with ordered segments: {"segments":[{"start":1,"end":2,"threads":["topic name"]}]}.',
    "Segments must cover every message exactly once. Return boundaries and thread names only; no summaries or commentary.",
    "Topic registry:",
    registryBlock,
    "Messages:",
    messageBlock,
  ].join("\n");
}

async function generateBoundarySegments(
  deps: ChunkEngineDeps,
  adapter: ChunkStreamAdapter,
  prompt: string,
  knobs: ChunkEngineKnobs,
  messageCount: number,
): Promise<BoundarySegment[] | undefined> {
  let firstOutput = "";
  let firstError = "";
  try {
    firstOutput = await deps.generate(prompt, {
      model: knobs.model,
      reasoningEffort: knobs.reasoningEffort,
      maxTokens: BOUNDARY_MAX_OUTPUT_TOKENS,
      label: adapter.generateLabel("boundary"),
    });
    return validateBoundarySegments(firstOutput, messageCount);
  } catch (error) {
    firstError = error instanceof Error ? error.message : "boundary response failed";
  }

  const repairPrompt = [
    prompt,
    "The previous response failed validation.",
    `Validation error: ${firstError}`,
    "Repair the response. Return JSON only, with contiguous in-range segments covering every message exactly once.",
    firstOutput ? `Previous response:\n${firstOutput}` : "No usable previous response was returned.",
  ].join("\n\n");
  try {
    const repairedOutput = await deps.generate(repairPrompt, {
      model: knobs.model,
      reasoningEffort: knobs.reasoningEffort,
      maxTokens: BOUNDARY_MAX_OUTPUT_TOKENS,
      label: adapter.generateLabel("repair"),
    });
    return validateBoundarySegments(repairedOutput, messageCount);
  } catch {
    return undefined;
  }
}

/**
 * The candidate window is contiguous, so only slices whose raw id range or
 * effective-time span can intersect it are relevant — loading the whole
 * conversation history here would make every pass O(all slices).
 */
async function ensureNoOverlap(
  db: Kysely<DB>,
  adapter: ChunkStreamAdapter,
  planned: PlannedBoundarySlice[],
  ignoredOpenId: string | undefined,
): Promise<void> {
  if (planned.length === 0) return;
  const minMessageId = Math.min(...planned.map((candidate) => candidate.firstMessageId));
  const maxMessageId = Math.max(...planned.map((candidate) => candidate.lastMessageId));
  const minStartedAt = planned.reduce(
    (min, candidate) => (candidate.startedAt < min ? candidate.startedAt : min),
    planned[0].startedAt,
  );
  const maxEndedAt = planned.reduce(
    (max, candidate) => (candidate.endedAt > max ? candidate.endedAt : max),
    planned[0].endedAt,
  );
  const existing = await db
    .selectFrom("conversation_slices")
    .selectAll()
    .where("conversation_id", "=", adapter.conversationId)
    .where((eb) =>
      eb.or([
        eb("provider_thread_id", "=", adapter.providerThreadId),
        eb.and([
          eb("provider_thread_id", "is", null),
          eb(eb.cast(eb.val(adapter.providerThreadId), "text"), "is", null),
        ]),
      ]),
    )
    .where("origin", "=", adapterOrigin(adapter))
    .where((eb) =>
      adapter.order === "row_id"
        ? eb.and([eb("first_message_id", "<=", maxMessageId), eb("last_message_id", ">=", minMessageId)])
        : eb.and([
            eb("first_message_id", "<=", maxMessageId),
            eb("last_message_id", ">=", minMessageId),
            eb("started_at", "<=", maxEndedAt),
            eb("ended_at", ">=", minStartedAt),
          ]),
    )
    .execute();
  for (const candidate of planned) {
    const exact = existing.find((row) => row.status === "closed" && sliceHasSameContent(row, candidate));
    if (exact) continue;
    const overlap = existing.some((row) => {
      if (row.id === ignoredOpenId || (row.status === "open" && row.id === ignoredOpenId)) return false;
      if (row.last_message_id < candidate.firstMessageId || row.first_message_id > candidate.lastMessageId)
        return false;
      return adapter.order === "row_id" || (row.started_at <= candidate.endedAt && row.ended_at >= candidate.startedAt);
    });
    if (overlap) throw new OverlapGuardError();
  }
}

async function persistPlannedSlice(
  db: Kysely<DB>,
  adapter: ChunkStreamAdapter,
  planned: PlannedBoundarySlice,
  rosterSnapshot: string,
  status: "open" | "closed",
  flushKind: "boundary" | "force_split",
): Promise<ConversationSliceRow> {
  const repo = createConversationSlicesRepository(db);
  const inserted = await repo.insertIfAbsent({
    id: randomUUID(),
    conversationId: adapter.conversationId,
    firstMessageId: planned.firstMessageId,
    lastMessageId: planned.lastMessageId,
    startedAt: planned.startedAt,
    endedAt: planned.endedAt,
    messageCount: planned.messageCount,
    denoisedMessageIds: planned.denoisedMessageIds,
    flushReason: adapter.flushReason(flushKind),
    rosterSnapshot,
    salienceVerdict: "kept",
    providerThreadId: adapter.providerThreadId,
    status,
    origin: adapterOrigin(adapter),
  });
  if (inserted.row.status !== status) throw new OverlapGuardError();
  return inserted.row;
}

async function applyBoundaryWindow(
  deps: ChunkEngineDeps,
  params: { adapter: ChunkStreamAdapter; claimToken: string },
  state: BoundaryWindow,
  segments: BoundarySegment[],
  originalBoundaryEnds: ReadonlySet<number>,
  rosterSnapshot: string,
): Promise<ApplyResult> {
  const sortedRaw = state.allRaw;
  const planned = segments.map((segment) =>
    buildPlannedSlice(sortedRaw, state.messages, segment, params.adapter.order),
  );
  const previousOpen = state.open;
  const newCursorMessage =
    state.newMessages.find((message) => message.id === state.messages[state.messages.length - 1]?.id) ??
    state.newMessages[0];
  const cursorMessage = state.messages[state.messages.length - 1];
  const messagesProcessed = cursorMessage
    ? state.allRaw.filter(
        (message) =>
          params.adapter.cursor.isAfterCursor(message, state.cursor) &&
          isAtOrBefore(params.adapter, message, cursorMessage),
      ).length
    : 0;
  const applyResult = await deps.db.transaction().execute(async (trx) => {
    const sliceRepo = createConversationSlicesRepository(trx);
    const currentCursor = await params.adapter.cursor.get(trx);
    if (
      !currentCursor ||
      currentCursor.claimToken !== params.claimToken ||
      !params.adapter.cursor.matches(currentCursor, state.cursor)
    ) {
      throw new ClaimLostError();
    }
    const currentOpen = await sliceRepo.getOpenSlice(
      params.adapter.conversationId,
      params.adapter.providerThreadId,
      adapterOrigin(params.adapter),
    );
    if (currentOpen?.id !== previousOpen?.id) throw new ClaimLostError();
    await ensureNoOverlap(trx, params.adapter, planned, previousOpen?.id);
    const topicRepo = params.adapter.usesTopicRegistry ? createConversationTopicsRepository(trx) : undefined;
    const topicIdsBySegment: string[][] = [];
    for (const item of planned) {
      const topicIds: string[] = [];
      for (const thread of params.adapter.usesTopicRegistry ? item.threads : []) {
        if (!topicRepo) throw new Error("Topic registry is unavailable");
        const topic = await topicRepo.upsertTopic({
          conversationId: params.adapter.conversationId,
          name: thread,
          activityAt: item.endedAt,
          recordMerge: true,
        });
        topicIds.push(topic.topic.id);
      }
      topicIdsBySegment.push(topicIds);
    }

    let closed = 0;
    let openSliceId: string | null = null;
    if (planned.length === 1 && previousOpen) {
      const requeueLinkedFile =
        previousOpen.indexed_file_id !== null &&
        parseDenoisedIds(previousOpen).some((id) => !planned[0].denoisedMessageIds.includes(id));
      const updated = await sliceRepo.updateOpenSlice({
        sliceId: previousOpen.id,
        firstMessageId: planned[0].firstMessageId,
        lastMessageId: planned[0].lastMessageId,
        startedAt: planned[0].startedAt,
        endedAt: planned[0].endedAt,
        messageCount: planned[0].messageCount,
        denoisedMessageIds: planned[0].denoisedMessageIds,
        rosterSnapshot,
      });
      if (!updated) throw new ClaimLostError();
      if (requeueLinkedFile) {
        const unlinked = await trx
          .updateTable("conversation_slices")
          .set({ indexed_file_id: null })
          .where("id", "=", previousOpen.id)
          .executeTakeFirst();
        if (Number(unlinked.numUpdatedRows ?? 0) !== 1) throw new ClaimLostError();
      }
      await topicRepo?.replaceSliceTopics(updated.id, topicIdsBySegment[0] ?? []);
      openSliceId = updated.id;
    } else {
      for (let index = 0; index < planned.length - 1; index += 1) {
        const item = planned[index];
        if (!item) continue;
        let closedSlice: ConversationSliceRow;
        if (index === 0 && previousOpen) {
          const flushKind = originalBoundaryEnds.has(segments[index]?.end ?? -1) ? "boundary" : "force_split";
          const requeueLinkedFile = previousOpen.indexed_file_id !== null && !sliceHasSameContent(previousOpen, item);
          const closedExisting = await sliceRepo.closeOpenSlice(previousOpen.id, params.adapter.flushReason(flushKind));
          if (!closedExisting) throw new ClaimLostError();
          closedSlice = {
            ...closedExisting,
            first_message_id: item.firstMessageId,
            last_message_id: item.lastMessageId,
            started_at: item.startedAt,
            ended_at: item.endedAt,
            message_count: item.messageCount,
            denoised_message_ids: JSON.stringify(item.denoisedMessageIds),
            roster_snapshot: rosterSnapshot,
          };
          const updated = await trx
            .updateTable("conversation_slices")
            .set({
              first_message_id: item.firstMessageId,
              last_message_id: item.lastMessageId,
              started_at: item.startedAt,
              ended_at: item.endedAt,
              message_count: item.messageCount,
              denoised_message_ids: JSON.stringify(item.denoisedMessageIds),
              roster_snapshot: rosterSnapshot,
              ...(requeueLinkedFile ? { indexed_file_id: null } : {}),
            })
            .where("id", "=", previousOpen.id)
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows ?? 0) !== 1) throw new ClaimLostError();
          closedSlice = (await sliceRepo.getById(previousOpen.id)) as ConversationSliceRow;
        } else {
          const existing = await trx
            .selectFrom("conversation_slices")
            .selectAll()
            .where("conversation_id", "=", params.adapter.conversationId)
            .where((eb) =>
              params.adapter.providerThreadId === null
                ? eb("provider_thread_id", "is", null)
                : eb("provider_thread_id", "=", params.adapter.providerThreadId),
            )
            .where("first_message_id", "=", item.firstMessageId)
            .where("status", "=", "closed")
            .where("origin", "=", adapterOrigin(params.adapter))
            .executeTakeFirst();
          if (existing && !sliceHasSameContent(existing, item)) throw new OverlapGuardError();
          const reusedExisting = Boolean(existing);
          closedSlice =
            existing ??
            (await persistPlannedSlice(
              trx,
              params.adapter,
              item,
              rosterSnapshot,
              "closed",
              originalBoundaryEnds.has(segments[index]?.end ?? -1) ? "boundary" : "force_split",
            ));
          if (reusedExisting) {
            closed += 1;
            continue;
          }
        }
        await topicRepo?.replaceSliceTopics(closedSlice.id, topicIdsBySegment[index] ?? []);
        await params.adapter.onSliceClosed?.(trx, closedSlice);
        closed += 1;
      }

      const last = planned[planned.length - 1];
      if (!last) throw new Error("No final chunk segment");
      const insertedOpen = await persistPlannedSlice(trx, params.adapter, last, rosterSnapshot, "open", "boundary");
      await topicRepo?.replaceSliceTopics(insertedOpen.id, topicIdsBySegment[planned.length - 1] ?? []);
      openSliceId = insertedOpen.id;
    }

    if (!cursorMessage || !newCursorMessage) throw new Error("Chunk window has no new message");
    const advanced = await params.adapter.cursor.advance(trx, {
      message: cursorMessage,
      claimToken: params.claimToken,
    });
    if (!advanced) throw new ClaimLostError();
    const renewed = await params.adapter.cursor.renew(trx, {
      claimToken: params.claimToken,
      now: nowIso(deps),
    });
    if (!renewed) throw new ClaimLostError();

    const finalPlanned = planned[planned.length - 1];
    if (!finalPlanned) throw new Error("No final chunk segment");
    const shrank =
      previousOpen?.indexed_file_id &&
      parseDenoisedIds(previousOpen).some((id) => !finalPlanned.denoisedMessageIds.includes(id))
        ? previousOpen.indexed_file_id
        : null;
    return {
      closed,
      openSliceId,
      messagesProcessed,
      shrunkIndexedFileId: shrank,
    };
  });

  if (applyResult.shrunkIndexedFileId) await deps.onOpenChunkShrunk?.(applyResult.shrunkIndexedFileId);
  return applyResult;
}

async function advanceNoiseCursor(
  deps: ChunkEngineDeps,
  adapter: ChunkStreamAdapter,
  claimToken: string,
  cursor: ChunkCursorState,
  message: SortableMessage,
): Promise<void> {
  await deps.db.transaction().execute(async (trx) => {
    const current = await adapter.cursor.get(trx);
    if (!current || current.claimToken !== claimToken || !adapter.cursor.matches(current, cursor))
      throw new ClaimLostError();
    const advanced = await adapter.cursor.advance(trx, { message, claimToken });
    if (!advanced) throw new ClaimLostError();
    if (!(await adapter.cursor.renew(trx, { claimToken, now: nowIso(deps) }))) throw new ClaimLostError();
  });
}

async function decideAndApply(
  deps: ChunkEngineDeps,
  params: { adapter: ChunkStreamAdapter; claimToken: string },
  state: BoundaryWindow,
): Promise<ApplyResult | undefined> {
  const openIds = new Set(state.openMessages.map((message) => message.id));
  let initial: BoundarySegment[] | undefined;
  if (params.adapter.boundaries === "single-segment") {
    initial = [{ start: 1, end: state.messages.length, threads: [] }];
  } else {
    const registry = params.adapter.usesTopicRegistry
      ? await createConversationTopicsRepository(deps.db).listPromptRegistry(
          params.adapter.conversationId,
          state.messages[state.messages.length - 1]?.effectiveAt ?? nowIso(deps),
          params.adapter.knobs.topicRegistryCap,
        )
      : [];
    const prompt = renderBoundaryPrompt(params.adapter.promptHeader, registry, state.messages, openIds);
    initial = await generateBoundarySegments(deps, params.adapter, prompt, params.adapter.knobs, state.messages.length);
  }
  if (!initial) return undefined;
  const normalized = enforceBoundarySize(initial, state.messages, params.adapter.knobs);
  let rosterSnapshot = state.open?.roster_snapshot ?? "[]";
  try {
    rosterSnapshot = await params.adapter.rosterSnapshot(deps.db);
  } catch {}
  return applyBoundaryWindow(
    deps,
    params,
    state,
    normalized,
    new Set(initial.slice(0, -1).map((segment) => segment.end)),
    rosterSnapshot,
  );
}

function emptyResult(openSliceId: string | null, skippedReason?: string) {
  return {
    windowsProcessed: 0,
    slicesClosed: 0,
    messagesProcessed: 0,
    pendingRemaining: skippedReason !== undefined,
    openSliceId,
    ...(skippedReason ? { skippedReason } : {}),
  };
}

export async function runChunkingPass(
  deps: ChunkEngineDeps,
  params: {
    adapter: ChunkStreamAdapter;
    mode: "live" | "backfill";
    maxWindows?: number;
    pendingUntil?: ChunkPendingBound;
    historyStartId?: number | null;
    onPassClaimed?: (claim: { claimToken: string }) => Promise<void>;
    onPassComplete?: (completion: {
      claimToken: string;
      pendingSinceAtClaim: string | null;
      pendingRemaining: boolean;
      skippedReason?: string;
    }) => Promise<void>;
  },
): Promise<{
  windowsProcessed: number;
  slicesClosed: number;
  messagesProcessed: number;
  pendingRemaining: boolean;
  openSliceId: string | null;
  skippedReason?: string;
}> {
  const claimToken = randomUUID();
  const claimNow = nowIso(deps);
  const claimed = await params.adapter.cursor.claim(deps.db, {
    claimToken,
    now: claimNow,
    staleBefore: new Date(nowMs(deps) - CLAIM_STALE_MS).toISOString(),
  });
  if (!claimed) return emptyResult(null, "claim_unavailable");
  const claimedCursor = await params.adapter.cursor.get(deps.db);
  const pendingSinceAtClaim = claimedCursor?.pendingSince ?? null;

  let windowsProcessed = 0;
  let slicesClosed = 0;
  let messagesProcessed = 0;
  let budgetUsed = 0;
  let lastPageFull = false;
  let openSliceId: string | null = null;
  let historyStartId = params.historyStartId;
  let skippedReason: string | undefined;
  const maxWindows = Math.max(1, params.maxWindows ?? params.adapter.knobs.maxWindowsPerRun);
  try {
    await params.onPassClaimed?.({ claimToken });
    try {
      while (budgetUsed < maxWindows) {
        const state = await loadWindow(
          deps.db,
          params.adapter,
          params.mode,
          params.pendingUntil,
          params.historyStartId,
        );
        budgetUsed += 1;
        lastPageFull = state.pageFull;
        openSliceId = state.open?.id ?? null;
        historyStartId = state.open?.first_message_id ?? historyStartId;
        const pendingRaw = state.allRaw.filter(
          (message) =>
            params.adapter.cursor.isAfterCursor(message, state.cursor) &&
            (!params.pendingUntil || isAtOrBefore(params.adapter, message, params.pendingUntil)),
        );
        if (state.newMessages.length === 0) {
          const lastPendingRaw = pendingRaw[pendingRaw.length - 1];
          if (lastPendingRaw) {
            await advanceNoiseCursor(deps, params.adapter, claimToken, state.cursor, lastPendingRaw);
            messagesProcessed += pendingRaw.length;
          }
          if (state.pageFull) continue;
          break;
        }

        const suffix = state.messages.slice(state.openMessages.length);
        const fullState = { ...state, messages: [...state.openMessages, ...suffix] };
        const applied = await decideAndApply(deps, { adapter: params.adapter, claimToken }, fullState);
        if (applied) {
          windowsProcessed += 1;
          slicesClosed += applied.closed;
          messagesProcessed += applied.messagesProcessed;
          openSliceId = applied.openSliceId;
          continue;
        }

        if (suffix.length <= 1) {
          skippedReason = "boundary_validation_failed";
          logBoundaryValidationFailure(deps.logger, params.adapter, params.mode);
          break;
        }

        const splitAt = Math.ceil(suffix.length / 2);
        const firstState = { ...state, messages: [...state.openMessages, ...suffix.slice(0, splitAt)] };
        const firstApplied = await decideAndApply(deps, { adapter: params.adapter, claimToken }, firstState);
        if (!firstApplied) {
          skippedReason = "boundary_validation_failed";
          logBoundaryValidationFailure(deps.logger, params.adapter, params.mode);
          break;
        }
        windowsProcessed += 1;
        slicesClosed += firstApplied.closed;
        messagesProcessed += firstApplied.messagesProcessed;
        openSliceId = firstApplied.openSliceId;
        if (budgetUsed >= maxWindows) break;

        const secondState = await loadWindow(
          deps.db,
          params.adapter,
          params.mode,
          params.pendingUntil,
          params.historyStartId,
        );
        budgetUsed += 1;
        lastPageFull = secondState.pageFull;
        historyStartId = secondState.open?.first_message_id ?? historyStartId;
        const secondApplied = await decideAndApply(deps, { adapter: params.adapter, claimToken }, secondState);
        if (!secondApplied) {
          skippedReason = "boundary_validation_failed";
          logBoundaryValidationFailure(deps.logger, params.adapter, params.mode);
          break;
        }
        windowsProcessed += 1;
        slicesClosed += secondApplied.closed;
        messagesProcessed += secondApplied.messagesProcessed;
        openSliceId = secondApplied.openSliceId;
      }
    } catch (error) {
      if (error instanceof ClaimLostError) skippedReason = "claim_lost";
      else if (error instanceof OverlapGuardError) skippedReason = "overlap_guard";
      else throw error;
    }
    const finalCursor = await params.adapter.cursor.get(deps.db);
    const pendingRemaining =
      skippedReason !== undefined ||
      lastPageFull ||
      (budgetUsed >= maxWindows &&
        finalCursor !== undefined &&
        (await params.adapter.nextPendingMessage(deps.db, finalCursor, {
          mode: params.mode,
          pendingUntil: params.pendingUntil,
          historyStartId,
        })) !== undefined);
    await params.onPassComplete?.({
      claimToken,
      pendingSinceAtClaim,
      pendingRemaining,
      skippedReason,
    });
    return {
      windowsProcessed,
      slicesClosed,
      messagesProcessed,
      pendingRemaining,
      openSliceId,
      ...(skippedReason ? { skippedReason } : {}),
    };
  } finally {
    await params.adapter.cursor.release(deps.db, { claimToken });
  }
}

export async function evaluateIdleClose(
  deps: ChunkEngineDeps,
  params: { adapter: ChunkStreamAdapter; mode: "live" | "backfill"; pendingUntil?: ChunkPendingBound },
): Promise<boolean> {
  const claimToken = randomUUID();
  const now = nowMs(deps);
  const claimed = await params.adapter.cursor.claim(deps.db, {
    claimToken,
    now: new Date(now).toISOString(),
    staleBefore: new Date(now - CLAIM_STALE_MS).toISOString(),
  });
  if (!claimed) return false;
  try {
    return await deps.db.transaction().execute(async (trx) => {
      const sliceRepo = createConversationSlicesRepository(trx);
      const cursor = await params.adapter.cursor.get(trx);
      const open = await sliceRepo.getOpenSlice(
        params.adapter.conversationId,
        params.adapter.providerThreadId,
        adapterOrigin(params.adapter),
      );
      if (!cursor || cursor.claimToken !== claimToken || !open) return false;
      const tailIds = parseDenoisedIds(open);
      const tailId = tailIds[tailIds.length - 1];
      if (tailId === undefined) return false;
      const tail = await params.adapter.tailMessage(trx, tailId);
      if (!tail) return false;
      let nextPending: SortableMessage | undefined;
      if (params.mode === "backfill") {
        const loaded = await params.adapter.nextPendingMessage(trx, cursor, {
          mode: params.mode,
          pendingUntil: params.pendingUntil,
          historyStartId: open.first_message_id,
        });
        nextPending = loaded ? sortMessages([loaded], params.adapter)[0] : undefined;
      }
      const idleMs = params.adapter.knobs.idleCloseHours * 60 * 60 * 1000;
      const isIdle =
        params.mode === "live"
          ? now - Date.parse(tail.receivedAt) > idleMs
          : (nextPending?.effectiveMs ?? Number.NaN) - effectiveMs(tail.effectiveAt) > idleMs;
      if (!isIdle) return false;
      const closed = await sliceRepo.closeOpenSlice(open.id, params.adapter.flushReason("idle"));
      if (!closed) throw new ClaimLostError();
      await params.adapter.onSliceClosed?.(trx, closed);
      return true;
    });
  } finally {
    await params.adapter.cursor.release(deps.db, { claimToken });
  }
}
