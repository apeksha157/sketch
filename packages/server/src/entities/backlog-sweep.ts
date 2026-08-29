import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import { normalizeContactPointValue, whereLiveEntity } from "../db/repositories/entities";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { type ResolutionDecision, createResolutionDecisionRepository } from "../db/repositories/resolution-decisions";
import { findActorUserId } from "../db/repositories/user-entity-linking";
import type { DB, EntityReviewQueueTable } from "../db/schema";
import { yieldToEventLoop } from "../lib/event-loop";
import { decideAdjacency, loadAdjacencySignals } from "./adjacency";
import { buildLookupIndex, createEntityLookupFromIndex } from "./materialize-deps";
import { readPersonEmailFromMetadata } from "./materialize-json";
import type { IndexEntityRow } from "./materialize-types";
import { normalizeName } from "./name-keys";
import { type EntityLookup, rank } from "./propose";
import { canUseEntityAsMatchTarget } from "./provenance";
import { linkReviewRowToExistingEntity } from "./resolve";

type QueueRow = Selectable<EntityReviewQueueTable>;

export type BacklogSweepRung = "ledger" | "exact" | "adjacency";

export interface BacklogSweepDeps {
  db: Kysely<DB>;
  logger?: Logger;
}

export interface BacklogSweepOptions {
  apply?: boolean;
}

export interface BacklogSweepResult {
  scanned: number;
  linked: Array<{ reviewId: string; targetEntityId: string; rung: BacklogSweepRung }>;
  blockedByDistinct: number;
  skippedSingleTokenExact: number;
  skippedEmailConflict: number;
  adjacencyContested: number;
  adjacencyVetoed: number;
  unmatched: number;
  multiMatch: number;
}

type PendingDecision =
  | { kind: "link"; reviewId: string; targetEntityId: string; rung: BacklogSweepRung }
  | {
      kind:
        | "blockedByDistinct"
        | "skippedSingleTokenExact"
        | "skippedEmailConflict"
        | "adjacencyContested"
        | "adjacencyVetoed"
        | "unmatched"
        | "multiMatch";
    };

interface LedgerState {
  links: ResolutionDecision[];
  blockedTargetIds: Set<string>;
  dismissed: boolean;
}

/**
 * Per-sweep decision context. The lookup index is the same structure a
 * materializer pass builds (blob-alias matching, match-target provenance
 * pre-filtering), so every rung here sees exactly the candidates
 * proposeEntity's rungs would see against today's graph.
 */
interface SweepContext {
  db: Kysely<DB>;
  lookup: EntityLookup;
  isNameRejectedForEntity: (entityId: string, rejectionKey: string) => Promise<boolean>;
}

function emptyResult(scanned: number): BacklogSweepResult {
  return {
    scanned,
    linked: [],
    blockedByDistinct: 0,
    skippedSingleTokenExact: 0,
    skippedEmailConflict: 0,
    adjacencyContested: 0,
    adjacencyVetoed: 0,
    unmatched: 0,
    multiMatch: 0,
  };
}

function addDecision(result: BacklogSweepResult, decision: PendingDecision): void {
  if (decision.kind === "link") {
    result.linked.push({
      reviewId: decision.reviewId,
      targetEntityId: decision.targetEntityId,
      rung: decision.rung,
    });
    return;
  }
  result[decision.kind] += 1;
}

function isSingleTokenPerson(row: QueueRow): boolean {
  return row.entity_type === "person" && normalizeName(row.proposed_name).split(" ").filter(Boolean).length === 1;
}

async function evidenceFileIds(db: Kysely<DB>, reviewId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("entity_review_evidence")
    .select("indexed_file_id")
    .where("review_id", "=", reviewId)
    .orderBy("seen_at", "asc")
    .orderBy("id", "asc")
    .execute();
  return [...new Set(rows.map((row) => row.indexed_file_id))];
}

async function loadLiveLedgerTarget(db: Kysely<DB>, row: QueueRow, entityId: string | null) {
  if (!entityId) return null;
  const target = await db
    .selectFrom("entities")
    .select(["id", "source_type", "provenance_tier"])
    .where("id", "=", entityId)
    .where("source_type", "=", row.entity_type)
    .where(whereLiveEntity())
    .executeTakeFirst();
  if (!target) return null;
  return canUseEntityAsMatchTarget(target.source_type, target.provenance_tier) ? target : null;
}

async function loadLedgerState(db: Kysely<DB>, row: QueueRow, fileIds: readonly string[]): Promise<LedgerState> {
  const ledger = createResolutionDecisionRepository(db);
  const scopes = ["global", ...fileIds.map((fileId) => `file:${fileId}`)];
  const links: ResolutionDecision[] = [];
  const blockedTargetIds = new Set<string>();
  let dismissed = false;

  for (const scope of scopes) {
    const decisions = await ledger.findActiveForMention(row.normalized_name, row.entity_type, scope);
    for (const decision of decisions.distinct) {
      if (decision.target_entity_id) blockedTargetIds.add(decision.target_entity_id);
    }
    if (decisions.dismiss.length > 0) dismissed = true;
    if (decisions.link?.status === "active") links.push(decisions.link);
  }

  return { links, blockedTargetIds, dismissed };
}

function exactMatches(ctx: SweepContext, row: QueueRow): IndexEntityRow[] {
  const byId = new Map<string, IndexEntityRow>();
  for (const entity of ctx.lookup.getByNormalizedName(row.normalized_name)) {
    if (entity.source_type === row.entity_type) byId.set(entity.id, entity);
  }
  for (const entity of ctx.lookup.getByAlias?.(row.normalized_name) ?? []) {
    if (entity.source_type === row.entity_type) byId.set(entity.id, entity);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * T2 candidate union mirroring proposeEntity's adjacency rung: exact and
 * alias hits, the dedup pool (strict / token-set / edit-distance), and for
 * single-token person mentions the token-superset/prefix ranker over every
 * live person — so rivals like "Rahul Naidu" contest a bare "rahul" instead
 * of the lone exact hit winning by default.
 */
async function adjacencyCandidateIds(
  ctx: SweepContext,
  row: QueueRow,
  exact: readonly IndexEntityRow[],
  ledger: LedgerState,
  rejectionKey: string,
): Promise<string[]> {
  if (row.entity_type !== "person") return [];
  const byId = new Map<string, IndexEntityRow>();
  for (const entity of exact) byId.set(entity.id, entity);
  for (const candidate of ctx.lookup.findNameDedupCandidates?.("person", row.proposed_name) ?? []) {
    byId.set(candidate.entity.id, candidate.entity);
  }
  if (isSingleTokenPerson(row)) {
    for (const candidate of rank("person", row.proposed_name, ctx.lookup.listByType("person"))) {
      byId.set(candidate.entity.id, candidate.entity);
    }
  }
  const ids: string[] = [];
  for (const id of [...byId.keys()].sort()) {
    if (ledger.blockedTargetIds.has(id)) continue;
    if (await ctx.isNameRejectedForEntity(id, rejectionKey)) continue;
    ids.push(id);
  }
  return ids;
}

async function hasEmailConflict(
  db: Kysely<DB>,
  row: QueueRow,
  target: Pick<IndexEntityRow, "id" | "metadata">,
): Promise<boolean> {
  if (row.entity_type !== "person" || !row.proposed_email) return false;
  const proposedEmail = normalizeContactPointValue("email", row.proposed_email);
  const knownEmails = new Set<string>();
  const metadataEmail = readPersonEmailFromMetadata(target.metadata);
  if (metadataEmail) knownEmails.add(normalizeContactPointValue("email", metadataEmail));

  const contactRows = await db
    .selectFrom("entity_contact_points")
    .select("value")
    .where("entity_id", "=", target.id)
    .where("kind", "=", "email")
    .execute();
  for (const contact of contactRows) {
    if (contact.value) knownEmails.add(normalizeContactPointValue("email", contact.value));
  }

  return knownEmails.size > 0 && !knownEmails.has(proposedEmail);
}

async function loadContextEntityIds(
  db: Kysely<DB>,
  contextFileId: string,
  excludedEntityIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom("entity_mentions")
    .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
    .select("entity_mentions.entity_id")
    .distinct()
    .where("entity_mentions.indexed_file_id", "=", contextFileId)
    .where(whereLiveEntity())
    .execute();
  return new Set(rows.map((row) => row.entity_id).filter((entityId) => !excludedEntityIds.has(entityId)));
}

async function decideAdjacencyForRow(
  db: Kysely<DB>,
  candidateIds: readonly string[],
  fileIds: readonly string[],
): Promise<"contested" | "vetoed" | "abstain" | { kind: "link"; targetEntityId: string }> {
  const winners = new Set<string>();

  for (const fileId of fileIds) {
    const contextIds = await loadContextEntityIds(db, fileId, new Set(candidateIds));
    if (contextIds.size === 0) continue;
    const signals = await loadAdjacencySignals(db, candidateIds, contextIds, fileId);
    const decision = decideAdjacency(candidateIds, contextIds, fileId, signals);
    if (decision.kind === "contested") return "contested";
    if (decision.kind === "abstain" && decision.vetoed) return "vetoed";
    if (decision.kind === "link") winners.add(decision.winnerId);
  }

  if (winners.size === 1) return { kind: "link", targetEntityId: [...winners][0] };
  if (winners.size > 1) return "contested";
  return "abstain";
}

async function decideRow(ctx: SweepContext, row: QueueRow): Promise<PendingDecision> {
  const fileIds = await evidenceFileIds(ctx.db, row.id);
  const ledger = await loadLedgerState(ctx.db, row, fileIds);
  const rejectionKey = normalizeName(row.proposed_name);

  for (const link of ledger.links) {
    if (ledger.blockedTargetIds.has(link.target_entity_id ?? "")) return { kind: "blockedByDistinct" };
    const target = await loadLiveLedgerTarget(ctx.db, row, link.target_entity_id);
    if (target) return { kind: "link", reviewId: row.id, targetEntityId: target.id, rung: "ledger" };
  }
  if (ledger.dismissed) return { kind: "blockedByDistinct" };

  const matches = exactMatches(ctx, row);
  if (matches.length === 0 && row.entity_type !== "person") return { kind: "unmatched" };

  if (matches.length === 1) {
    const target = matches[0];
    if (ledger.blockedTargetIds.has(target.id)) return { kind: "blockedByDistinct" };
    if (await ctx.isNameRejectedForEntity(target.id, rejectionKey)) return { kind: "blockedByDistinct" };
    if (await hasEmailConflict(ctx.db, row, target)) return { kind: "skippedEmailConflict" };
    if (!isSingleTokenPerson(row)) return { kind: "link", reviewId: row.id, targetEntityId: target.id, rung: "exact" };
  }

  if (row.entity_type === "person") {
    const candidateIds = await adjacencyCandidateIds(ctx, row, matches, ledger, rejectionKey);
    if (candidateIds.length > 0) {
      const adjacency = await decideAdjacencyForRow(ctx.db, candidateIds, fileIds);
      if (typeof adjacency === "object") {
        const winner =
          matches.find((match) => match.id === adjacency.targetEntityId) ??
          (await ctx.db
            .selectFrom("entities")
            .select(["id", "metadata"])
            .where("id", "=", adjacency.targetEntityId)
            .executeTakeFirst());
        if (winner && (await hasEmailConflict(ctx.db, row, winner))) return { kind: "skippedEmailConflict" };
        return { kind: "link", reviewId: row.id, targetEntityId: adjacency.targetEntityId, rung: "adjacency" };
      }
      if (adjacency === "contested") return { kind: "adjacencyContested" };
      if (adjacency === "vetoed") return { kind: "adjacencyVetoed" };
    }
  }

  if (matches.length === 0) return { kind: "unmatched" };
  if (matches.length === 1 && isSingleTokenPerson(row)) return { kind: "skippedSingleTokenExact" };
  return { kind: "multiMatch" };
}

export async function runBacklogSweep(
  deps: BacklogSweepDeps,
  opts: BacklogSweepOptions = {},
): Promise<BacklogSweepResult> {
  const rows = await deps.db
    .selectFrom("entity_review_queue")
    .selectAll()
    .where("status", "=", "pending")
    .orderBy("first_seen_at", "asc")
    .orderBy("id", "asc")
    .execute();
  const result = emptyResult(rows.length);
  if (rows.length === 0) return result;

  const index = await buildLookupIndex(deps.db);
  const lookup = createEntityLookupFromIndex({ db: deps.db, index, normalizationBackfillComplete: true });
  const reviewRepo = createEntityReviewRepo(deps.db);
  const rejectedByEntityId = new Map<string, Set<string>>();
  const ctx: SweepContext = {
    db: deps.db,
    lookup,
    isNameRejectedForEntity: async (entityId, rejectionKey) => {
      let keys = rejectedByEntityId.get(entityId);
      if (!keys) {
        const rejected = await reviewRepo.listRejectedNamesForEntities([entityId]);
        keys = new Set([...rejected].map((value) => value.slice(entityId.length + 1)));
        rejectedByEntityId.set(entityId, keys);
      }
      return keys.has(rejectionKey);
    },
  };
  const decisions: PendingDecision[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    decisions.push(await decideRow(ctx, rows[i]));
    if ((i + 1) % 50 === 0) await yieldToEventLoop();
  }

  for (const decision of decisions) addDecision(result, decision);
  if (!opts.apply) return result;

  const actorUserId = await findActorUserId(deps.db);
  result.linked = [];
  for (const decision of decisions) {
    if (decision.kind !== "link") continue;
    const resolved = await linkReviewRowToExistingEntity(
      { db: deps.db, userId: actorUserId, machineActor: true, logger: deps.logger },
      { reviewId: decision.reviewId, entityId: decision.targetEntityId },
      {
        decider: "backlog_sweep",
        decidedBy: actorUserId,
        provenanceTier: "machine_confirmed",
        allowedStatuses: ["pending"],
      },
    );
    if (!resolved.idempotent) {
      result.linked.push({
        reviewId: decision.reviewId,
        targetEntityId: decision.targetEntityId,
        rung: decision.rung,
      });
    }
  }

  return result;
}
