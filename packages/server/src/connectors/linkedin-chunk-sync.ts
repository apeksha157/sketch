import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { DB } from "../db/schema";
import type { AimfoxMessage } from "./aimfox-client";
import type { ChunkEngineKnobs } from "./chunk-engine";
import type { ChunkGenerate } from "./chunk-generate";
import {
  type LinkedinChunkRosterSnapshot,
  loadPendingLinkedinHistory,
  parseLinkedinChunkRosterSnapshot,
} from "./linkedin-chunk-adapter";
import {
  linkedinIdleCloseCandidatesQuery,
  linkedinPendingHistoryCandidatesQuery,
  runLinkedinChunkConversation,
} from "./linkedin-chunk-runner";
import { LINKEDIN_CONVERSATION_FILE_TYPE } from "./linkedin-emission";
import {
  LINKEDIN_CONVERSATION_KIND,
  LINKEDIN_CONVERSATION_PLATFORM,
  ingestLinkedinConversation,
  linkedinProviderConversationId,
  parseLinkedinProviderConversationId,
} from "./linkedin-ingest";
import { forEachChunk } from "./sync-utils";

/** Legacy burst-segment files, identified by the id shape the segmenter mints. */
const LEGACY_SEGMENT_PROVIDER_FILE_ID_PATTERN = "linkedin:%:segment-%";

export interface LinkedinEngineArchiveDeps {
  db: Kysely<DB>;
  logger: Logger;
  connectorConfigId: string;
}

export interface LinkedinEngineDeps extends LinkedinEngineArchiveDeps {
  knobs: ChunkEngineKnobs;
  generate: ChunkGenerate;
  now: Date;
  /** `LINKEDIN_CHUNK_SWEEP_CONVERSATIONS_PER_RUN`, the per-run bound on the listing-independent sweep. */
  sweepConversationsPerRun: number;
}

interface LinkedinEngineConversationRun {
  conversationId: number;
  /** The runner could not drain the backlog; legacy files stay until it can. */
  historyPending: boolean;
}

/** One account's engine work for one sync run: what was ticked, and what moved. */
export interface LinkedinEngineAccountRun {
  accountId: string;
  conversations: Map<string, LinkedinEngineConversationRun>;
  /** Conversations whose legacy generation this run archived. */
  moved: Set<string>;
  /** Conversations the sweep reached rather than the provider listing. */
  swept: number;
}

export function createLinkedinEngineAccountRun(accountId: string): LinkedinEngineAccountRun {
  return { accountId, conversations: new Map(), moved: new Set(), swept: 0 };
}

export interface LinkedinEngineRouting {
  /** Conversations the engine owns this run. */
  engineConversationUrns: Set<string>;
  /**
   * Row ids for the engine-owned conversations that already have a
   * `conversations` row. A brand-new one is absent until its ingest mints it.
   */
  engineConversationIds: Map<string, number>;
  /**
   * Conversations the legacy segmenter must not write for, because engine files
   * already cover them and a fresh segment would double the timeline. Only
   * populated when the engine is configured on but cannot run this pass.
   */
  legacyBlocked: Set<string>;
}

const EMPTY_ROUTING: LinkedinEngineRouting = {
  engineConversationUrns: new Set(),
  engineConversationIds: new Map(),
  legacyBlocked: new Set(),
};

export function emptyLinkedinEngineRouting(): LinkedinEngineRouting {
  return EMPTY_ROUTING;
}

/**
 * D13. With the engine runnable, every conversation chunks on it except the
 * ones that predate it: a `conversations` row means the engine already owns the
 * thread, and a conversation without one still goes to the engine unless it
 * carries live legacy segment files. Those are the pre-engine threads awaiting
 * a reindex, and the segmenter keeps them — new replies included — until one
 * moves them. Both facts are durable database state rather than cursor markers
 * a crash can lose, and both are read one batch per listing.
 *
 * With the engine configured on but unable to run, nothing routes to it and the
 * only job left is keeping the segmenter off live engine files.
 */
export async function resolveLinkedinEngineRouting(
  deps: LinkedinEngineArchiveDeps | null,
  input: { accountId: string; conversationUrns: string[]; engineRunnable: boolean },
): Promise<LinkedinEngineRouting> {
  if (!deps || input.conversationUrns.length === 0) return EMPTY_ROUTING;
  const repo = createConnectorRepository(deps.db);
  const conversationIds = await resolveConversationIds(deps.db, input.accountId, input.conversationUrns);

  if (input.engineRunnable) {
    const unmigrated = [...new Set(input.conversationUrns)].filter(
      (conversationUrn) => !conversationIds.has(conversationUrn),
    );
    const withLegacyFiles = await repo.listThreadsWithLiveFilesByProviderFileIdPattern({
      connectorConfigId: deps.connectorConfigId,
      fileType: LINKEDIN_CONVERSATION_FILE_TYPE,
      threadIds: unmigrated.map((conversationUrn) => linkedinProviderConversationId(input.accountId, conversationUrn)),
      providerFileIdPattern: LEGACY_SEGMENT_PROVIDER_FILE_ID_PATTERN,
    });
    const engineConversationUrns = new Set(conversationIds.keys());
    for (const conversationUrn of unmigrated) {
      const threadId = linkedinProviderConversationId(input.accountId, conversationUrn);
      if (!withLegacyFiles.has(threadId)) engineConversationUrns.add(conversationUrn);
    }
    return { engineConversationUrns, engineConversationIds: conversationIds, legacyBlocked: new Set() };
  }

  const withEngineFiles = await repo.listConversationsWithLiveSliceFiles({
    connectorConfigId: deps.connectorConfigId,
    fileType: LINKEDIN_CONVERSATION_FILE_TYPE,
    conversationIds: [...conversationIds.values()],
  });
  const legacyBlocked = new Set<string>();
  for (const [conversationUrn, conversationId] of conversationIds) {
    if (withEngineFiles.has(conversationId)) legacyBlocked.add(conversationUrn);
  }
  return { engineConversationUrns: new Set(), engineConversationIds: new Map(), legacyBlocked };
}

/**
 * D3's source rule, read off the database rather than off a cursor marker: a
 * conversation the engine has never chunked, or one whose backlog is still
 * undrained, takes `history` so the whole backlog is judged by message gaps
 * rather than by the wall clock. Only a conversation the engine has caught up
 * with takes `live`. A conversation with no row at all has never been chunked,
 * so it starts on `history` without a query.
 */
export async function linkedinIngestSource(
  db: Kysely<DB>,
  conversationId: number | undefined,
): Promise<"history" | "live"> {
  if (conversationId === undefined) return "history";
  const pending = await loadPendingLinkedinHistory(db, conversationId, 1);
  return !pending.chunked || pending.rows.length > 0 ? "history" : "live";
}

export interface LinkedinEngineConversationInput {
  /** Absent for a brand-new conversation; the ingest mints the row. */
  conversationId: number | undefined;
  conversationUrn: string;
  leadId: string;
  leadName: string;
  ownerName: string;
  messages: AimfoxMessage[];
}

/** Ingests one conversation's messages and runs the engine over it. */
export async function runLinkedinEngineConversation(
  deps: LinkedinEngineDeps,
  run: LinkedinEngineAccountRun,
  input: LinkedinEngineConversationInput,
): Promise<void> {
  const roster: LinkedinChunkRosterSnapshot = {
    accountId: run.accountId,
    conversationUrn: input.conversationUrn,
    leadId: input.leadId,
    leadName: input.leadName,
    ownerName: input.ownerName,
  };
  const ingested = await ingestLinkedinConversation({
    db: deps.db,
    accountId: run.accountId,
    conversationUrn: input.conversationUrn,
    leadName: input.leadName,
    messages: input.messages,
    source: await linkedinIngestSource(deps.db, input.conversationId),
    receivedAt: deps.now.toISOString(),
  });
  await tickLinkedinEngineConversation(deps, run, input.conversationUrn, ingested.conversationId, roster);
}

/**
 * One conversation's pass over the engine, plus the bookkeeping the cutover
 * reads back. The listing reaches it through an ingest; the sweep reaches it
 * with the roster the engine already stored. Nothing else may call the runner,
 * or a conversation could be ticked without becoming a cutover candidate.
 */
async function tickLinkedinEngineConversation(
  deps: LinkedinEngineDeps,
  run: LinkedinEngineAccountRun,
  conversationUrn: string,
  conversationId: number,
  roster: LinkedinChunkRosterSnapshot,
): Promise<void> {
  const result = await runLinkedinChunkConversation({
    db: deps.db,
    logger: deps.logger,
    now: deps.now,
    conversationId,
    roster,
    knobs: deps.knobs,
    generate: deps.generate,
  });
  run.conversations.set(conversationUrn, { conversationId, historyPending: result.historyPendingRemaining });
}

/**
 * The half of the engine's work the provider listing cannot reach.
 *
 * A conversation leaves the Aimfox listing as soon as the run watermark passes
 * its last activity, so nothing would otherwise drive a backlog that outlived
 * one run's window budget, and nothing would close an open tail that simply
 * goes quiet: stale legacy files forever, and the idle-close wall never firing.
 * Both candidate sets are read off the database instead, and ticked through the
 * same per-conversation path the listing uses — which is also what makes each
 * one a cutover candidate again, so a half-moved conversation converges.
 *
 * A conversation with no slice to read a roster from is skipped: the engine has
 * never cut it, so there is nothing to resume and nothing to close. The reindex
 * path carries its own roster and does not depend on this.
 */
export async function sweepLinkedinEngineConversations(
  deps: LinkedinEngineDeps,
  runs: ReadonlyMap<string, LinkedinEngineAccountRun>,
): Promise<void> {
  const budget = Math.max(0, deps.sweepConversationsPerRun);
  if (budget === 0 || runs.size === 0) return;
  const idleBefore = new Date(deps.now.getTime() - deps.knobs.idleCloseHours * 60 * 60_000).toISOString();
  const [pendingHistory, idle] = await Promise.all([
    linkedinPendingHistoryCandidatesQuery(deps.db, budget).execute(),
    linkedinIdleCloseCandidatesQuery(deps.db, idleBefore).limit(budget).execute(),
  ]);
  const candidateIds = [...new Set([...pendingHistory, ...idle].map((row) => row.conversation_id))];

  let swept = 0;
  for (const candidate of await resolveSweepCandidates(deps.db, runs, candidateIds)) {
    if (swept >= budget) break;
    const roster = await latestRosterSnapshot(deps.db, candidate.conversationId);
    if (!roster) {
      deps.logger.debug(
        { accountId: candidate.run.accountId, conversationUrn: candidate.conversationUrn },
        "Skipped sweeping a LinkedIn conversation with no stored roster snapshot",
      );
      continue;
    }
    swept += 1;
    candidate.run.swept += 1;
    await tickLinkedinEngineConversation(
      deps,
      candidate.run,
      candidate.conversationUrn,
      candidate.conversationId,
      roster,
    );
  }
}

interface LinkedinSweepCandidate {
  run: LinkedinEngineAccountRun;
  conversationUrn: string;
  conversationId: number;
}

/**
 * Candidate rows narrowed to conversations this run's accounts own and has not
 * already ticked. The sweep is run-level rather than per account so one budget
 * cannot be spent entirely on whichever account happens to sort first.
 */
async function resolveSweepCandidates(
  db: Kysely<DB>,
  runs: ReadonlyMap<string, LinkedinEngineAccountRun>,
  conversationIds: number[],
): Promise<LinkedinSweepCandidate[]> {
  if (conversationIds.length === 0) return [];
  const candidates: LinkedinSweepCandidate[] = [];
  await forEachChunk(conversationIds, async (batch) => {
    const rows = await db
      .selectFrom("conversations")
      .select(["id", "provider_conversation_id"])
      .where("id", "in", batch)
      .execute();
    for (const row of rows) {
      const parsed = parseLinkedinProviderConversationId(row.provider_conversation_id);
      const run = parsed ? runs.get(parsed.accountId) : undefined;
      if (!parsed || !run || run.conversations.has(parsed.conversationUrn)) continue;
      candidates.push({ run, conversationUrn: parsed.conversationUrn, conversationId: row.id });
    }
  });
  return candidates;
}

/**
 * The roster the engine stored on this conversation's newest slice. Every slice
 * of a conversation carries the same snapshot, so the newest is simply the
 * freshest spelling of the lead and owner names.
 */
async function latestRosterSnapshot(
  db: Kysely<DB>,
  conversationId: number,
): Promise<LinkedinChunkRosterSnapshot | null> {
  const row = await db
    .selectFrom("conversation_slices")
    .select("roster_snapshot")
    .where("conversation_id", "=", conversationId)
    .orderBy("first_message_id", "desc")
    .limit(1)
    .executeTakeFirst();
  return parseLinkedinChunkRosterSnapshot(row?.roster_snapshot ?? null);
}

export interface LinkedinCutoverFinalizeInput {
  /**
   * Conversations whose slices the emitter looked at this run, beyond the
   * ticked ones — visits, not yields. A conversation whose engine generation is
   * already published in full yields nothing, and that is precisely the one
   * whose archive has to be retried after a crash between the two.
   */
  visitedConversationUrns: Iterable<string>;
  /** Whether every item yielded for a conversation this run reached the database. */
  isPersisted: (conversationUrn: string) => boolean;
}

/**
 * Closes the cutover for every conversation the run touched: archive its legacy
 * segment files once the engine generation covers the thread in full.
 *
 * The archive is unconditional rather than state-gated — any touched
 * conversation that has a live engine file gets it — so an archive lost to a
 * crash between publication and this pass converges on the next run with
 * nothing re-cut. It is held back only while the conversation's own state says
 * the timeline would suffer: an undrained history backlog (the engine covers a
 * prefix, legacy covers the whole thread), or an item of this run that failed
 * to persist. Both retry next run.
 */
export async function finalizeLinkedinCutover(
  deps: LinkedinEngineArchiveDeps,
  run: LinkedinEngineAccountRun,
  input: LinkedinCutoverFinalizeInput,
): Promise<number> {
  const candidates = new Set<string>(input.visitedConversationUrns);
  for (const [conversationUrn, conversation] of run.conversations) {
    if (conversation.historyPending) candidates.delete(conversationUrn);
    else candidates.add(conversationUrn);
  }

  const eligible = [...candidates].filter(input.isPersisted);
  const conversationIds = await resolveConversationIds(deps.db, run.accountId, eligible, run.conversations);
  const repo = createConnectorRepository(deps.db);
  const withEngineFiles = await repo.listConversationsWithLiveSliceFiles({
    connectorConfigId: deps.connectorConfigId,
    fileType: LINKEDIN_CONVERSATION_FILE_TYPE,
    conversationIds: [...conversationIds.values()],
  });

  let archived = 0;
  for (const conversationUrn of eligible) {
    const conversationId = conversationIds.get(conversationUrn);
    if (conversationId === undefined || !withEngineFiles.has(conversationId)) continue;
    archived += await repo.archiveThreadFilesByProviderFileIdPattern({
      connectorConfigId: deps.connectorConfigId,
      fileType: LINKEDIN_CONVERSATION_FILE_TYPE,
      threadId: linkedinProviderConversationId(run.accountId, conversationUrn),
      providerFileIdPattern: LEGACY_SEGMENT_PROVIDER_FILE_ID_PATTERN,
    });
    run.moved.add(conversationUrn);
  }
  return archived;
}

export interface LinkedinRollbackInput {
  accountId: string;
  /** Conversations the legacy segmenter yielded items for this run. */
  conversationUrns: Iterable<string>;
  /**
   * Whether this run actually put legacy files on the timeline for the
   * conversation. "Nothing failed" is not enough: a thread with no usable lead
   * seed, or one whose inbound message has yet to arrive, yields no item at
   * all, and archiving its engine files would leave it with neither generation.
   */
  hasPersistedLegacySegments: (conversationUrn: string) => boolean;
}

/**
 * The mirror of the cutover (D10). With the engine flag off, a conversation
 * whose legacy segments have persisted again has its engine files archived.
 * Archiving clears `conversation_slices.indexed_file_id`, so flipping the flag
 * back on re-emits exactly those slices and the cutover runs again — neither
 * direction can leave both generations on the timeline once a run has touched
 * the conversation.
 */
export async function rollbackLinkedinConversations(
  deps: LinkedinEngineArchiveDeps,
  input: LinkedinRollbackInput,
): Promise<number> {
  const eligible = [...input.conversationUrns].filter(input.hasPersistedLegacySegments);
  if (eligible.length === 0) return 0;

  const conversationIds = await resolveConversationIds(deps.db, input.accountId, eligible);
  const repo = createConnectorRepository(deps.db);
  const withEngineFiles = await repo.listConversationsWithLiveSliceFiles({
    connectorConfigId: deps.connectorConfigId,
    fileType: LINKEDIN_CONVERSATION_FILE_TYPE,
    conversationIds: [...conversationIds.values()],
  });

  let rolledBack = 0;
  for (const conversationUrn of eligible) {
    const conversationId = conversationIds.get(conversationUrn);
    if (conversationId === undefined || !withEngineFiles.has(conversationId)) continue;
    await repo.archiveConversationSliceFiles({
      connectorConfigId: deps.connectorConfigId,
      fileType: LINKEDIN_CONVERSATION_FILE_TYPE,
      conversationId,
    });
    rolledBack += 1;
  }
  return rolledBack;
}

async function resolveConversationIds(
  db: Kysely<DB>,
  accountId: string,
  conversationUrns: string[],
  known?: ReadonlyMap<string, LinkedinEngineConversationRun>,
): Promise<Map<string, number>> {
  const resolved = new Map<string, number>();
  const missing: string[] = [];
  for (const conversationUrn of conversationUrns) {
    const ticked = known?.get(conversationUrn);
    if (ticked) resolved.set(conversationUrn, ticked.conversationId);
    else missing.push(conversationUrn);
  }
  if (missing.length === 0) return resolved;

  const byProviderId = new Map(
    missing.map((conversationUrn) => [linkedinProviderConversationId(accountId, conversationUrn), conversationUrn]),
  );
  await forEachChunk([...byProviderId.keys()], async (batch) => {
    const rows = await db
      .selectFrom("conversations")
      .select(["id", "provider_conversation_id"])
      .where("platform", "=", LINKEDIN_CONVERSATION_PLATFORM)
      .where("kind", "=", LINKEDIN_CONVERSATION_KIND)
      .where("provider_conversation_id", "in", batch)
      .execute();
    for (const row of rows) {
      const conversationUrn = byProviderId.get(row.provider_conversation_id);
      if (conversationUrn) resolved.set(conversationUrn, row.id);
    }
  });
  return resolved;
}
