/**
 * Centralized entity-creation decision: every seeding path (Fireflies
 * attendees, future LLM extraction, future domain-promotion) calls
 * `proposeEntity` instead of `upsertPersonEntity` directly.
 *
 * The helper decides whether to:
 *   - **link** the proposal to an existing entity (e.g. email match),
 *   - **create** a fresh entity (no fuzzy collision, or email disambiguates), or
 *   - **queue** the proposal for human review (name fuzzy-collides with an
 *     existing entity and we're not confident enough to auto-link).
 *
 * The third branch is what's new in ECR-01 — today the seeding paths
 * always create-or-update, which is how a stale `Saurabh Bothra` row ended
 * up linked to 129 files (see `.planning/files/.../ENTITY_LINKAGE_PROVENANCE.md`).
 *
 * The fuzzy ranker uses an ambiguity-aware lookup. A plain `Map<string, Entity>`
 * silently overwrites duplicates and would cause the multi-candidate branch
 * to misfire as single-candidate — the caller MUST pass a structure that
 * preserves duplicates.
 */
import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import { type UpsertPersonEntityData, type createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import { isSoloLinkAliasProvenance, listAliasRows } from "../db/repositories/entity-alias-rows";
import type { EntityDomainsRepository } from "../db/repositories/entity-domains";
import type { EntityReviewRepository } from "../db/repositories/entity-review";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/machine-principal";
import type { createResolutionDecisionRepository } from "../db/repositories/resolution-decisions";
import type { DB, EntitiesTable } from "../db/schema";
import { decideAdjacency, loadAdjacencySignals } from "./adjacency";
import { isTrustedPersonScopeKey, personScopeKey, personScopeKeyId } from "./affiliations";
import { TOOL_NAME_DENYLIST } from "./graph";
import type { IndexEntityRow } from "./materialize-types";
import { normalizeEntityMatchName, normalizeName } from "./name-keys";
import { type ProvenanceTier, canUseEntityAsMatchTarget } from "./provenance";

export type Entity = Selectable<EntitiesTable>;

export type ProposeEntityType = "person" | "company" | "product" | "project" | "team" | "deal" | "tool";
export type CandidateReason =
  | "token-superset"
  | "prefix"
  | "exact-ambiguous"
  | "llm-ambiguous"
  | "birth-gated"
  | "strict-normalized"
  | "token-set"
  | "edit-distance"
  | "alias-exact"
  | "adjacency"
  | "embedding";

export interface ProposeInput {
  name: string;
  email?: string | null;
  entityType: ProposeEntityType;
  source: string;
  /**
   * The connector-level source id to pass through to `upsertPersonEntity`
   * when the proposal becomes `created` or `linked`. Currently only the
   * `person` path uses it; the `company` path will follow in ECR-05.
   */
  sourceId: string;
  /** Binary subtype for the entity row. */
  subtype: "internal" | "external";
  /** Files this proposal is observed in. Becomes evidence rows on queue. */
  evidence: Array<{ indexedFileId: string; note?: string }>;
  /** Owner of the sync / call that proposed this entity. Required. */
  triggeredByUserId: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
  provenanceTier?: ProvenanceTier;
  evidenceDomain?: string | null;
  precomputedCandidates?: Array<{ entity: IndexEntityRow; score: number; reason?: CandidateReason }>;
  skipFuzzy?: boolean;
  contextFileId?: string | null;
  /**
   * Birth gate: when set, a proposal that would otherwise CREATE a brand-new
   * entity (no exact/fuzzy match) is instead routed to the review queue. Used
   * for `project` relation endpoints so a single extracted relation can no
   * longer mint a project — it must be human-confirmed. Linking to an existing
   * entity and queuing an ambiguous match are unaffected.
   */
  queueInsteadOfCreate?: boolean;
  /**
   * Applies the person seed creation gate for name-only proposals. When true,
   * an unscoped incoming person proposal queues instead of linking by name.
   */
  strictPersonScopeGate?: boolean;
  /**
   * Restricts this proposal to corroborating an entity that can be linked
   * confidently. New entities and review proposals are suppressed.
   */
  linkOnly?: boolean;
  suppressContextLinking?: boolean;
}

export type ProposeResult =
  | { kind: "linked"; entity: IndexEntityRow }
  | { kind: "created"; entity: IndexEntityRow }
  | { kind: "queued"; reviewId: string; candidateEntityId: string | null }
  | { kind: "suppressed"; reason: string };

const CONTENT_EXTRACTION_TEAM_SOURCES: ReadonlySet<string> = new Set(["llm_extraction"]);

/**
 * Ambiguity-aware lookup over existing entities, keyed by `normalizeEntityMatchName(entityType, entity.name)`.
 * The Fireflies hot-path supplies a pre-built `Map<string, Entity[]>` to
 * avoid per-attendee queries. Cold callers should pass a fresh resolver
 * (per call) backed by a query.
 *
 * The implementation must preserve duplicates: passing a plain `Map<string, Entity>`
 * — which silently overwrites — defeats the multi-candidate detection and
 * yields false single-candidate queue rows.
 */
export type EntityLookup = {
  /** All entities sharing this normalized name. */
  getByNormalizedName(normalized: string): IndexEntityRow[];
  /**
   * All entities carrying this normalized form as an alias. Confirm appends
   * the proposed name to an existing entity's aliases, so the next propose
   * for that same name must be able to find it via alias as well as name.
   * Optional for backwards compat with callers that only have a name map
   * (cold callers without alias indexing); defaults to `[]`.
   */
  getByAlias?(normalized: string): IndexEntityRow[];
  /** All entities of the given type (used for prefix/token-superset scan). */
  listByType(entityType: ProposeEntityType): IndexEntityRow[];
  /** Same-type normalized-strict, token-set, or edit-distance candidates over names and aliases. */
  findNameDedupCandidates?(
    entityType: ProposeEntityType,
    name: string,
  ): Array<{
    entity: IndexEntityRow;
    score: number;
    reason: Extract<CandidateReason, "strict-normalized" | "token-set" | "edit-distance">;
  }>;
  retrieveEmbeddingCandidates?(entityType: ProposeEntityType, name: string): Promise<RankedCandidate[]>;
  /** Company ids associated with a normalized corporate domain. */
  getCompanyIdsByDomain?(domain: string): string[];
  getPersonScopeKeys?(entityId: string): string[];
  /**
   * Returns whether the lookup can prove that a live row of this type has the
   * name key, or null when the lookup's scope cannot answer and the caller must
   * fall back to the repository.
   */
  hasLiveTypeName?(entityType: Extract<ProposeEntityType, "company" | "tool">, normalizedName: string): boolean | null;
  /**
   * Returns whether any corporate domain matches the proposed name, or null
   * when the lookup's scope cannot answer and the caller must fall back to the
   * repository.
   */
  matchesCorporateDomain?(name: string): boolean | null;
  findLlmExtractedThirdPartyMention?(
    name: string,
  ): Promise<{ type: Extract<ProposeEntityType, "company" | "tool">; name: string } | null>;
};

export interface ProposeDeps {
  db?: Kysely<DB>;
  entityRepo: ReturnType<typeof createEntityRepository>;
  reviewRepo: EntityReviewRepository;
  resolutionLedger?: ReturnType<typeof createResolutionDecisionRepository>;
  domainsRepo?: EntityDomainsRepository;
  lookup: EntityLookup;
  logger?: Logger;
  birthGateTypes?: Set<ProposeEntityType>;
  birthGateLiveTypes?: Set<ProposeEntityType>;
  birthGateDryRun?: boolean;
  /** Read an entity's email from its metadata JSON. */
  readEmail: (entity: IndexEntityRow) => string | null;
  onEntityResolved?: (entity: IndexEntityRow) => void | Promise<void>;
}

export interface RankedCandidate {
  entity: IndexEntityRow;
  score: number;
  reason: CandidateReason;
}

/**
 * Tokenize a name into lowercase word tokens, dropping the trailing initial
 * period if present ("J." → "j"). Single-character tokens are kept — they
 * carry the last-initial signal for the prefix rule.
 */
function tokenize(name: string): string[] {
  return normalizeName(name)
    .split(" ")
    .map((t) => t.replace(/\.$/, ""))
    .filter((t) => t.length > 0);
}

function isTokenSupersetOrSubset(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length === b.length) return false;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  const longerSet = new Set(longer);
  return shorter.every((t) => longerSet.has(t));
}

function hasTokenOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const bSet = new Set(b);
  return a.some((token) => bSet.has(token));
}

async function repoHasEntityTypeName(
  deps: ProposeDeps,
  entityType: Extract<ProposeEntityType, "company" | "tool">,
  normalized: string,
): Promise<boolean> {
  const entities = await deps.entityRepo.getEntitiesBySourceType(entityType);
  return entities.some((entity) => normalizeEntityMatchName(entityType, entity.name) === normalized);
}

/**
 * `null` from the optional lookup methods means the current index was scoped
 * too narrowly to answer. In that case the old repository scan remains the
 * source of truth; boolean false means the index had the full relevant bucket
 * and found no collision.
 */
async function hasLiveEntityTypeName(
  deps: ProposeDeps,
  entityType: Extract<ProposeEntityType, "company" | "tool">,
  normalized: string,
): Promise<boolean> {
  const indexed = deps.lookup.hasLiveTypeName?.(entityType, normalized);
  if (indexed !== undefined && indexed !== null) return indexed;
  return repoHasEntityTypeName(deps, entityType, normalized);
}

function hasTrailingApiSdkToken(name: string): boolean {
  return /(?:^|[\s\p{P}\p{S}])(?:api|sdk)[\s\p{P}\p{S}]*$/iu.test(name.trim());
}

async function productCollidesWithThirdParty(
  deps: ProposeDeps,
  name: string,
): Promise<{ hit: boolean; signal?: string }> {
  const companyNormalized = normalizeEntityMatchName("company", name);
  if (await hasLiveEntityTypeName(deps, "company", companyNormalized)) {
    return { hit: true, signal: "existing_company_entity" };
  }

  const toolNormalized = normalizeEntityMatchName("tool", name);
  if (await hasLiveEntityTypeName(deps, "tool", toolNormalized)) {
    return { hit: true, signal: "existing_tool_entity" };
  }

  const indexedDomainMatch = deps.lookup.matchesCorporateDomain?.(name);
  if (indexedDomainMatch === true) return { hit: true, signal: "corporate_domain" };
  if (indexedDomainMatch === undefined || indexedDomainMatch === null) {
    const matchingDomain = await deps.domainsRepo?.findCorporateDomainMatchingName(name);
    if (matchingDomain) return { hit: true, signal: "corporate_domain" };
  }

  if (TOOL_NAME_DENYLIST.has(name.trim().toLowerCase())) return { hit: true, signal: "tool_name_denylist" };
  if (hasTrailingApiSdkToken(name)) return { hit: true, signal: "api_sdk_suffix" };

  const extracted = await deps.lookup.findLlmExtractedThirdPartyMention?.(name);
  if (extracted) return { hit: true, signal: `llm_extracted_${extracted.type}_fact` };

  return { hit: false };
}

function canAutoLinkNameDedupCandidate(input: ProposeInput, candidate: RankedCandidate): boolean {
  if (candidate.reason === "alias-exact") return false;
  if (candidate.reason === "token-set") return false;
  /**
   * MinHash could auto-link. One-edit auto-linking needs adjacency guardrails
   * and is deliberately deferred to PR 2.2.
   */
  if (candidate.reason === "edit-distance") return false;
  if (input.entityType === "person" && candidate.reason === "strict-normalized" && !input.email) return false;
  return true;
}

function isSingleTokenPersonMention(entityType: ProposeEntityType, name: string): boolean {
  return entityType === "person" && name.trim().length > 0 && !/\s/.test(name.trim());
}

function createRejectedCandidateFilter(
  deps: ProposeDeps,
  rejectionKey: string,
  excludedEntityIds: Set<string> = new Set(),
): (ranked: RankedCandidate[]) => Promise<RankedCandidate[]> {
  const rejectedByEntityId = new Map<string, boolean>();
  return async (ranked) => {
    const missingIds = [...new Set(ranked.map((candidate) => candidate.entity.id))].filter(
      (entityId) => !rejectedByEntityId.has(entityId),
    );
    const rejected = await deps.reviewRepo.listRejectedNamesForEntities(missingIds);
    for (const entityId of missingIds) rejectedByEntityId.set(entityId, rejected.has(`${entityId}:${rejectionKey}`));
    return ranked.filter(
      (candidate) => !excludedEntityIds.has(candidate.entity.id) && !rejectedByEntityId.get(candidate.entity.id),
    );
  };
}

function isEligibleMatchTarget(input: Pick<ProposeInput, "entityType">, entity: IndexEntityRow): boolean {
  return (
    entity.source_type === input.entityType && canUseEntityAsMatchTarget(entity.source_type, entity.provenance_tier)
  );
}

function isAliasCandidateTarget(input: Pick<ProposeInput, "entityType">, entity: IndexEntityRow): boolean {
  if (input.entityType === "person") return isEligibleMatchTarget(input, entity);
  return canUseEntityAsMatchTarget(entity.source_type, entity.provenance_tier);
}

async function replayResolutionDecisionForScope(
  deps: ProposeDeps,
  input: ProposeInput,
  normalized: string,
  excludedEntityIds: Set<string>,
  scope: string,
): Promise<ProposeResult | null> {
  if (!deps.resolutionLedger) return null;
  const decisions = await deps.resolutionLedger.findActiveForMention(normalized, input.entityType, scope);
  for (const row of decisions.distinct) {
    if (row.target_entity_id) excludedEntityIds.add(row.target_entity_id);
  }
  if (decisions.dismiss.length > 0) return { kind: "suppressed", reason: "resolution_decision_dismissed" };
  const link = decisions.link;
  if (!link || link.status !== "active") return null;
  const targetId = link.target_entity_id;
  const target = targetId ? await deps.entityRepo.getEntity(targetId) : null;
  if (target && !excludedEntityIds.has(target.id) && isEligibleMatchTarget(input, target)) {
    const { entity } = await persistEntity(deps, input, target);
    return { kind: "linked", entity };
  }
  if (!link.target_name) {
    await deps.resolutionLedger.markStale(link.id);
    return null;
  }
  const targetNormalized = normalizeEntityMatchName(input.entityType, link.target_name);
  const descriptorMatches = deps.lookup
    .getByNormalizedName(targetNormalized)
    .filter((entity) => !excludedEntityIds.has(entity.id) && isEligibleMatchTarget(input, entity));
  if (descriptorMatches.length === 1) {
    const { entity } = await persistEntity(deps, input, descriptorMatches[0]);
    await deps.resolutionLedger.healTarget(link.id, entity.id);
    return { kind: "linked", entity };
  }
  await deps.resolutionLedger.markStale(link.id);
  return null;
}

async function replayResolutionDecision(
  deps: ProposeDeps,
  input: ProposeInput,
  normalized: string,
  excludedEntityIds: Set<string>,
): Promise<ProposeResult | null> {
  const global = await replayResolutionDecisionForScope(deps, input, normalized, excludedEntityIds, "global");
  if (global) return global;
  if (!input.contextFileId) return null;
  return replayResolutionDecisionForScope(deps, input, normalized, excludedEntityIds, `file:${input.contextFileId}`);
}

/**
 * Prefix match: candidate's tokens start with the same first name AND
 * either match a "first + last-initial" pattern (e.g. proposed "Bob C"
 * matches existing "Bob Chen") or are a strict single-token prefix of the
 * candidate's name (e.g. proposed "Bob" matches "Bob Chen"). Conservative
 * on purpose — broader edit-distance rules are deferred until we measure
 * acceptance rates.
 */
function isPrefixMatch(proposed: string[], existing: string[]): boolean {
  if (proposed.length === 0 || existing.length === 0) return false;
  if (proposed[0] !== existing[0]) return false;
  if (proposed.length === existing.length) return false;

  if (proposed.length === 2 && existing.length >= 2) {
    const lastInitial = proposed[1];
    if (lastInitial.length === 1 && existing[1].startsWith(lastInitial)) return true;
  }
  if (existing.length === 2 && proposed.length >= 2) {
    const lastInitial = existing[1];
    if (lastInitial.length === 1 && proposed[1].startsWith(lastInitial)) return true;
  }

  if (proposed.length === 1) {
    return existing.length > 1 && existing[0] === proposed[0];
  }
  if (existing.length === 1) {
    return proposed.length > 1 && proposed[0] === existing[0];
  }
  return false;
}

/**
 * Apply the two ranker rules in order. Stops at the first tier with ≥1
 * match — multi-candidate at that tier signals "human pick" rather than
 * falling through to a weaker rule.
 */
function rank(entityType: ProposeEntityType, name: string, candidates: IndexEntityRow[]): RankedCandidate[] {
  const proposedTokens = tokenize(normalizeEntityMatchName(entityType, name));
  if (proposedTokens.length === 0) return [];

  const tokenSuperset: RankedCandidate[] = [];
  for (const c of candidates) {
    if (isTokenSupersetOrSubset(proposedTokens, tokenize(normalizeEntityMatchName(entityType, c.name)))) {
      tokenSuperset.push({ entity: c, score: 0.9, reason: "token-superset" });
    }
  }
  if (tokenSuperset.length > 0) return tokenSuperset;

  const prefix: RankedCandidate[] = [];
  for (const c of candidates) {
    if (isPrefixMatch(proposedTokens, tokenize(normalizeEntityMatchName(entityType, c.name)))) {
      prefix.push({ entity: c, score: 0.7, reason: "prefix" });
    }
  }
  return prefix;
}

async function persistEntity(
  deps: ProposeDeps,
  input: ProposeInput,
  matched?: IndexEntityRow,
): Promise<{ entity: IndexEntityRow; created: boolean }> {
  if (input.entityType === "person") {
    if (matched) {
      const reconciled = await deps.entityRepo.reconcilePersonSubtype(matched.id, input.subtype, input.provenanceTier);
      await deps.entityRepo.upsertSourceRef({
        entityId: reconciled.id,
        source: input.source,
        sourceId: input.sourceId,
      });
      if (input.email) {
        await deps.entityRepo.attachEmailIfAbsent(reconciled.id, input.email);
        await deps.entityRepo.appendAlias(reconciled.id, input.email, "mint_model", input.source);
      }
      const entity = (await deps.entityRepo.getEntity(reconciled.id)) ?? reconciled;
      return { entity, created: false };
    }
    const personData: UpsertPersonEntityData = {
      name: input.name,
      email: input.email ?? undefined,
      subtype: input.subtype,
      source: input.source,
      sourceId: input.sourceId,
      provenanceTier: input.provenanceTier ?? "inferred",
    };
    const entity = await deps.entityRepo.createPersonEntity(personData);
    return { entity, created: true };
  }

  if (matched) {
    await deps.entityRepo.upsertSourceRef({
      entityId: matched.id,
      source: input.source,
      sourceId: input.sourceId,
    });
    return { entity: matched, created: false };
  }

  const createEntity = input.entityType === "product" ? deps.entityRepo.createEntity : deps.entityRepo.upsertEntity;
  const entity = await createEntity({
    name: input.name,
    sourceType: input.entityType,
    subtype: input.subtype,
    aliases: input.aliases,
    metadata: input.metadata,
    status: "confirmed",
    provenanceTier: input.provenanceTier ?? "inferred",
  });
  await deps.entityRepo.upsertSourceRef({
    entityId: entity.id,
    source: input.source,
    sourceId: input.sourceId,
  });
  return { entity, created: true };
}

/**
 * Heuristic machine alias writes deliberately use the §3 `mint_model` tier.
 * A narrower `auto_dedup` tier would be more descriptive, but adding it here
 * would widen the durable-memory enum ahead of the agentic-resolution plan.
 */
async function linkNameDedupCandidate(
  deps: ProposeDeps,
  input: ProposeInput,
  matched: IndexEntityRow,
): Promise<ProposeResult> {
  const { entity } = await persistEntity(deps, input, matched);
  const aliasesToAppend = [input.name, ...(input.aliases ?? [])].filter(
    (alias) => alias.trim() && alias.trim().toLowerCase() !== matched.name.trim().toLowerCase(),
  );
  for (const alias of aliasesToAppend) {
    await deps.entityRepo.appendAlias(entity.id, alias, "mint_model", input.source);
  }
  const refreshed = (await deps.entityRepo.getEntity(entity.id)) ?? entity;
  await deps.onEntityResolved?.(refreshed);
  return { kind: "linked", entity: refreshed };
}

/**
 * Tie-break among confirmed duplicate candidates so dedup gaps in production
 * data don't silently stall relation materialization. Production corpora
 * accumulate near-duplicates ("Oliver Wyman" / "OW" / "Oliverwyman") across
 * syncs; queueing every cross-duplicate proposal blocks edges until a human
 * merges them. For non-person types we land the edge on a deterministic
 * winner and leave the duplicate as a separate data-quality cleanup. Persons
 * keep the queueing behaviour — two real people can share a name, and the
 * email fast-path upstream already handles the identity-grade case.
 *
 * Returns null to mean "fall through to queue" (person type, no confirmed
 * candidate, or the rare case where the pool empties under filtering).
 */
function pickConfirmedCanonical(
  candidates: IndexEntityRow[],
  input: ProposeInput,
  lookup: EntityLookup,
): IndexEntityRow | null {
  if (input.entityType === "person") return null;
  const confirmed = candidates.filter((c) => c.status === "confirmed");
  if (confirmed.length === 0) return null;
  if (confirmed.length === 1) return confirmed[0];

  let pool = confirmed;
  let matchedByDomain = false;
  const evidenceDomain = input.evidenceDomain?.trim().toLowerCase();
  if (evidenceDomain && input.entityType === "company") {
    const domainIds = new Set(lookup.getCompanyIdsByDomain?.(evidenceDomain) ?? []);
    if (domainIds.size > 0) {
      const withDomain = confirmed.filter((c) => domainIds.has(c.id));
      if (withDomain.length > 0) {
        pool = withDomain;
        matchedByDomain = true;
      }
    }
  }
  const sorted = [...pool].sort((a, b) => {
    if (b.hotness !== a.hotness) return b.hotness - a.hotness;
    if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
    return a.id.localeCompare(b.id);
  });
  if (!matchedByDomain && input.entityType === "company" && sorted.length >= 2) {
    const topHotness = Number(sorted[0].hotness ?? 0);
    const secondHotness = Number(sorted[1].hotness ?? 0);
    const strongEnough = secondHotness <= 0 ? topHotness > 0 : topHotness >= 3 * secondHotness;
    if (!strongEnough) return null;
  }
  return sorted[0];
}

function isSingleStrictPersonReference(ranked: RankedCandidate[]): boolean {
  return ranked.length === 1 && (ranked[0].reason === "exact-ambiguous" || ranked[0].reason === "strict-normalized");
}

function canAutoLinkScopedPersonCandidate(input: ProposeInput, candidate: RankedCandidate): boolean {
  return (
    (candidate.reason === "exact-ambiguous" || candidate.reason === "strict-normalized") &&
    canAutoLinkNameDedupCandidate(input, candidate)
  );
}

async function queueProposal(
  deps: ProposeDeps,
  input: ProposeInput,
  normalized: string,
  ranked: RankedCandidate[],
  reason: CandidateReason,
): Promise<ProposeResult> {
  if (input.linkOnly) return { kind: "suppressed", reason: "link_only_no_confident_match" };
  const isSingle = ranked.length === 1;
  const candidateEntityId = isSingle ? ranked[0].entity.id : null;
  const candidateScore = isSingle ? ranked[0].score : null;
  const candidateEntityIds = ranked.length > 1 ? ranked.map((candidate) => candidate.entity.id) : null;

  const upsertResult = await deps.reviewRepo.upsertQueueRow({
    proposedName: input.name,
    normalizedName: normalized,
    entityType: input.entityType,
    source: input.source,
    sourceId: input.sourceId,
    proposedEmail: input.email ?? null,
    candidateEntityId,
    candidateEntityIds,
    candidateScore,
    candidateReason: reason,
    triggeredByUserId: input.triggeredByUserId,
    evidenceIndexedFileIds: input.evidence.map((e) => e.indexedFileId),
  });

  if (!upsertResult.skipEvidence) {
    for (const e of input.evidence) {
      await deps.reviewRepo.upsertEvidence({
        reviewId: upsertResult.row.id,
        indexedFileId: e.indexedFileId,
        source: input.source,
        note: e.note ?? null,
      });
    }
  }

  return {
    kind: "queued",
    reviewId: upsertResult.row.id,
    candidateEntityId,
  };
}

async function birthGateOrCreate(
  deps: ProposeDeps,
  input: ProposeInput,
  normalized: string,
  branch: "skipFuzzy" | "ranked_empty",
): Promise<ProposeResult> {
  if (input.linkOnly) return { kind: "suppressed", reason: "link_only_no_confident_match" };
  if (input.entityType === "team" && CONTENT_EXTRACTION_TEAM_SOURCES.has(input.source)) {
    deps.logger?.info(
      { event: "content_team_birth_dropped", type: input.entityType, name: input.name, path: input.source, branch },
      "content_team_birth_dropped",
    );
    return { kind: "suppressed", reason: "content_team_birth_dropped" };
  }
  if (deps.birthGateTypes?.has(input.entityType)) {
    const effectiveDryRun = (deps.birthGateDryRun ?? true) && !deps.birthGateLiveTypes?.has(input.entityType);
    if (effectiveDryRun) {
      deps.logger?.info(
        { event: "would_birth_gate", type: input.entityType, name: input.name, path: input.source, branch },
        "would_birth_gate",
      );
    } else {
      return queueProposal(deps, input, normalized, [], "birth-gated");
    }
  }
  if (input.queueInsteadOfCreate) return queueProposal(deps, input, normalized, [], "birth-gated");
  const { entity } = await persistEntity(deps, input);
  return { kind: "created", entity };
}

async function embeddingCandidatesThenCreate(
  deps: ProposeDeps,
  input: ProposeInput,
  normalized: string,
  filterRejectedCandidates: (ranked: RankedCandidate[]) => Promise<RankedCandidate[]>,
  createReason: "skipFuzzy" | "ranked_empty",
): Promise<ProposeResult> {
  if ((input.entityType === "person" || input.entityType === "company") && deps.lookup.retrieveEmbeddingCandidates) {
    try {
      const retrieved = await deps.lookup.retrieveEmbeddingCandidates(input.entityType, input.name);
      const ranked = await filterRejectedCandidates(
        retrieved.filter((candidate) => isEligibleMatchTarget(input, candidate.entity)),
      );
      if (ranked.length > 0) return queueProposal(deps, input, normalized, ranked, "embedding");
    } catch (err) {
      deps.logger?.warn({ err, entityType: input.entityType }, "embedding candidate retrieval failed open");
    }
  }
  return birthGateOrCreate(deps, input, normalized, createReason);
}

function uniqueRankedCandidates(candidates: RankedCandidate[]): RankedCandidate[] {
  const byId = new Map<string, RankedCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.entity.id);
    if (!existing || candidate.score > existing.score) byId.set(candidate.entity.id, candidate);
  }
  return [...byId.values()];
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

async function tryContextAdjacency(
  deps: ProposeDeps,
  input: ProposeInput,
  normalized: string,
  ranked: RankedCandidate[],
): Promise<ProposeResult | null> {
  if (input.entityType !== "person" || input.suppressContextLinking || !input.contextFileId || !deps.db) return null;
  const contextFileId = input.contextFileId;
  const rankedById = new Map(ranked.map((candidate) => [candidate.entity.id, candidate]));
  const candidateIds = [...rankedById.keys()];
  const contextIds = await loadContextEntityIds(deps.db, contextFileId, new Set(candidateIds));
  if (contextIds.size === 0) return null;
  const signals = await loadAdjacencySignals(deps.db, candidateIds, contextIds, contextFileId);
  const decision = decideAdjacency(candidateIds, contextIds, contextFileId, signals);
  if (decision.kind === "link") {
    const winner = rankedById.get(decision.winnerId)?.entity;
    if (!winner) return null;
    const { entity } = await persistEntity(deps, input, winner);
    await deps.onEntityResolved?.(entity);
    await deps.resolutionLedger?.recordLink({
      normalizedMentionName: normalized,
      entityType: input.entityType,
      scope: `file:${contextFileId}`,
      targetEntityId: entity.id,
      targetName: entity.name,
      targetEmail: deps.readEmail(entity),
      decider: "adjacency",
      decidedBy: MACHINE_PRINCIPAL_USER_ID,
      source: input.source,
      sourceId: input.sourceId,
      evidenceFileIds: [contextFileId],
    });
    return { kind: "linked", entity };
  }
  /**
   * Contested and vetoed outcomes queue, but never on the strength of an
   * edit-distance candidate alone: edit-distance stays decision-inert outside
   * a T2 link, so a queue row (which demotes creation) must be reproducible by
   * the suppressed disposition during recreate — and that disposition drops
   * edit-distance candidates.
   */
  if (decision.kind === "contested") {
    const contested = decision.scoredIds
      .flatMap((entityId) => {
        const candidate = rankedById.get(entityId);
        return candidate ? [candidate] : [];
      })
      .filter((candidate) => candidate.reason !== "edit-distance");
    if (contested.length > 0) return queueProposal(deps, input, normalized, contested, "adjacency");
    return null;
  }
  if (decision.vetoed) {
    const reviewable = ranked.filter((candidate) => candidate.reason !== "edit-distance");
    if (reviewable.length > 0) return queueProposal(deps, input, normalized, reviewable, "adjacency");
  }
  return null;
}

async function decideScopedPersonCandidates(
  deps: ProposeDeps,
  input: ProposeInput,
  normalized: string,
  ranked: RankedCandidate[],
): Promise<ProposeResult> {
  if (!deps.domainsRepo) {
    if (input.email) {
      if (input.linkOnly) return { kind: "suppressed", reason: "link_only_no_confident_match" };
      const { entity } = await persistEntity(deps, input);
      return { kind: "created", entity };
    }
    if (
      ranked.length === 1 &&
      isSingleStrictPersonReference(ranked) &&
      canAutoLinkNameDedupCandidate(input, ranked[0])
    ) {
      return linkNameDedupCandidate(deps, input, ranked[0].entity);
    }
    return queueProposal(deps, input, normalized, ranked, ranked[0]?.reason ?? "exact-ambiguous");
  }
  const incomingScope = deps.domainsRepo ? await personScopeKey(input.email ?? null, deps.domainsRepo) : null;
  if (!incomingScope) {
    if (!input.strictPersonScopeGate && ranked.length === 1 && canAutoLinkScopedPersonCandidate(input, ranked[0])) {
      return linkNameDedupCandidate(deps, input, ranked[0].entity);
    }
    if (input.email && !input.strictPersonScopeGate && !input.queueInsteadOfCreate) {
      if (input.linkOnly) return { kind: "suppressed", reason: "link_only_no_confident_match" };
      const { entity } = await persistEntity(deps, input);
      return { kind: "created", entity };
    }
    return queueProposal(deps, input, normalized, ranked, ranked[0]?.reason ?? "exact-ambiguous");
  }
  const incomingScopeId = personScopeKeyId(incomingScope);
  const candidatesWithScopes = ranked.map((candidate) => {
    const scopeKeys = new Set(deps.lookup.getPersonScopeKeys?.(candidate.entity.id) ?? []);
    return { candidate, scopeKeys };
  });
  const matching = candidatesWithScopes.filter(({ scopeKeys }) => scopeKeys.has(incomingScopeId));
  if (matching.length === 1) {
    const match = matching[0];
    if (canAutoLinkScopedPersonCandidate(input, match.candidate)) {
      return linkNameDedupCandidate(deps, input, match.candidate.entity);
    }
    if (input.email && !input.queueInsteadOfCreate) {
      if (input.linkOnly) return { kind: "suppressed", reason: "link_only_no_confident_match" };
      const { entity } = await persistEntity(deps, input);
      return { kind: "created", entity };
    }
    return queueProposal(deps, input, normalized, ranked, ranked[0]?.reason ?? "exact-ambiguous");
  }
  if (matching.length >= 2) {
    return queueProposal(deps, input, normalized, ranked, ranked[0]?.reason ?? "exact-ambiguous");
  }
  const allCandidatesTrusted = candidatesWithScopes.every(
    ({ scopeKeys }) => scopeKeys.size > 0 && [...scopeKeys].some(isTrustedPersonScopeKey),
  );
  if (allCandidatesTrusted) {
    if (input.queueInsteadOfCreate) {
      return queueProposal(deps, input, normalized, ranked, ranked[0]?.reason ?? "exact-ambiguous");
    }
    if (input.linkOnly) return { kind: "suppressed", reason: "link_only_no_confident_match" };
    const { entity } = await persistEntity(deps, input);
    return { kind: "created", entity };
  }
  return queueProposal(deps, input, normalized, ranked, ranked[0]?.reason ?? "exact-ambiguous");
}

async function decideNameCandidates(
  deps: ProposeDeps,
  input: ProposeInput,
  normalized: string,
  ranked: RankedCandidate[],
): Promise<ProposeResult> {
  if (input.entityType === "person") return decideScopedPersonCandidates(deps, input, normalized, ranked);
  if (ranked.length === 1 && canAutoLinkNameDedupCandidate(input, ranked[0])) {
    return linkNameDedupCandidate(deps, input, ranked[0].entity);
  }
  const winner = pickConfirmedCanonical(
    ranked.filter((candidate) => canAutoLinkNameDedupCandidate(input, candidate)).map((candidate) => candidate.entity),
    input,
    deps.lookup,
  );
  if (winner) {
    const { entity } = await persistEntity(deps, input, winner);
    return { kind: "linked", entity };
  }
  return queueProposal(deps, input, normalized, ranked, ranked[0]?.reason ?? "exact-ambiguous");
}

export async function proposeEntity(deps: ProposeDeps, input: ProposeInput): Promise<ProposeResult> {
  const normalized = normalizeEntityMatchName(input.entityType, input.name);
  const rejectionKey = normalizeName(input.name);
  const excludedEntityIds = new Set<string>();
  const filterRejectedCandidates = createRejectedCandidateFilter(deps, rejectionKey, excludedEntityIds);

  if (input.entityType === "product") {
    const collision = await productCollidesWithThirdParty(deps, input.name);
    if (collision.hit) {
      deps.logger?.info(
        { entityName: input.name, signal: collision.signal },
        "Suppressed product proposal due to third-party vendor collision",
      );
      return { kind: "suppressed", reason: "third_party_vendor_collision" };
    }
  }

  if (input.source && input.sourceId) {
    const found = await deps.entityRepo.getEntityBySourceRef(input.source, input.sourceId);
    if (found && isEligibleMatchTarget(input, found)) {
      const reconciled =
        input.entityType === "person"
          ? await deps.entityRepo.reconcilePersonSubtype(found.id, input.subtype, input.provenanceTier)
          : found;
      await deps.entityRepo.upsertSourceRef({
        entityId: reconciled.id,
        source: input.source,
        sourceId: input.sourceId,
      });
      if (reconciled.name.trim().toLowerCase() !== input.name.trim().toLowerCase()) {
        await deps.entityRepo.appendAlias(reconciled.id, input.name, "mint_model", input.source);
      }
      const entity = (await deps.entityRepo.getEntityBySourceRef(input.source, input.sourceId)) ?? reconciled;
      await deps.onEntityResolved?.(entity);
      return { kind: "linked", entity };
    }
  }

  // 1) Email fast-path — exact, ambiguity-aware match against contact points.
  if (input.entityType === "person" && input.email) {
    const emailMatches = await deps.entityRepo.getPersonEntitiesByEmail(input.email);
    if (emailMatches.length === 1) {
      const candidate = emailMatches[0];
      const existingSourceRef = await deps.entityRepo.getEntityBySourceRef(input.source, input.sourceId);
      if (!existingSourceRef || existingSourceRef.id === candidate.id) {
        await deps.entityRepo.upsertSourceRef({
          entityId: candidate.id,
          source: input.source,
          sourceId: input.sourceId,
        });
      }
      const reconciled = await deps.entityRepo.reconcilePersonSubtype(
        candidate.id,
        input.subtype,
        input.provenanceTier,
      );
      if (candidate.name.trim().toLowerCase() !== input.name.trim().toLowerCase()) {
        await deps.entityRepo.appendAlias(reconciled.id, input.name, "mint_model", input.source);
      }
      const entity = (await deps.entityRepo.getEntity(reconciled.id)) ?? reconciled;
      await deps.onEntityResolved?.(entity);
      return { kind: "linked", entity };
    }
  }

  // 3) Exact-name fast-path — an entity already shares this canonical name.
  //    Alias-only matches are recall candidates below, never solo-link
  //    authority.
  const nameMatches = deps.lookup.getByNormalizedName(normalized);
  const aliasMatches = deps.lookup.getByAlias?.(normalized) ?? [];
  const exactNameById = new Map<string, IndexEntityRow>();
  for (const e of nameMatches) if (isEligibleMatchTarget(input, e)) exactNameById.set(e.id, e);
  const demoteExactName = isSingleTokenPersonMention(input.entityType, input.name);
  if (exactNameById.size === 1 && !demoteExactName) {
    const matched = exactNameById.values().next().value as IndexEntityRow;
    return decideNameCandidates(deps, input, normalized, [{ entity: matched, score: 1, reason: "exact-ambiguous" }]);
  }
  if (exactNameById.size > 1 && !demoteExactName) {
    return decideNameCandidates(
      deps,
      input,
      normalized,
      [...exactNameById.values()].map((entity) => ({ entity, score: 1, reason: "exact-ambiguous" })),
    );
  }
  const aliasExactCandidates: RankedCandidate[] = uniqueRankedCandidates(
    aliasMatches
      .filter((entity) => isAliasCandidateTarget(input, entity) && !exactNameById.has(entity.id))
      .map((entity): RankedCandidate => ({ entity, score: 1, reason: "alias-exact" })),
  );
  const demotedExactNameCandidates = demoteExactName
    ? [...exactNameById.values()].map((entity): RankedCandidate => ({ entity, score: 1, reason: "exact-ambiguous" }))
    : [];

  /**
   * Authoritative-alias fast-path: an alias taught by an adjudicated action
   * (merge / judge / human confirm) keeps yesterday's solo-link behavior when
   * it names exactly one same-type entity. Provenance lives in the
   * entity_aliases rows, not the lookup index, so this is a targeted per-hit
   * query. Blob-only aliases with no row fail the check and stay candidates.
   */
  const sameTypeAliasTargets = uniqueRankedCandidates(
    aliasMatches
      .filter((entity) => isEligibleMatchTarget(input, entity) && !exactNameById.has(entity.id))
      .map((entity): RankedCandidate => ({ entity, score: 1, reason: "exact-ambiguous" })),
  );
  if (exactNameById.size === 0 && sameTypeAliasTargets.length === 1 && deps.db) {
    const aliasRows = await listAliasRows(deps.db, sameTypeAliasTargets[0].entity.id);
    const authoritative = aliasRows.some(
      (row) =>
        isSoloLinkAliasProvenance(row.provenance) &&
        normalizeEntityMatchName(input.entityType, row.alias) === normalized,
    );
    if (authoritative) return decideNameCandidates(deps, input, normalized, sameTypeAliasTargets);
  }

  const replayed = await replayResolutionDecision(deps, input, normalized, excludedEntityIds);
  if (replayed) return replayed;

  const rawDedupCandidates: RankedCandidate[] = (
    deps.lookup.findNameDedupCandidates?.(input.entityType, input.name) ?? []
  )
    .filter((candidate) => isEligibleMatchTarget(input, candidate.entity))
    .map(
      (candidate): RankedCandidate => ({
        entity: candidate.entity,
        score: candidate.score,
        reason: candidate.reason,
      }),
    );
  const singleTokenPersonRankCandidates =
    input.entityType === "person" && demoteExactName
      ? rank(
          input.entityType,
          input.name,
          deps.lookup.listByType(input.entityType).filter((entity) => isEligibleMatchTarget(input, entity)),
        )
      : [];

  if (input.entityType === "person") {
    let adjacencyCandidates = uniqueRankedCandidates([
      ...demotedExactNameCandidates,
      ...aliasExactCandidates,
      ...singleTokenPersonRankCandidates,
      ...rawDedupCandidates,
    ]);
    if (adjacencyCandidates.length > 0) {
      adjacencyCandidates = await filterRejectedCandidates(adjacencyCandidates);
      if (adjacencyCandidates.length > 0) {
        const adjacencyResult = await tryContextAdjacency(deps, input, normalized, adjacencyCandidates);
        if (adjacencyResult) return adjacencyResult;
        /**
         * T2 did not decide. Only the candidate classes whose solo-link
         * authority this rung revoked (demoted single-token exact hits,
         * alias-only hits — plus a single-token mention's fuzzy candidates,
         * since single-token persons must never reach the scoped solo-link
         * paths below) convert to a review row. Multi-token mentions whose
         * union holds only the pre-existing dedup pool fall through so the
         * rungs below behave exactly as before this rung existed;
         * edit-distance candidates stay decision-inert and are dropped.
         */
        const reviewCandidates = adjacencyCandidates.filter((candidate) => candidate.reason !== "edit-distance");
        const queueWorthy =
          reviewCandidates.length > 0 &&
          (demoteExactName ||
            reviewCandidates.some(
              (candidate) => candidate.reason === "alias-exact" || candidate.reason === "exact-ambiguous",
            ));
        if (queueWorthy) {
          return queueProposal(deps, input, normalized, reviewCandidates, reviewCandidates[0].reason);
        }
      }
    }
  }

  if (input.entityType === "company" && input.evidenceDomain) {
    const domain = input.evidenceDomain.trim().toLowerCase();
    const companyIds = new Set(deps.lookup.getCompanyIdsByDomain?.(domain) ?? []);
    if (companyIds.size > 0) {
      const proposedTokens = tokenize(normalizeEntityMatchName(input.entityType, input.name));
      const domainMatches = deps.lookup
        .listByType("company")
        .filter((entity) => companyIds.has(entity.id))
        .filter((entity) =>
          hasTokenOverlap(proposedTokens, tokenize(normalizeEntityMatchName("company", entity.name))),
        );

      if (domainMatches.length === 1) {
        const { entity } = await persistEntity(deps, input, domainMatches[0]);
        return { kind: "linked", entity };
      }
      if (domainMatches.length > 1) {
        const winner = pickConfirmedCanonical(domainMatches, input, deps.lookup);
        if (winner) {
          const { entity } = await persistEntity(deps, input, winner);
          return { kind: "linked", entity };
        }
        return queueProposal(
          deps,
          input,
          normalized,
          domainMatches.map((entity) => ({ entity, score: 1, reason: "exact-ambiguous" })),
          "exact-ambiguous",
        );
      }
    }
  }

  /**
   * Alias revocation: a non-person alias-only exact hit is a review candidate,
   * never solo-link authority. This sits below the domain rung on purpose —
   * corporate-domain evidence still auto-links, so revocation only queues the
   * mentions that carry no stronger identity signal.
   */
  if (input.entityType !== "person" && aliasExactCandidates.length > 0) {
    const ranked = await filterRejectedCandidates(aliasExactCandidates);
    if (ranked.length > 0) return queueProposal(deps, input, normalized, ranked, "alias-exact");
  }

  /**
   * Edit-distance candidates are decision-inert in this phase: letting them
   * demote creation to queueing would make graph recreate drop real entities
   * whose names sit one edit apart (Himansh vs Himanshu). They surface through
   * findNameDedupCandidates for review tooling; wiring them into decisions
   * ships with the adjacency guardrails in the T2 expansion.
   */
  const dedupCandidates = rawDedupCandidates.filter((candidate) => candidate.reason !== "edit-distance");
  if (dedupCandidates.length > 0) {
    let ranked: RankedCandidate[] = dedupCandidates;
    ranked = await filterRejectedCandidates(ranked);
    if (ranked.length > 0) return decideNameCandidates(deps, input, normalized, ranked);
  }

  if (input.precomputedCandidates && input.precomputedCandidates.length > 0) {
    let ranked = input.precomputedCandidates
      .filter((candidate) => isEligibleMatchTarget(input, candidate.entity))
      .map((c) => ({
        entity: c.entity,
        score: c.score,
        reason: c.reason ?? ("llm-ambiguous" as const),
      }));
    ranked = await filterRejectedCandidates(ranked);
    if (ranked.length > 0) {
      return queueProposal(deps, input, normalized, ranked, "llm-ambiguous");
    }
  }

  if (input.skipFuzzy) {
    return embeddingCandidatesThenCreate(deps, input, normalized, filterRejectedCandidates, "skipFuzzy");
  }

  // 4) Fuzzy-rank against same-type entities.
  const candidates = deps.lookup.listByType(input.entityType).filter((entity) => isEligibleMatchTarget(input, entity));
  let ranked = rank(input.entityType, input.name, candidates);

  // 5) Drop candidates that have a sticky rejection for this normalized name.
  if (ranked.length > 0) {
    ranked = await filterRejectedCandidates(ranked);
  }

  // 6) Decide.
  if (ranked.length === 0) {
    return embeddingCandidatesThenCreate(deps, input, normalized, filterRejectedCandidates, "ranked_empty");
  }
  if (input.entityType === "person") return decideScopedPersonCandidates(deps, input, normalized, ranked);
  return queueProposal(deps, input, normalized, ranked, ranked[0].reason);
}
