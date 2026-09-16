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
import type {
  ResolutionDecisionLookup,
  createResolutionDecisionRepository,
} from "../db/repositories/resolution-decisions";
import type { DB, EntitiesTable, EntityAliasProvenance } from "../db/schema";
import { type AdjacencyDecision, decideAdjacency, loadAdjacencySignals } from "./adjacency";
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

export type MatchInput = ProposeInput;

export interface MatchCandidate {
  entityId: string;
  name: string;
  type: string;
  rung: CandidateReason;
  score: number;
}

export interface LinkDescriptor {
  via:
    | "source_ref"
    | "email"
    | "exact"
    | "alias_authoritative"
    | "ledger"
    | "dedup"
    | "adjacency"
    | "domain"
    | "canonical"
    | "scope"
    | "fuzzy";
  attachEmail?: string;
  reconcileSubtype?: "internal" | "external";
  sourceRef?: { source: string; sourceId: string; conflict: "none" | "keep" };
  addAliases?: string[];
  refetch: boolean;
}

const RESOLVED_INDEX_REFRESH_VIAS = new Set<LinkDescriptor["via"]>([
  "source_ref",
  "email",
  "exact",
  "alias_authoritative",
  "dedup",
  "adjacency",
  "canonical",
  "scope",
  "fuzzy",
]);

export type MatchIntent =
  | { kind: "heal_target"; decisionId: string; targetEntityId: string }
  | { kind: "mark_stale"; decisionId: string }
  | {
      kind: "record_adjacency";
      normalizedMentionName: string;
      entityType: ProposeEntityType;
      contextFileId: string;
    };

export type MatchDecision =
  | {
      status: "linked";
      entityId: string;
      rung: string;
      link: LinkDescriptor;
      intents: MatchIntent[];
    }
  | {
      status: "ambiguous";
      candidates: MatchCandidate[];
      reason: CandidateReason;
      intents: MatchIntent[];
    }
  | { status: "pending"; reviewIds: string[]; candidates: MatchCandidate[]; intents: MatchIntent[] }
  | { status: "suppressed"; reason: string; intents: MatchIntent[] }
  | { status: "new"; intents: MatchIntent[] };

export interface PendingMatchRow {
  reviewId: string;
  candidateEntityIds: string[];
}

export interface MatchDecisionDeps {
  lookup: EntityLookup;
  findSourceRef?: (source: string, sourceId: string) => Promise<IndexEntityRow | null>;
  findEmailMatches?: (email: string) => Promise<IndexEntityRow[]>;
  readEntity?: (entityId: string) => Promise<IndexEntityRow | null>;
  listAliasRows?: (entityId: string) => Promise<Array<{ alias: string; provenance: EntityAliasProvenance }>>;
  findResolutionDecisions?: (
    normalizedName: string,
    entityType: ProposeEntityType,
    scope: string,
  ) => Promise<ResolutionDecisionLookup>;
  listRejectedNamesForEntities: (entityIds: string[]) => Promise<Set<string>>;
  resolvePersonScope?: (email: string | null | undefined) => Promise<string | null>;
  readAdjacency?: (candidateIds: string[], contextFileId: string) => Promise<AdjacencyDecision | null>;
  pendingLookup?: (normalizedName: string, entityType: ProposeEntityType) => Promise<PendingMatchRow[]>;
  hasLiveEntityTypeName?: (
    entityType: Extract<ProposeEntityType, "company" | "tool">,
    normalizedName: string,
  ) => Promise<boolean>;
  findCorporateDomainMatchingName?: (name: string) => Promise<boolean>;
  logger?: Logger;
  readEmail: (entity: IndexEntityRow) => string | null;
}

export interface RankedCandidate {
  entity: IndexEntityRow;
  score: number;
  reason: CandidateReason;
}

export function toMatchDeps(deps: ProposeDeps): MatchDecisionDeps {
  const db = deps.db;
  const resolutionLedger = deps.resolutionLedger;
  const domainsRepo = deps.domainsRepo;
  return {
    lookup: deps.lookup,
    findSourceRef: async (source, sourceId) => (await deps.entityRepo.getEntityBySourceRef(source, sourceId)) ?? null,
    findEmailMatches: (email) => deps.entityRepo.getPersonEntitiesByEmail(email),
    readEntity: async (entityId) => (await deps.entityRepo.getEntity(entityId)) ?? null,
    listAliasRows: db ? (entityId) => listAliasRows(db, entityId) : undefined,
    findResolutionDecisions: resolutionLedger
      ? (normalizedName, entityType, scope) => resolutionLedger.findActiveForMention(normalizedName, entityType, scope)
      : undefined,
    listRejectedNamesForEntities: (entityIds) => deps.reviewRepo.listRejectedNamesForEntities(entityIds),
    resolvePersonScope: domainsRepo
      ? async (email) => {
          const scope = await personScopeKey(email, domainsRepo);
          return scope ? personScopeKeyId(scope) : null;
        }
      : undefined,
    readAdjacency: db
      ? async (candidateIds, contextFileId) => {
          const contextIds = await loadContextEntityIds(db, contextFileId, new Set(candidateIds));
          if (contextIds.size === 0) return null;
          const signals = await loadAdjacencySignals(db, candidateIds, contextIds, contextFileId);
          return decideAdjacency(candidateIds, contextIds, contextFileId, signals);
        }
      : undefined,
    hasLiveEntityTypeName: async (entityType, normalizedName) => {
      const indexed = deps.lookup.hasLiveTypeName?.(entityType, normalizedName);
      if (indexed !== undefined && indexed !== null) return indexed;
      const entities = await deps.entityRepo.getEntitiesBySourceType(entityType);
      return entities.some((entity) => normalizeEntityMatchName(entityType, entity.name) === normalizedName);
    },
    findCorporateDomainMatchingName: domainsRepo
      ? async (name) => Boolean(await domainsRepo.findCorporateDomainMatchingName(name))
      : undefined,
    logger: deps.logger,
    readEmail: deps.readEmail,
  };
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

async function hasLiveEntityTypeName(
  deps: MatchDecisionDeps,
  entityType: Extract<ProposeEntityType, "company" | "tool">,
  normalized: string,
): Promise<boolean> {
  const indexed = deps.lookup.hasLiveTypeName?.(entityType, normalized);
  if (indexed !== undefined && indexed !== null) return indexed;
  return (await deps.hasLiveEntityTypeName?.(entityType, normalized)) ?? false;
}

function hasTrailingApiSdkToken(name: string): boolean {
  return /(?:^|[\s\p{P}\p{S}])(?:api|sdk)[\s\p{P}\p{S}]*$/iu.test(name.trim());
}

async function productCollidesWithThirdParty(
  deps: MatchDecisionDeps,
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
    const matchingDomain = await deps.findCorporateDomainMatchingName?.(name);
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
  deps: MatchDecisionDeps,
  rejectionKey: string,
  excludedEntityIds: Set<string> = new Set(),
): (ranked: RankedCandidate[]) => Promise<RankedCandidate[]> {
  const rejectedByEntityId = new Map<string, boolean>();
  return async (ranked) => {
    const missingIds = [...new Set(ranked.map((candidate) => candidate.entity.id))].filter(
      (entityId) => !rejectedByEntityId.has(entityId),
    );
    const rejected = await deps.listRejectedNamesForEntities(missingIds);
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

function matchCandidate(candidate: RankedCandidate): MatchCandidate {
  return {
    entityId: candidate.entity.id,
    name: candidate.entity.name,
    type: candidate.entity.source_type,
    rung: candidate.reason,
    score: candidate.score,
  };
}

function aliasesForDedupLink(input: MatchInput, entity: IndexEntityRow): string[] {
  return [input.name, ...(input.aliases ?? [])].filter(
    (alias) => alias.trim() && alias.trim().toLowerCase() !== entity.name.trim().toLowerCase(),
  );
}

function linkDescriptor(
  input: MatchInput,
  entity: IndexEntityRow,
  via: LinkDescriptor["via"],
  existingSourceRef: IndexEntityRow | null,
  options: {
    addAliases?: string[];
    persistEmail?: boolean;
    persistSourceRef?: boolean;
  } = {},
): LinkDescriptor {
  const sourceRefConflict: "none" | "keep" = existingSourceRef && existingSourceRef.id !== entity.id ? "keep" : "none";
  return {
    via,
    ...(input.entityType === "person" ? { reconcileSubtype: input.subtype } : {}),
    ...(options.persistEmail !== false && input.entityType === "person" && input.email
      ? { attachEmail: input.email }
      : {}),
    ...(options.persistSourceRef === false
      ? {}
      : {
          sourceRef: {
            source: input.source,
            sourceId: input.sourceId,
            conflict: sourceRefConflict,
          },
        }),
    ...(options.addAliases && options.addAliases.length > 0 ? { addAliases: options.addAliases } : {}),
    refetch: input.entityType === "person" || Boolean(options.addAliases?.length),
  };
}

function linkedDecision(
  input: MatchInput,
  entity: IndexEntityRow,
  rung: string,
  via: LinkDescriptor["via"],
  existingSourceRef: IndexEntityRow | null,
  intents: MatchIntent[],
  options: {
    addAliases?: string[];
    persistEmail?: boolean;
    persistSourceRef?: boolean;
  } = {},
): MatchDecision {
  return {
    status: "linked",
    entityId: entity.id,
    rung,
    link: linkDescriptor(input, entity, via, existingSourceRef, options),
    intents,
  };
}

async function replayResolutionDecisionForScope(
  deps: MatchDecisionDeps,
  input: MatchInput,
  normalized: string,
  excludedEntityIds: Set<string>,
  scope: string,
  existingSourceRef: IndexEntityRow | null,
  intents: MatchIntent[],
): Promise<MatchDecision | null> {
  if (!deps.findResolutionDecisions) return null;
  const decisions = await deps.findResolutionDecisions(normalized, input.entityType, scope);
  for (const row of decisions.distinct) {
    if (row.target_entity_id) excludedEntityIds.add(row.target_entity_id);
  }
  if (decisions.dismiss.length > 0) {
    return { status: "suppressed", reason: "resolution_decision_dismissed", intents };
  }
  const link = decisions.link;
  if (!link || link.status !== "active") return null;
  const targetId = link.target_entity_id;
  const target = targetId ? await deps.readEntity?.(targetId) : null;
  if (target && !excludedEntityIds.has(target.id) && isEligibleMatchTarget(input, target)) {
    return linkedDecision(input, target, "ledger", "ledger", existingSourceRef, intents);
  }
  if (!link.target_name) {
    intents.push({ kind: "mark_stale", decisionId: link.id });
    return null;
  }
  const targetNormalized = normalizeEntityMatchName(input.entityType, link.target_name);
  let descriptorMatches = deps.lookup
    .getByNormalizedName(targetNormalized)
    .filter((entity) => !excludedEntityIds.has(entity.id) && isEligibleMatchTarget(input, entity));
  if (link.target_email) {
    const targetEmail = link.target_email.trim().toLowerCase();
    descriptorMatches = descriptorMatches.filter(
      (entity) => deps.readEmail(entity)?.trim().toLowerCase() === targetEmail,
    );
  }
  if (descriptorMatches.length === 1) {
    const entity = descriptorMatches[0];
    intents.push({ kind: "heal_target", decisionId: link.id, targetEntityId: entity.id });
    return linkedDecision(input, entity, "ledger", "ledger", existingSourceRef, intents);
  }
  intents.push({ kind: "mark_stale", decisionId: link.id });
  return null;
}

async function replayResolutionDecision(
  deps: MatchDecisionDeps,
  input: MatchInput,
  normalized: string,
  excludedEntityIds: Set<string>,
  existingSourceRef: IndexEntityRow | null,
  intents: MatchIntent[],
): Promise<MatchDecision | null> {
  const global = await replayResolutionDecisionForScope(
    deps,
    input,
    normalized,
    excludedEntityIds,
    "global",
    existingSourceRef,
    intents,
  );
  if (global) return global;
  if (!input.contextFileId) return null;
  return replayResolutionDecisionForScope(
    deps,
    input,
    normalized,
    excludedEntityIds,
    `file:${input.contextFileId}`,
    existingSourceRef,
    intents,
  );
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
export function rank(entityType: ProposeEntityType, name: string, candidates: IndexEntityRow[]): RankedCandidate[] {
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
  candidates: MatchCandidate[],
  reason: CandidateReason,
): Promise<ProposeResult> {
  if (input.linkOnly) return { kind: "suppressed", reason: "link_only_no_confident_match" };
  const isSingle = candidates.length === 1;
  const candidateEntityId = isSingle ? candidates[0].entityId : null;
  const candidateScore = isSingle ? candidates[0].score : null;
  const candidateEntityIds = candidates.length > 1 ? candidates.map((candidate) => candidate.entityId) : null;

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

function ambiguousDecision(ranked: RankedCandidate[], reason: CandidateReason, intents: MatchIntent[]): MatchDecision {
  return { status: "ambiguous", candidates: ranked.map(matchCandidate), reason, intents };
}

async function decideScopedPersonMatch(
  deps: MatchDecisionDeps,
  input: MatchInput,
  ranked: RankedCandidate[],
  existingSourceRef: IndexEntityRow | null,
  intents: MatchIntent[],
  via: LinkDescriptor["via"],
): Promise<MatchDecision> {
  if (!deps.resolvePersonScope) {
    if (input.email) return { status: "new", intents };
    if (
      ranked.length === 1 &&
      isSingleStrictPersonReference(ranked) &&
      canAutoLinkNameDedupCandidate(input, ranked[0])
    ) {
      return linkedDecision(input, ranked[0].entity, ranked[0].reason, via, existingSourceRef, intents, {
        addAliases: aliasesForDedupLink(input, ranked[0].entity),
      });
    }
    return ambiguousDecision(ranked, ranked[0]?.reason ?? "exact-ambiguous", intents);
  }

  const incomingScopeId = await deps.resolvePersonScope(input.email);
  if (!incomingScopeId) {
    if (!input.strictPersonScopeGate && ranked.length === 1 && canAutoLinkScopedPersonCandidate(input, ranked[0])) {
      return linkedDecision(input, ranked[0].entity, ranked[0].reason, via, existingSourceRef, intents, {
        addAliases: aliasesForDedupLink(input, ranked[0].entity),
      });
    }
    if (input.email && !input.strictPersonScopeGate && !input.queueInsteadOfCreate) {
      return { status: "new", intents };
    }
    return ambiguousDecision(ranked, ranked[0]?.reason ?? "exact-ambiguous", intents);
  }

  const candidatesWithScopes = ranked.map((candidate) => ({
    candidate,
    scopeKeys: new Set(deps.lookup.getPersonScopeKeys?.(candidate.entity.id) ?? []),
  }));
  const matching = candidatesWithScopes.filter(({ scopeKeys }) => scopeKeys.has(incomingScopeId));
  if (matching.length === 1) {
    const match = matching[0].candidate;
    if (canAutoLinkScopedPersonCandidate(input, match)) {
      return linkedDecision(input, match.entity, match.reason, "scope", existingSourceRef, intents, {
        addAliases: aliasesForDedupLink(input, match.entity),
      });
    }
    if (input.email && !input.queueInsteadOfCreate) return { status: "new", intents };
    return ambiguousDecision(ranked, ranked[0]?.reason ?? "exact-ambiguous", intents);
  }
  if (matching.length >= 2) {
    return ambiguousDecision(ranked, ranked[0]?.reason ?? "exact-ambiguous", intents);
  }
  const allCandidatesTrusted = candidatesWithScopes.every(
    ({ scopeKeys }) => scopeKeys.size > 0 && [...scopeKeys].some(isTrustedPersonScopeKey),
  );
  if (allCandidatesTrusted && !input.queueInsteadOfCreate) return { status: "new", intents };
  return ambiguousDecision(ranked, ranked[0]?.reason ?? "exact-ambiguous", intents);
}

async function decideNameMatch(
  deps: MatchDecisionDeps,
  input: MatchInput,
  ranked: RankedCandidate[],
  existingSourceRef: IndexEntityRow | null,
  intents: MatchIntent[],
  via: LinkDescriptor["via"],
): Promise<MatchDecision> {
  if (input.entityType === "person") {
    return decideScopedPersonMatch(deps, input, ranked, existingSourceRef, intents, via);
  }
  if (ranked.length === 1 && canAutoLinkNameDedupCandidate(input, ranked[0])) {
    return linkedDecision(input, ranked[0].entity, ranked[0].reason, via, existingSourceRef, intents, {
      addAliases: aliasesForDedupLink(input, ranked[0].entity),
    });
  }
  const winner = pickConfirmedCanonical(
    ranked.filter((candidate) => canAutoLinkNameDedupCandidate(input, candidate)).map((candidate) => candidate.entity),
    input,
    deps.lookup,
  );
  if (winner) {
    return linkedDecision(
      input,
      winner,
      ranked[0]?.reason ?? "exact-ambiguous",
      "canonical",
      existingSourceRef,
      intents,
      {
        addAliases: aliasesForDedupLink(input, winner),
      },
    );
  }
  return ambiguousDecision(ranked, ranked[0]?.reason ?? "exact-ambiguous", intents);
}

async function applyPendingPrecedence(
  deps: MatchDecisionDeps,
  input: MatchInput,
  normalized: string,
  decision: MatchDecision,
): Promise<MatchDecision> {
  if ((decision.status !== "ambiguous" && decision.status !== "new") || !deps.pendingLookup) return decision;
  const pending = await deps.pendingLookup(normalized, input.entityType);
  if (pending.length === 0) return decision;
  const candidateIds = [...new Set(pending.flatMap((row) => row.candidateEntityIds))];
  const candidates: MatchCandidate[] = [];
  for (const entityId of candidateIds) {
    const fromDecision =
      decision.status === "ambiguous" ? decision.candidates.find((row) => row.entityId === entityId) : null;
    if (fromDecision) {
      candidates.push(fromDecision);
      continue;
    }
    const entity = await deps.readEntity?.(entityId);
    if (entity) candidates.push(matchCandidate({ entity, score: 1, reason: "exact-ambiguous" }));
  }
  return {
    status: "pending",
    reviewIds: pending.map((row) => row.reviewId),
    candidates,
    intents: decision.intents,
  };
}

async function embeddingMatchOrNew(
  deps: MatchDecisionDeps,
  input: MatchInput,
  normalized: string,
  filterRejectedCandidates: (ranked: RankedCandidate[]) => Promise<RankedCandidate[]>,
  intents: MatchIntent[],
): Promise<MatchDecision> {
  if ((input.entityType === "person" || input.entityType === "company") && deps.lookup.retrieveEmbeddingCandidates) {
    try {
      const retrieved = await deps.lookup.retrieveEmbeddingCandidates(input.entityType, input.name);
      const ranked = await filterRejectedCandidates(
        retrieved.filter((candidate) => isEligibleMatchTarget(input, candidate.entity)),
      );
      if (ranked.length > 0) {
        const decision = ambiguousDecision(ranked, "embedding", intents);
        return applyPendingPrecedence(deps, input, normalized, decision);
      }
    } catch (err) {
      deps.logger?.warn({ err, entityType: input.entityType }, "embedding candidate retrieval failed open");
    }
  }
  return applyPendingPrecedence(deps, input, normalized, { status: "new", intents });
}

export async function decideEntityMatch(deps: MatchDecisionDeps, input: MatchInput): Promise<MatchDecision> {
  const normalized = normalizeEntityMatchName(input.entityType, input.name);
  const rejectionKey = normalizeName(input.name);
  const excludedEntityIds = new Set<string>();
  const filterRejectedCandidates = createRejectedCandidateFilter(deps, rejectionKey, excludedEntityIds);
  const intents: MatchIntent[] = [];

  if (input.entityType === "product") {
    const collision = await productCollidesWithThirdParty(deps, input.name);
    if (collision.hit) {
      deps.logger?.info(
        { entityName: input.name, signal: collision.signal },
        "Suppressed product proposal due to third-party vendor collision",
      );
      return { status: "suppressed", reason: "third_party_vendor_collision", intents };
    }
  }

  const existingSourceRef =
    input.source && input.sourceId ? await deps.findSourceRef?.(input.source, input.sourceId) : null;
  if (existingSourceRef && isEligibleMatchTarget(input, existingSourceRef)) {
    const addAliases =
      existingSourceRef.name.trim().toLowerCase() === input.name.trim().toLowerCase() ? [] : [input.name];
    return linkedDecision(input, existingSourceRef, "source_ref", "source_ref", existingSourceRef, intents, {
      addAliases,
      persistEmail: false,
      persistSourceRef: false,
    });
  }

  if (input.entityType === "person" && input.email) {
    const emailMatches = (await deps.findEmailMatches?.(input.email)) ?? [];
    if (emailMatches.length === 1) {
      const candidate = emailMatches[0];
      const addAliases = candidate.name.trim().toLowerCase() === input.name.trim().toLowerCase() ? [] : [input.name];
      return linkedDecision(input, candidate, "email", "email", existingSourceRef ?? null, intents, {
        addAliases,
      });
    }
  }

  const nameMatches = deps.lookup.getByNormalizedName(normalized);
  const aliasMatches = deps.lookup.getByAlias?.(normalized) ?? [];
  const exactNameById = new Map<string, IndexEntityRow>();
  for (const e of nameMatches) if (isEligibleMatchTarget(input, e)) exactNameById.set(e.id, e);
  const demoteExactName = isSingleTokenPersonMention(input.entityType, input.name);
  if (exactNameById.size === 1 && !demoteExactName) {
    const matched = exactNameById.values().next().value as IndexEntityRow;
    const decision = await decideNameMatch(
      deps,
      input,
      [{ entity: matched, score: 1, reason: "exact-ambiguous" }],
      existingSourceRef ?? null,
      intents,
      "exact",
    );
    return applyPendingPrecedence(deps, input, normalized, decision);
  }
  if (exactNameById.size > 1 && !demoteExactName) {
    const decision = await decideNameMatch(
      deps,
      input,
      [...exactNameById.values()].map((entity) => ({ entity, score: 1, reason: "exact-ambiguous" })),
      existingSourceRef ?? null,
      intents,
      "exact",
    );
    return applyPendingPrecedence(deps, input, normalized, decision);
  }
  const aliasExactCandidates: RankedCandidate[] = uniqueRankedCandidates(
    aliasMatches
      .filter((entity) => isAliasCandidateTarget(input, entity) && !exactNameById.has(entity.id))
      .map((entity): RankedCandidate => ({ entity, score: 1, reason: "alias-exact" })),
  );
  const demotedExactNameCandidates = demoteExactName
    ? [...exactNameById.values()].map((entity): RankedCandidate => ({ entity, score: 1, reason: "exact-ambiguous" }))
    : [];

  const sameTypeAliasTargets = uniqueRankedCandidates(
    aliasMatches
      .filter((entity) => isEligibleMatchTarget(input, entity) && !exactNameById.has(entity.id))
      .map((entity): RankedCandidate => ({ entity, score: 1, reason: "exact-ambiguous" })),
  );
  if (exactNameById.size === 0 && sameTypeAliasTargets.length === 1 && deps.listAliasRows) {
    const aliasRows = await deps.listAliasRows(sameTypeAliasTargets[0].entity.id);
    const authoritative = aliasRows.some(
      (row) =>
        isSoloLinkAliasProvenance(row.provenance) &&
        normalizeEntityMatchName(input.entityType, row.alias) === normalized,
    );
    if (authoritative) {
      const decision = await decideNameMatch(
        deps,
        input,
        sameTypeAliasTargets,
        existingSourceRef ?? null,
        intents,
        "alias_authoritative",
      );
      return applyPendingPrecedence(deps, input, normalized, decision);
    }
  }

  const replayed = await replayResolutionDecision(
    deps,
    input,
    normalized,
    excludedEntityIds,
    existingSourceRef ?? null,
    intents,
  );
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
        const adjacency =
          !input.suppressContextLinking && input.contextFileId && deps.readAdjacency
            ? await deps.readAdjacency(
                adjacencyCandidates.map((candidate) => candidate.entity.id),
                input.contextFileId,
              )
            : null;
        if (adjacency?.kind === "link") {
          const winner = adjacencyCandidates.find((candidate) => candidate.entity.id === adjacency.winnerId)?.entity;
          if (winner && input.contextFileId) {
            intents.push({
              kind: "record_adjacency",
              normalizedMentionName: normalized,
              entityType: input.entityType,
              contextFileId: input.contextFileId,
            });
            return linkedDecision(input, winner, "adjacency", "adjacency", existingSourceRef ?? null, intents);
          }
        }
        if (adjacency?.kind === "contested") {
          const scoredIds = new Set(adjacency.scoredIds);
          const contested = adjacencyCandidates.filter(
            (candidate) => scoredIds.has(candidate.entity.id) && candidate.reason !== "edit-distance",
          );
          if (contested.length > 0) {
            return applyPendingPrecedence(deps, input, normalized, ambiguousDecision(contested, "adjacency", intents));
          }
        }
        if (adjacency?.kind === "abstain" && adjacency.vetoed) {
          const reviewable = adjacencyCandidates.filter((candidate) => candidate.reason !== "edit-distance");
          if (reviewable.length > 0) {
            return applyPendingPrecedence(deps, input, normalized, ambiguousDecision(reviewable, "adjacency", intents));
          }
        }
        const reviewCandidates = adjacencyCandidates.filter((candidate) => candidate.reason !== "edit-distance");
        const queueWorthy =
          reviewCandidates.length > 0 &&
          (demoteExactName ||
            reviewCandidates.some(
              (candidate) => candidate.reason === "alias-exact" || candidate.reason === "exact-ambiguous",
            ));
        if (queueWorthy) {
          return applyPendingPrecedence(
            deps,
            input,
            normalized,
            ambiguousDecision(reviewCandidates, reviewCandidates[0].reason, intents),
          );
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
        return linkedDecision(input, domainMatches[0], "domain", "domain", existingSourceRef ?? null, intents);
      }
      if (domainMatches.length > 1) {
        const winner = pickConfirmedCanonical(domainMatches, input, deps.lookup);
        if (winner) {
          return linkedDecision(input, winner, "domain", "domain", existingSourceRef ?? null, intents);
        }
        return applyPendingPrecedence(
          deps,
          input,
          normalized,
          ambiguousDecision(
            domainMatches.map((entity) => ({ entity, score: 1, reason: "exact-ambiguous" })),
            "exact-ambiguous",
            intents,
          ),
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
    if (ranked.length > 0) {
      return applyPendingPrecedence(deps, input, normalized, ambiguousDecision(ranked, "alias-exact", intents));
    }
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
    if (ranked.length > 0) {
      const decision = await decideNameMatch(deps, input, ranked, existingSourceRef ?? null, intents, "dedup");
      return applyPendingPrecedence(deps, input, normalized, decision);
    }
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
      return applyPendingPrecedence(deps, input, normalized, ambiguousDecision(ranked, "llm-ambiguous", intents));
    }
  }

  if (input.skipFuzzy) {
    return embeddingMatchOrNew(deps, input, normalized, filterRejectedCandidates, intents);
  }

  const candidates = deps.lookup.listByType(input.entityType).filter((entity) => isEligibleMatchTarget(input, entity));
  let ranked = rank(input.entityType, input.name, candidates);

  if (ranked.length > 0) {
    ranked = await filterRejectedCandidates(ranked);
  }

  if (ranked.length === 0) {
    return embeddingMatchOrNew(deps, input, normalized, filterRejectedCandidates, intents);
  }
  if (input.entityType === "person") {
    const decision = await decideScopedPersonMatch(deps, input, ranked, existingSourceRef ?? null, intents, "fuzzy");
    return applyPendingPrecedence(deps, input, normalized, decision);
  }
  return applyPendingPrecedence(deps, input, normalized, ambiguousDecision(ranked, ranked[0].reason, intents));
}

async function applyMatchIntents(
  deps: ProposeDeps,
  input: ProposeInput,
  decision: MatchDecision,
  linkedEntity?: IndexEntityRow,
): Promise<void> {
  for (const intent of decision.intents) {
    if (intent.kind === "mark_stale") {
      await deps.resolutionLedger?.markStale(intent.decisionId);
      continue;
    }
    if (intent.kind === "heal_target") {
      await deps.resolutionLedger?.healTarget(intent.decisionId, intent.targetEntityId);
      continue;
    }
    if (!linkedEntity) continue;
    await deps.resolutionLedger?.recordLink({
      normalizedMentionName: intent.normalizedMentionName,
      entityType: intent.entityType,
      scope: `file:${intent.contextFileId}`,
      targetEntityId: linkedEntity.id,
      targetName: linkedEntity.name,
      targetEmail: deps.readEmail(linkedEntity),
      decider: "adjacency",
      decidedBy: MACHINE_PRINCIPAL_USER_ID,
      source: input.source,
      sourceId: input.sourceId,
      evidenceFileIds: [intent.contextFileId],
    });
  }
}

async function executeLinkDescriptor(
  deps: ProposeDeps,
  input: ProposeInput,
  decision: Extract<MatchDecision, { status: "linked" }>,
): Promise<IndexEntityRow> {
  const matched = await deps.entityRepo.getEntity(decision.entityId);
  if (!matched) throw new Error(`matched entity ${decision.entityId} is no longer live`);
  let entity: IndexEntityRow = matched;
  if (decision.link.reconcileSubtype) {
    entity = await deps.entityRepo.reconcilePersonSubtype(
      entity.id,
      decision.link.reconcileSubtype,
      input.provenanceTier,
    );
  }
  if (decision.link.sourceRef?.conflict === "none") {
    await deps.entityRepo.upsertSourceRef({
      entityId: entity.id,
      source: decision.link.sourceRef.source,
      sourceId: decision.link.sourceRef.sourceId,
    });
  }
  if (decision.link.attachEmail) {
    await deps.entityRepo.attachEmailIfAbsent(entity.id, decision.link.attachEmail);
    await deps.entityRepo.appendAlias(entity.id, decision.link.attachEmail, "mint_model", input.source);
  }
  for (const alias of decision.link.addAliases ?? []) {
    await deps.entityRepo.appendAlias(entity.id, alias, "mint_model", input.source);
  }
  if (decision.link.refetch) entity = (await deps.entityRepo.getEntity(entity.id)) ?? entity;
  if (RESOLVED_INDEX_REFRESH_VIAS.has(decision.link.via)) await deps.onEntityResolved?.(entity);
  return entity;
}

export async function applyProposeEffects(
  deps: ProposeDeps,
  input: ProposeInput,
  decision: MatchDecision,
): Promise<ProposeResult> {
  if (decision.status === "linked") {
    const entity = await executeLinkDescriptor(deps, input, decision);
    await applyMatchIntents(deps, input, decision, entity);
    return { kind: "linked", entity };
  }

  await applyMatchIntents(deps, input, decision);
  if (decision.status === "suppressed") return { kind: "suppressed", reason: decision.reason };
  if (decision.status === "pending") {
    return {
      kind: "queued",
      reviewId: decision.reviewIds[0],
      candidateEntityId: decision.candidates.length === 1 ? decision.candidates[0].entityId : null,
    };
  }
  if (decision.status === "new") {
    return birthGateOrCreate(
      deps,
      input,
      normalizeEntityMatchName(input.entityType, input.name),
      input.skipFuzzy ? "skipFuzzy" : "ranked_empty",
    );
  }

  return queueProposal(
    deps,
    input,
    normalizeEntityMatchName(input.entityType, input.name),
    decision.candidates,
    decision.reason,
  );
}

export async function proposeEntity(deps: ProposeDeps, input: ProposeInput): Promise<ProposeResult> {
  const decision = await decideEntityMatch(toMatchDeps(deps), input);
  return applyProposeEffects(deps, input, decision);
}
