/**
 * Hybrid search interface for the agent.
 *
 * Combines three search layers:
 * 1. Metadata filtering (time, source, content type, tags)
 * 2. FTS5 keyword search (BM25 ranking) — SQLite only
 * 3. Vector similarity search (sqlite-vec / pgvector embeddings)
 *
 * Results are merged using reciprocal rank fusion (RRF).
 *
 * Uses raw SQL for the FTS5/tsvector and vec/pgvector queries because:
 * - Kysely's typed query builder doesn't support virtual table joins (FTS5, sqlite-vec) natively.
 * - Postgres-specific operators (@@ plainto_tsquery, <=> halfvec cosine distance) have no
 *   Kysely equivalents. The two dialects use entirely different WHERE clauses, JOIN patterns,
 *   and ranking functions (bm25 vs ts_rank, sqlite-vec MATCH vs pgvector KNN), so a shared
 *   query builder abstraction would add complexity without benefit.
 */
import type { Kysely, RawBuilder, SqlBool } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { isPg } from "../db/dialect";
import { EMBEDDING_DIMENSIONS } from "../db/index";
import { readSourceMeta } from "../db/repositories/connectors";
import { createCrmRecordFieldsRepository, normalizeCrmRecordFieldValue } from "../db/repositories/crm-record-fields";
import { createEntityRepository } from "../db/repositories/entities";
import { fileVisibilityRuleSql, visibleFileIdsSql } from "../db/repositories/file-visibility-rule";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import { parseEmailAddrJson, parseEmailAddrListJson } from "./email/envelope-metadata";
import type { EmailAddr } from "./email/normalized-email";
import { createEnrichmentQueryEmbedder, resolveOpenRouterEnrichmentConfig } from "./enrichment-providers";
import type { SearchCandidate, StageKey, StageReporter, VectorChunkHit } from "./enrichment-stage-report";
import {
  type EntityScope,
  entityScopeHasFiles,
  entityScopePredicateSql,
  findEntityLinkedFileIds,
  resolveSqliteEntityScopeFileIds,
} from "./entity-scope";
import { idInList } from "./id-in-list";
import { filterAccessibleFileIds } from "./sync-utils";
import {
  type AccessPrincipalInput,
  CONNECTOR_TYPES,
  CRM_ACTIVITY_FILE_TYPES,
  type ConnectorType,
  normalizeAccessPrincipals,
} from "./types";
import {
  type ScoredVector,
  VECTOR_HIT_DISPLAY_CAP,
  rankVectorHits,
  selectVectorHitsForDisplay,
} from "./vector-trace-hits";

export interface SearchResult {
  id: string;
  fileName: string;
  source: string;
  contentCategory: string;
  summary: string | null;
  /** External provider ID (e.g. ClickUp task id, Fireflies transcript id). Some sources prefix subtypes (e.g. `doc:`, `db-`, `project-`). */
  providerFileId: string;
  providerUrl: string | null;
  sourcePath: string | null;
  sourceUpdatedAt: string | null;
  /** FTS5 relevance rank (lower = more relevant). */
  relevance: number;
}

export type SearchableSource = ConnectorType | "conversation" | "local";

function buildSearchableSources(connectorTypes: readonly ConnectorType[]): [SearchableSource, ...SearchableSource[]] {
  return ["conversation", "local", ...connectorTypes];
}

export const SEARCHABLE_SOURCES = buildSearchableSources(CONNECTOR_TYPES);

export { filterAccessibleFileIds } from "./sync-utils";

export const CRM_FILTER_FIELDS = [
  "stage",
  "status",
  "leadStatus",
  "leadSource",
  "owner",
  "priority",
  "industry",
  "tag",
  "callType",
] as const;

export type CrmFilterField = (typeof CRM_FILTER_FIELDS)[number];

export const RBAC_MODE_VISIBLE_SET = "visible-set";
export const RBAC_MODE_INLINE_RULE = "inline-rule";
export const RBAC_MODE_SQLITE = "pre-filter (fts) + post-filter (vector)";

/**
 * Materialised ID arrays are much faster for restricted principals, but beyond roughly
 * 10k visible files the bitmap scan costs tens of milliseconds and the inline visibility
 * rule is cheap once at least about 10% of HNSW tuples pass.
 */
export const VISIBLE_SET_CAP = 10_000;

export interface SearchOptions {
  /** Filter by source provider. */
  source?: string;
  fileTypes?: string[];
  threadId?: string;
  parentRecordId?: string;
  participantEmail?: string;
  domain?: string;
  crmFields?: Partial<Record<CrmFilterField, string>>;
  /** Max results (default 10). */
  limit?: number;
  /** Content category filter: "document" or "structured". */
  category?: string;
  /**
   * RBAC (user-level): restrict results to files the user can access.
   * Typed principals to match against current scope membership and explicit shares.
   * Non-chat files with no scope AND no file_access rows are unrestricted.
   * When omitted, no user-level filtering is applied.
   */
  userPrincipals?: AccessPrincipalInput[];
  accessBypassReason?: "admin";
  slackEntitySyncEnabled?: boolean;
}

export function fileAccessFilterSql(principalInput: AccessPrincipalInput[], slackEntitySyncEnabled = true) {
  return fileVisibilityRuleSql({
    principals: normalizeAccessPrincipals(principalInput),
    slackEntitySyncEnabled,
    archived: "include",
  });
}

/**
 * Zoho CRM sync classifies activity rows through `activityBody` in `zoho-crm.ts`,
 * which reads `Description ?? Note_Content`: for CRM activity file types, `structured`
 * means there is no free-text body, while `document` means there is one. Bodyless
 * activity rows are summarized under their parent object by the CRM rollup. CRM rows
 * still render a markdown header into `content`, and summaries are usually empty, so
 * neither `content` nor `summary` can identify this case.
 */
export function bodylessCrmActivityPredicateSql(): RawBuilder<boolean> {
  const fileTypes = sql.join(
    CRM_ACTIVITY_FILE_TYPES.map((fileType) => sql`${fileType}`),
    sql`, `,
  );
  return sql<boolean>`(
    indexed_files.content_category IS NULL
    OR indexed_files.content_category <> 'structured'
    OR indexed_files.file_type IS NULL
    OR indexed_files.file_type NOT IN (${fileTypes})
  )`;
}

function isBodylessCrmActivity(row: { content_category: string | null; file_type: string | null }): boolean {
  return (
    row.content_category === "structured" &&
    row.file_type !== null &&
    CRM_ACTIVITY_FILE_TYPES.some((fileType) => fileType === row.file_type)
  );
}

/**
 * Search the FTS5 index.
 *
 * Supports FTS5 query syntax:
 * - Simple terms: "planning doc"
 * - Prefix: "plan*"
 * - Phrase: '"Q1 planning"'
 * - Column filter: "file_name:report"
 */
export async function searchFiles(db: Kysely<DB>, query: string, opts?: SearchOptions): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 10;
  if (opts?.userPrincipals !== undefined && opts.userPrincipals.length === 0) return [];

  const principalList = opts?.userPrincipals ?? [];
  const userFilter =
    principalList.length > 0
      ? sql`AND ${fileAccessFilterSql(principalList, opts?.slackEntitySyncEnabled ?? true)}`
      : sql``;

  if (isPg(db)) {
    const tsQuery = sanitizeTsQuery(query);
    if (!tsQuery) return [];

    const pgQuery = sql<SearchResult>`
      SELECT
        indexed_files.id,
        indexed_files.file_name as "fileName",
        indexed_files.source,
        indexed_files.content_category as "contentCategory",
        indexed_files.summary,
        indexed_files.provider_file_id as "providerFileId",
        indexed_files.provider_url as "providerUrl",
        indexed_files.source_path as "sourcePath",
        indexed_files.source_updated_at as "sourceUpdatedAt",
        ts_rank(indexed_files.search_vector, plainto_tsquery('english', ${query})) as relevance
      FROM indexed_files
      WHERE indexed_files.search_vector @@ plainto_tsquery('english', ${query})
      AND indexed_files.is_archived = 0
      AND ${bodylessCrmActivityPredicateSql()}
      ${userFilter}
      ${opts?.source ? sql`AND indexed_files.source = ${opts.source}` : sql``}
      ${opts?.category ? sql`AND indexed_files.content_category = ${opts.category}` : sql``}
      ${extraFilterSql(opts)}
      ORDER BY relevance DESC
      LIMIT ${limit}
    `;
    return (await pgQuery.execute(db)).rows;
  }

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  const baseQuery = sql<SearchResult>`
		SELECT
			indexed_files.id,
			indexed_files.file_name as "fileName",
			indexed_files.source,
			indexed_files.content_category as "contentCategory",
			indexed_files.summary,
			indexed_files.provider_file_id as "providerFileId",
			indexed_files.provider_url as "providerUrl",
			indexed_files.source_path as "sourcePath",
			indexed_files.source_updated_at as "sourceUpdatedAt",
			bm25(indexed_files_fts, 10.0, 4.0, 2.0) as relevance
		FROM indexed_files
		INNER JOIN indexed_files_fts ON indexed_files.rowid = indexed_files_fts.rowid
		WHERE indexed_files_fts MATCH ${ftsQuery}
		AND indexed_files.is_archived = 0
		AND ${bodylessCrmActivityPredicateSql()}
		${userFilter}
		${opts?.source ? sql`AND indexed_files.source = ${opts.source}` : sql``}
		${opts?.category ? sql`AND indexed_files.content_category = ${opts.category}` : sql``}
		${extraFilterSql(opts)}
		ORDER BY relevance
		LIMIT ${limit}
	`;

  const results = await baseQuery.execute(db);
  return results.rows;
}

/**
 * Get the full content of an indexed file.
 * Used by the agent when it wants to load a document into conversation context,
 * and by the frontend file detail sheet.
 *
 * Access control:
 *   - `userPrincipals === undefined` → trusted bypass (server boot paths and
 *     interactive admin agent/web content reads when the org setting is on).
 *     Returns the file unfiltered.
 *   - `userPrincipals === []`        → caller has no resolvable principal → fail closed.
 *     Returns null regardless of the file's access shape. Prevents an unauth'd
 *     user from inheriting visibility through the empty-array path.
 *   - `userPrincipals.length > 0`    → 3-tier check (unrestricted / scope / per-file).
 */
export async function getFileContent(
  db: Kysely<DB>,
  fileId: string,
  userPrincipals?: AccessPrincipalInput[],
  slackEntitySyncEnabled = true,
): Promise<{
  id: string;
  connectorConfigId: string;
  fileName: string;
  fileType: string | null;
  source: string;
  sourcePath: string | null;
  content: string | null;
  summary: string | null;
  contextNote: string | null;
  providerUrl: string | null;
  enrichmentStatus: string;
} | null> {
  let query = db
    .selectFrom("indexed_files")
    .select([
      "id",
      "connector_config_id",
      "file_name",
      "file_type",
      "source",
      "source_path",
      "content",
      "summary",
      "context_note",
      "provider_url",
      "enrichment_status",
    ])
    .where("id", "=", fileId);

  if (userPrincipals !== undefined) {
    const principals = normalizeAccessPrincipals(userPrincipals);
    if (principals.length === 0) return null;
    query = query.where(fileVisibilityRuleSql({ principals, slackEntitySyncEnabled, archived: "exclude" }));
  }

  const file = await query.executeTakeFirst();
  if (!file) return null;

  return {
    id: file.id,
    connectorConfigId: file.connector_config_id,
    fileName: file.file_name,
    fileType: file.file_type,
    source: file.source,
    sourcePath: file.source_path,
    content: file.content,
    summary: file.summary,
    contextNote: file.context_note,
    providerUrl: file.provider_url,
    enrichmentStatus: file.enrichment_status,
  };
}

/**
 * List all indexed sources with file counts.
 * Useful for the agent to report what data is available.
 */
export async function listIndexedSources(
  db: Kysely<DB>,
): Promise<Array<{ source: string; fileCount: number; lastSynced: string | null }>> {
  const results = await db
    .selectFrom("indexed_files")
    .select(["source", sql<number>`count(*)`.as("fileCount"), sql<string>`max(synced_at)`.as("lastSynced")])
    .where("is_archived", "=", 0)
    .groupBy("source")
    .execute();

  return results.map((r) => ({
    source: r.source,
    fileCount: Number(r.fileCount),
    lastSynced: r.lastSynced,
  }));
}

/**
 * Summary of sources with at least one indexed file, for inclusion in the
 * agent's system prompt. A source qualifies as "indexed" when it has ≥ 1 file
 * in `indexed_files` (trusting that anyone who wired a connector and has files
 * will keep them refreshed). Empty sources are excluded to avoid telling the
 * agent to Search against nothing.
 */
export async function listIndexedSourcesForPrompt(
  db: Kysely<DB>,
): Promise<Array<{ source: string; fileCount: number }>> {
  const results = await db
    .selectFrom("indexed_files")
    .select(["source", sql<number>`count(*)`.as("fileCount")])
    .where("is_archived", "=", 0)
    .groupBy("source")
    .having(sql<number>`count(*)`, ">", 0)
    .execute();

  return results
    .map((r) => ({ source: r.source, fileCount: Number(r.fileCount) }))
    .sort((a, b) => b.fileCount - a.fileCount);
}

/**
 * Sanitize user input for Postgres tsquery / plainto_tsquery.
 * plainto_tsquery is quite robust, but we strip operator characters that could
 * cause issues when passed through string interpolation.
 */
function sanitizeTsQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const cleaned = trimmed
    .replace(/[&|!<>():*\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "";
}

/**
 * Sanitize user input for FTS5 queries.
 * Strips characters that would cause FTS5 syntax errors.
 */
function sanitizeFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  // Preserve explicit phrase queries
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed;
  }

  // Preserve column-scoped queries
  if (trimmed.includes(":") && /^\w+:/.test(trimmed)) {
    return trimmed;
  }

  // Strip FTS5 boolean operators and special chars, then join with OR so partial
  // matches work. FTS5 defaults to AND which fails when the query is long and any
  // word is missing.
  const words = trimmed
    // Remove FTS5 boolean keywords (case-insensitive whole-word match)
    .replace(/\b(OR|AND|NOT|NEAR)\b/gi, " ")
    // Remove special chars except word chars, spaces, and a single trailing *
    // (FTS5 allows prefix queries like "plan*" but not standalone * or **)
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);

  if (words.length === 0) return "";
  if (words.length === 1) return words[0];

  // Use OR so documents matching any word are returned (ranked by BM25)
  return words.join(" OR ");
}

// ── Kind taxonomy ─────────────────────────────────────────────────────────

/**
 * One rule in a kind's filter set: an `indexed_files.source IN (...)` group
 * optionally narrowed by `indexed_files.file_type IN (...)`. Multiple rules
 * for the same kind are OR-ed together so a kind can span sources with
 * different file_type vocabularies (e.g. "doc" = Drive documents OR Notion
 * pages OR ClickUp Docs OR Linear projects).
 */
export type KindRule = { sources?: string[]; fileTypes?: string[] };

/**
 * Static map of semantic content kind → SQL-filter rules. Values are code
 * constants and never user-driven; any future dynamic source must enforce a
 * static allowlist before reaching the SQL builder. ContentCategory is too
 * coarse (only "document" | "structured") and source-only mapping silently
 * sweeps in tasks under `kind: "doc"` — so we discriminate on file_type too.
 */
export const SEARCH_KINDS = ["meeting", "doc", "task", "message", "email"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const KIND_TO_RULES: Record<SearchKind, KindRule[]> = {
  meeting: [{ sources: ["fireflies", "otter"] }, { sources: ["teams"], fileTypes: ["meeting_transcript"] }],
  doc: [
    { sources: ["google_drive"], fileTypes: ["document", "presentation"] },
    { sources: ["notion"], fileTypes: ["page"] },
    { sources: ["clickup"], fileTypes: ["doc"] },
    { sources: ["linear"], fileTypes: ["project"] },
  ],
  task: [
    { sources: ["clickup"], fileTypes: ["task", "subtask"] },
    { sources: ["linear"], fileTypes: ["issue"] },
  ],
  message: [
    { sources: ["conversation", "whatsapp", "slack"] },
    { sources: ["linkedin_aimfox"], fileTypes: ["linkedin_conversation"] },
  ],
  email: [{ sources: ["outlook", "gmail"], fileTypes: ["email_message"] }],
};

/**
 * Sources reachable through a kind's rules. A rule with no `sources` matches
 * every source, so it contributes the full searchable set.
 */
export function sourcesForKind(kind: SearchKind): string[] {
  const rules = KIND_TO_RULES[kind] ?? [];
  if (rules.some((r) => !r.sources?.length)) return [...SEARCHABLE_SOURCES];
  return [...new Set(rules.flatMap((r) => r.sources ?? []))];
}

/** Kinds whose rules can reach the given source. Used to build actionable kind×source errors. */
export function kindsForSource(source: string): SearchKind[] {
  return SEARCH_KINDS.filter((kind) => sourcesForKind(kind).includes(source));
}

/** Compile kind rules to a raw SQL fragment for the FTS / hybrid pipelines. */
function kindFilterSql(rules: KindRule[]) {
  if (rules.length === 0) return sql``;
  const parts = rules.map((r) => {
    const conds: ReturnType<typeof sql>[] = [];
    if (r.sources?.length) {
      conds.push(
        sql`indexed_files.source IN (${sql.join(
          r.sources.map((s) => sql`${s}`),
          sql`, `,
        )})`,
      );
    }
    if (r.fileTypes?.length) {
      conds.push(
        sql`indexed_files.file_type IN (${sql.join(
          r.fileTypes.map((t) => sql`${t}`),
          sql`, `,
        )})`,
      );
    }
    return sql`(${sql.join(conds, sql` AND `)})`;
  });
  return sql`AND (${sql.join(parts, sql` OR `)})`;
}

/** Accepts "@Example.com", " example.com " etc. and yields the bare lower-cased domain, or undefined when empty. */
export function normalizeDomainFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^@+/, "").toLowerCase();
  return normalized || undefined;
}

function participantEmailExistsSql(alias: string, predicate: RawBuilder<unknown>) {
  return sql`EXISTS (
    SELECT 1
    FROM indexed_file_facts
    WHERE indexed_file_facts.indexed_file_id = ${sql.ref(`${alias}.id`)}
    AND indexed_file_facts.deleted_at IS NULL
    AND indexed_file_facts.fact_type IN ('attendee', 'correspondent')
    AND ${predicate}
  )`;
}

function extraFilterSql(
  opts:
    | Pick<SearchOptions, "fileTypes" | "threadId" | "parentRecordId" | "participantEmail" | "domain" | "crmFields">
    | undefined,
  alias = "indexed_files",
) {
  const parts: ReturnType<typeof sql>[] = [];
  const domain = normalizeDomainFilter(opts?.domain);
  if (opts?.fileTypes?.length) {
    parts.push(
      sql`${sql.ref(`${alias}.file_type`)} IN (${sql.join(
        opts.fileTypes.map((fileType) => sql`${fileType}`),
        sql`, `,
      )})`,
    );
  }
  if (opts?.threadId) parts.push(sql`${sql.ref(`${alias}.thread_id`)} = ${opts.threadId}`);
  if (opts?.parentRecordId) parts.push(sql`${sql.ref(`${alias}.rollup_group_id`)} = ${opts.parentRecordId}`);
  if (opts?.participantEmail) {
    parts.push(
      participantEmailExistsSql(alias, sql`lower(indexed_file_facts.subject_email) = lower(${opts.participantEmail})`),
    );
  }
  if (domain) {
    parts.push(
      participantEmailExistsSql(alias, sql`lower(indexed_file_facts.subject_email) LIKE ('%@' || lower(${domain}))`),
    );
  }
  for (const [field, value] of crmFieldFilterEntries(opts?.crmFields)) {
    parts.push(
      sql`EXISTS (
        SELECT 1
        FROM crm_record_fields f
        WHERE f.indexed_file_id = ${sql.ref(`${alias}.id`)}
        AND f.field = ${field}
        AND f.value_norm = ${normalizeCrmRecordFieldValue(value)}
      )`,
    );
  }
  return parts.length > 0 ? sql`AND ${sql.join(parts, sql` AND `)}` : sql``;
}

function crmFieldFilterEntries(
  crmFields: Partial<Record<CrmFilterField, string>> | undefined,
): Array<[CrmFilterField, string]> {
  if (!crmFields) return [];
  const entries: Array<[CrmFilterField, string]> = [];
  for (const field of CRM_FILTER_FIELDS) {
    const value = crmFields[field]?.trim();
    if (value) entries.push([field, value]);
  }
  return entries;
}

// ── Hybrid Search ─────────────────────────────────────────────────────────

export interface HybridSearchOptions extends SearchOptions {
  /** Time filter — matches file dates AND content timeframes. */
  timeFilter?: {
    after?: string;
    before?: string;
  };
  /** Filter by content types: "image", "document", "structured". */
  contentTypes?: string[];
  /** Embed the query for vector search. If null, only FTS5 is used. */
  queryEmbedding?: number[];
  /** Restrict search to these file IDs only. */
  fileIds?: string[];
  /** Restrict search to files linked to these entities without materialising file IDs. */
  entityScope?: EntityScope;
  /** Entity matches whose links to the bounded candidate set receive a ranking boost. */
  entityBoostEntityIds?: string[];
  /** Multi-source filter (OR-of-sources). Takes precedence over `source` when both set. */
  sources?: string[];
  /** Compiled kind rules — see KIND_TO_RULES. Caller (Search tool) translates `kind` → rules. */
  kindRules?: KindRule[];
  /**
   * Dev-tools trace hook. Undefined in production, which is what keeps the reporting path
   * free: every call site is optional-chained and the one extra query it needs is guarded
   * on this being set.
   */
  stageReport?: StageReporter;
  expandThreads?: boolean;
}

export interface HybridSearchResult {
  resultKind: "file" | "email_thread" | "linkedin_conversation";
  id: string;
  hitFileId: string;
  fileName: string;
  source: string;
  contentCategory: string;
  summary: string | null;
  /** External provider ID (e.g. ClickUp task id, Fireflies transcript id). Some sources prefix subtypes (e.g. `doc:`, `db-`, `project-`). */
  providerFileId: string;
  providerUrl: string | null;
  sourcePath: string | null;
  sourceUpdatedAt: string | null;
  /** Source-side creation date — used by recency tie-break when sourceUpdatedAt ties. */
  sourceCreatedAt: string | null;
  /** Text snippet from the best matching chunk (null for images). */
  snippet: string | null;
  /** Vector similarity score 0-1 (null if no vector match). */
  similarity: number | null;
  /** Combined score (higher = more relevant). */
  score: number;
  threadId?: string | null;
  rollupGroupId?: string | null;
  threadKey?: string;
  messageCount?: number;
  inboundCount?: number;
  outboundCount?: number;
  lastMessageFrom?: "them" | "us" | null;
  latestSubject?: string;
  lastActivity?: string | null;
  participants?: string[];
}

export interface ResolvedAccessPredicate {
  predicate: RawBuilder<unknown>;
  mode: typeof RBAC_MODE_VISIBLE_SET | typeof RBAC_MODE_INLINE_RULE;
  visibleCount?: number;
}

/**
 * Internal-only controls used by `search()` and focused tests. Public callers should pass
 * normal `HybridSearchOptions`; the precomputed predicate exists so `search()` can resolve
 * RBAC before the embedding round-trip.
 */
interface HybridSearchInternalOptions {
  resolvedAccessPredicate?: ResolvedAccessPredicate;
  visibleSetCap?: number;
}

const NO_SCORED_CANDIDATE_REMAINDER = [
  ["filter", "Metadata filters"],
  ["finalize", "Collapse and slice"],
] as const satisfies ReadonlyArray<readonly [StageKey, string]>;

function reportNoScoredCandidateRemainder(stageReport: StageReporter | undefined, error: string): void {
  for (const [stage, label] of NO_SCORED_CANDIDATE_REMAINDER) {
    stageReport?.({
      stage,
      label,
      kind: "code",
      status: "skipped",
      error,
    });
  }
}

/**
 * pgvector caps `hnsw.ef_search` at 1000. Sized to the requested candidate limit, because
 * a non-iterative scan cannot return more rows than this.
 */
function hnswEfSearch(vecLimit: number): number {
  return Math.min(1000, Math.max(40, vecLimit));
}

/**
 * Resolves principal-scoped Postgres RBAC into either a materialised visible-file snapshot
 * or the inline SQL rule. The visible-set regime is a snapshot taken before the embedding
 * round-trip, so a grant revoked during that window is still honoured for that search; the
 * inline-rule regime evaluates fresh in SQL.
 */
async function resolveAccessPredicate(
  db: Kysely<DB>,
  opts?: {
    userPrincipals?: AccessPrincipalInput[];
    accessBypassReason?: "admin";
    slackEntitySyncEnabled?: boolean;
    visibleSetCap?: number;
  },
): Promise<ResolvedAccessPredicate | undefined> {
  if (!isPg(db) || opts?.accessBypassReason === "admin") return undefined;
  const principalList = opts?.userPrincipals ?? [];
  if (principalList.length === 0) return undefined;

  const principals = normalizeAccessPrincipals(principalList);
  if (principals.length === 0) {
    return {
      predicate: sql`AND FALSE`,
      mode: RBAC_MODE_VISIBLE_SET,
      visibleCount: 0,
    };
  }

  const slackEntitySyncEnabled = opts?.slackEntitySyncEnabled ?? true;
  const cap = opts?.visibleSetCap ?? VISIBLE_SET_CAP;
  const visibleRows = await visibleFileIdsSql(
    {
      principals,
      slackEntitySyncEnabled,
      archived: "exclude",
    },
    cap + 1,
  ).execute(db);
  const visibleIds = [...new Set(visibleRows.rows.map((row) => row.id))];

  if (visibleIds.length <= cap) {
    return {
      predicate: sql`AND ${idInList(db, sql.ref("indexed_files.id"), visibleIds)}`,
      mode: RBAC_MODE_VISIBLE_SET,
      visibleCount: visibleIds.length,
    };
  }

  return {
    predicate: sql`AND ${fileAccessFilterSql(principalList, slackEntitySyncEnabled)}`,
    mode: RBAC_MODE_INLINE_RULE,
  };
}

function reportPostgresRbacStage(
  stageReport: StageReporter | undefined,
  principalCount: number,
  access: ResolvedAccessPredicate,
): void {
  stageReport?.({
    stage: "rbac",
    label: "Access filter",
    kind: "code",
    status: "done",
    summary: {
      principals: principalCount,
      mode: access.mode,
      ...(access.visibleCount !== undefined ? { visibleFiles: access.visibleCount } : {}),
      note: "predicate applied inside the FTS and KNN WHERE",
    },
  });
}

/** RRF constant — standard value from the original paper. */
const RRF_K = 60;

/** Score boost for files linked to entities matching the search query. */
const ENTITY_BOOST = 0.005;

/**
 * Hybrid search combining FTS5 keyword search and vector similarity.
 *
 * Opens its own transaction for the Postgres KNN reads, so it must not be called from
 * inside a caller's transaction: the inner COMMIT would end the outer one early. No
 * production caller does this today, and tests that need an ambient transaction get
 * their own database instead.
 *
 * Strategy:
 * 1. Run FTS search with access pre-filtering → ranked keyword results
 * 2. Run vector KNN search → ranked semantic results
 * 3. Merge via reciprocal rank fusion (RRF)
 * 4. Apply metadata filters (time, type, source)
 * 5. Post-filter SQLite vector candidates for access
 */
export async function hybridSearch(
  db: Kysely<DB>,
  query: string,
  opts?: HybridSearchOptions,
  internal?: HybridSearchInternalOptions,
): Promise<HybridSearchResult[]> {
  const limit = opts?.limit ?? 10;
  const candidateLimit = Math.max(limit * 40, 200);
  if (opts?.userPrincipals !== undefined && opts.userPrincipals.length === 0) return [];
  const principalList = opts?.userPrincipals ?? [];
  let scoredChunks: VectorChunkHit[] = [];
  /** Counted over every scored chunk, not the capped display slice. */
  let totalChunksScored = 0;
  let totalFieldVectors = 0;
  let totalImageVectors = 0;
  const ftsResults = new Map<string, { rank: number; snippet: string | null }>();
  const vecResults = new Map<string, { rank: number; similarity: number; snippet: string | null }>();
  const fileIdScope = opts?.fileIds && opts.fileIds.length > 0 ? new Set(opts.fileIds) : null;
  const sqliteEntityFileIdScope =
    !isPg(db) && opts?.queryEmbedding && opts.entityScope
      ? await resolveSqliteEntityScopeFileIds(db, opts.entityScope)
      : null;

  // ── 0. Build filter fragments ────────────────────────────────
  const fileIdFilter =
    opts?.fileIds && opts.fileIds.length > 0
      ? sql`AND ${idInList(db, sql.ref("indexed_files.id"), opts.fileIds)}`
      : sql``;
  const entityScopeFilter = opts?.entityScope
    ? sql`AND ${entityScopePredicateSql(sql.ref("indexed_files.id"), opts.entityScope)}`
    : sql``;
  const accessResolution =
    internal?.resolvedAccessPredicate ??
    (await resolveAccessPredicate(db, {
      userPrincipals: opts?.userPrincipals,
      accessBypassReason: opts?.accessBypassReason,
      slackEntitySyncEnabled: opts?.slackEntitySyncEnabled,
      visibleSetCap: internal?.visibleSetCap,
    }));
  if (isPg(db) && principalList.length > 0 && opts?.accessBypassReason !== "admin" && !accessResolution) {
    throw new Error("access predicate missing for a principal-scoped Postgres search");
  }
  if (accessResolution) {
    reportPostgresRbacStage(opts?.stageReport, principalList.length, accessResolution);
    if (accessResolution.mode === RBAC_MODE_VISIBLE_SET && accessResolution.visibleCount === 0) return [];
  }
  const accessFilter =
    isPg(db) && accessResolution
      ? accessResolution.predicate
      : !isPg(db) && principalList.length > 0
        ? sql`AND ${fileAccessFilterSql(principalList, opts?.slackEntitySyncEnabled ?? true)}`
        : null;
  // Push `kind` and `sources` into FTS so candidates outside the requested
  // kind don't crowd out matches; we'd otherwise lose them past `limit * 3`.
  const kindFilter = opts?.kindRules?.length ? kindFilterSql(opts.kindRules) : sql``;
  const sourcesFilter =
    opts?.sources && opts.sources.length > 0
      ? sql`AND indexed_files.source IN (${sql.join(
          opts.sources.map((s) => sql`${s}`),
          sql`,`,
        )})`
      : sql``;
  const extraFilter = extraFilterSql(opts);

  // ── 1. FTS keyword search ───────────────────────────────────
  if (isPg(db)) {
    const tsQuery = sanitizeTsQuery(query);
    if (tsQuery) {
      const pgFtsRows = await sql<{ id: string; rank: number }>`
        SELECT indexed_files.id, ts_rank(indexed_files.search_vector, plainto_tsquery('english', ${query})) as rank
        FROM indexed_files
        WHERE indexed_files.search_vector @@ plainto_tsquery('english', ${query})
        AND indexed_files.is_archived = 0
        AND ${bodylessCrmActivityPredicateSql()}
        ${fileIdFilter}
        ${entityScopeFilter}
        ${accessFilter ?? sql``}
        ${kindFilter}
        ${sourcesFilter}
        ${extraFilter}
        ORDER BY rank DESC
        LIMIT ${candidateLimit}
      `.execute(db);

      for (let i = 0; i < pgFtsRows.rows.length; i++) {
        const row = pgFtsRows.rows[i];
        ftsResults.set(row.id, { rank: i + 1, snippet: null });
      }
    }
  } else {
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery) {
      /**
       * BM25 weights are positional over the FTS5 columns, which migration 196 changed
       * to (file_name, summary, source_path). The old 10/1/3 was written when column two
       * was `source`, and left unchanged it ranks a folder-name match above a summary
       * match — the opposite of the Postgres side. 10/4/2 mirrors the ts_rank ratio
       * there (A=1.0, B=0.4, C=0.2), so both dialects agree that name beats summary
       * beats path.
       */
      const ftsRows = await sql<{
        id: string;
        rank: number;
      }>`
        SELECT indexed_files.id, bm25(indexed_files_fts, 10.0, 4.0, 2.0) as rank
        FROM indexed_files
        INNER JOIN indexed_files_fts ON indexed_files.rowid = indexed_files_fts.rowid
        WHERE indexed_files_fts MATCH ${ftsQuery}
        AND indexed_files.is_archived = 0
        AND ${bodylessCrmActivityPredicateSql()}
        ${fileIdFilter}
        ${entityScopeFilter}
        ${accessFilter ?? sql``}
        ${kindFilter}
        ${sourcesFilter}
        ${extraFilter}
        ORDER BY rank
        LIMIT ${candidateLimit}
      `.execute(db);

      for (let i = 0; i < ftsRows.rows.length; i++) {
        const row = ftsRows.rows[i];
        ftsResults.set(row.id, { rank: i + 1, snippet: null });
      }
    }
  }

  // ── 2. Vector search (chunk embeddings + file embeddings) ───
  if (opts?.queryEmbedding) {
    const embeddingJson = JSON.stringify(opts.queryEmbedding);
    const vecLimit = candidateLimit;

    let chunkRows: { rows: Array<{ indexed_file_id: string; chunk_content: string; distance: number }> };
    let fileRows: { rows: Array<{ indexed_file_id: string; distance: number }> };
    let fieldRows: { rows: Array<{ indexed_file_id: string; field: string; source_text: string; distance: number }> } =
      {
        rows: [],
      };

    if (isPg(db)) {
      const dims = EMBEDDING_DIMENSIONS;
      const vectorFilter = vectorPredicateSql(db, opts, accessFilter);

      /**
       * Both KNN reads run inside one transaction, because `SET LOCAL` outside a
       * transaction block is a no-op — Postgres emits a WARNING and the setting never
       * applies. Without the transaction the two settings below silently do nothing and
       * the pool stays capped at the 40-row default.
       *
       * `ef_search` must be at least the requested LIMIT: a non-iterative HNSW scan
       * returns at most `ef_search` rows, so asking for 400 with the default 40 silently
       * truncates the candidate pool. `iterative_scan` then covers the filtered case,
       * where a plain scan would hand back `ef_search` tuples and let the WHERE discard
       * most of them. `relaxed_order` is safe here because candidates are re-sorted by
       * distance in JS before ranks are assigned. In the inline-rule regime the visibility
       * rule sits in the WHERE and the scan stops at pgvector's default hnsw.max_scan_tuples,
       * which is enough because that regime only runs above VISIBLE_SET_CAP files.
       */
      const vectorRows = await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL hnsw.ef_search = ${sql.lit(hnswEfSearch(vecLimit))}`.execute(trx);
        await sql`SET LOCAL hnsw.iterative_scan = relaxed_order`.execute(trx);

        const chunks = await sql<{ indexed_file_id: string; chunk_content: string; distance: number }>`
          SELECT
            dc.indexed_file_id,
            dc.content as chunk_content,
            (ce.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})) as distance
          FROM chunk_embeddings ce
          INNER JOIN document_chunks dc ON dc.id = ce.chunk_id
          INNER JOIN indexed_files ON indexed_files.id = dc.indexed_file_id
          WHERE indexed_files.is_archived = 0
          ${vectorFilter}
          ORDER BY ce.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})
          LIMIT ${vecLimit}
        `.execute(trx);

        const files = await sql<{ indexed_file_id: string; distance: number }>`
          SELECT
            fe.indexed_file_id,
            (fe.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})) as distance
          FROM file_embeddings fe
          INNER JOIN indexed_files ON indexed_files.id = fe.indexed_file_id
          WHERE indexed_files.is_archived = 0
          ${vectorFilter}
          ORDER BY fe.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})
          LIMIT ${vecLimit}
        `.execute(trx);

        /** The file's own name and summary, as their own vectors. */
        const fields = await sql<{ indexed_file_id: string; field: string; source_text: string; distance: number }>`
          SELECT
            ffe.indexed_file_id,
            ffe.field,
            ffe.source_text,
            (ffe.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})) as distance
          FROM file_field_embeddings ffe
          INNER JOIN indexed_files ON indexed_files.id = ffe.indexed_file_id
          WHERE indexed_files.is_archived = 0
          ${vectorFilter}
          ORDER BY ffe.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})
          LIMIT ${vecLimit}
        `.execute(trx);

        return { chunks, files, fields };
      });
      chunkRows = vectorRows.chunks;
      fileRows = vectorRows.files;
      fieldRows = vectorRows.fields;
    } else {
      // Search chunk embeddings (text documents)
      chunkRows = await sql<{
        indexed_file_id: string;
        chunk_content: string;
        distance: number;
      }>`
        SELECT
          dc.indexed_file_id,
          dc.content as chunk_content,
          ce.distance
        FROM chunk_embeddings ce
        INNER JOIN document_chunks dc ON dc.id = ce.chunk_id
        WHERE ce.embedding MATCH ${embeddingJson}
          AND k = ${vecLimit}
        ORDER BY ce.distance ASC
      `.execute(db);

      // Search file embeddings (images)
      fileRows = await sql<{
        indexed_file_id: string;
        distance: number;
      }>`
        SELECT
          fe.indexed_file_id,
          fe.distance
        FROM file_embeddings fe
        WHERE fe.embedding MATCH ${embeddingJson}
          AND k = ${vecLimit}
        ORDER BY fe.distance ASC
      `.execute(db);
    }

    // Merge vector results — keep best distance per file
    let vecRank = 1;
    const allVecResults: Array<{
      fileId: string;
      distance: number;
      snippet: string | null;
    }> = [];

    // Deduplicate chunk results by file (keep best chunk per file)
    const bestChunkPerFile = new Map<string, { distance: number; snippet: string }>();
    for (const row of chunkRows.rows) {
      const existing = bestChunkPerFile.get(row.indexed_file_id);
      if (!existing || row.distance < existing.distance) {
        bestChunkPerFile.set(row.indexed_file_id, {
          distance: row.distance,
          snippet: row.chunk_content.slice(0, 200),
        });
      }
    }

    /**
     * One entry per file, at its best distance across every source: content chunks, the
     * image embedding, the file name and the summary. Taking the minimum matters — a
     * source-priority merge would let a mediocre content chunk mask a near-exact name
     * match, which is the case this whole change exists to fix.
     */
    const bestPerFile = new Map<string, { distance: number; snippet: string | null }>();
    const offer = (fileId: string, distance: number, snippet: string | null) => {
      const existing = bestPerFile.get(fileId);
      if (!existing || distance < existing.distance) bestPerFile.set(fileId, { distance, snippet });
    };
    for (const [fileId, data] of bestChunkPerFile) offer(fileId, data.distance, data.snippet);
    for (const row of fileRows.rows) offer(row.indexed_file_id, row.distance, null);
    for (const row of fieldRows.rows) offer(row.indexed_file_id, row.distance, row.source_text.slice(0, 200));
    for (const [fileId, data] of bestPerFile) {
      allVecResults.push({ fileId, distance: data.distance, snippet: data.snippet });
    }

    /**
     * Vector-grain capture for the trace, ranked across every source rather than per
     * source. A file is reachable through four independent vectors — its content chunks,
     * its name, its summary, and (for images) its file embedding — so a hit is only
     * legible if the trace says which one matched and with what text.
     *
     * `bestForFile` is read off `bestPerFile`, not off the chunk map: a content chunk
     * that lost the file to a closer summary vector has not survived into the fusion,
     * and marking it green would misreport exactly the case this change exists to show.
     */
    if (opts?.stageReport) {
      /**
       * Postgres pushes the entity scope into the KNN SQL, but the SQLite arm cannot and
       * filters in JS further down. Applying the scope here keeps the trace honest on
       * both dialects: without it a scoped SQLite search shows — and credits — vectors
       * belonging to files that never reach the result set. On Postgres this is a no-op,
       * because the rows arrived scoped already.
       */
      const inScope = (fileId: string) =>
        (!fileIdScope || fileIdScope.has(fileId)) && (!sqliteEntityFileIdScope || sqliteEntityFileIdScope.has(fileId));

      const hits: ScoredVector[] = [];
      for (const row of chunkRows.rows) {
        if (!inScope(row.indexed_file_id)) continue;
        totalChunksScored++;
        hits.push({
          fileId: row.indexed_file_id,
          source: "content",
          preview: row.chunk_content.slice(0, 240),
          distance: row.distance,
        });
      }
      for (const row of fieldRows.rows) {
        if (!inScope(row.indexed_file_id)) continue;
        totalFieldVectors++;
        hits.push({
          fileId: row.indexed_file_id,
          source: row.field === "file_name" ? "file_name" : "summary",
          preview: row.source_text.slice(0, 240),
          distance: row.distance,
        });
      }
      for (const row of fileRows.rows) {
        if (!inScope(row.indexed_file_id)) continue;
        totalImageVectors++;
        hits.push({ fileId: row.indexed_file_id, source: "image", preview: "", distance: row.distance });
      }
      scoredChunks = selectVectorHitsForDisplay(rankVectorHits(hits), VECTOR_HIT_DISPLAY_CAP);
    }

    // Filter by file IDs if entity-scoped
    const filteredVecResults = allVecResults.filter(
      (result) =>
        (!fileIdScope || fileIdScope.has(result.fileId)) &&
        (!sqliteEntityFileIdScope || sqliteEntityFileIdScope.has(result.fileId)),
    );

    // Sort by distance (ascending) and assign ranks
    filteredVecResults.sort((a, b) => a.distance - b.distance);
    for (const item of filteredVecResults) {
      // Convert distance to similarity (cosine distance → similarity)
      const similarity = 1 - item.distance;
      vecResults.set(item.fileId, {
        rank: vecRank++,
        similarity: Math.max(0, similarity),
        snippet: item.snippet,
      });
    }
  }

  opts?.stageReport?.({
    stage: "ftsCandidates",
    label: "Keyword candidates",
    kind: "code",
    status: "done",
    summary: {
      candidates: ftsResults.size,
      dialect: isPg(db) ? "ts_rank" : "bm25",
      sanitisedQuery: isPg(db) ? sanitizeTsQuery(query) : sanitizeFtsQuery(query),
      candidateLimit,
    },
  });
  opts?.stageReport?.(
    opts?.queryEmbedding
      ? {
          stage: "vectorCandidates",
          label: "Vector candidates",
          kind: "code",
          status: "done",
          summary: {
            chunksScored: totalChunksScored,
            fieldVectorsScored: totalFieldVectors,
            imageVectorsScored: totalImageVectors,
            hitsShown: scoredChunks.length,
            filesAfterDedup: vecResults.size,
            candidateLimit,
          },
          vectorChunks: scoredChunks,
        }
      : {
          stage: "vectorCandidates",
          label: "Vector candidates",
          kind: "code",
          status: "skipped",
          error: "No query embedding — keyword-only search",
        },
  );

  // ── 3. Merge via RRF ───────────────────────────────────────
  const allFileIds = new Set([...ftsResults.keys(), ...vecResults.keys()]);
  const entityFileIds = opts?.entityBoostEntityIds?.length
    ? await findEntityLinkedFileIds(db, [...allFileIds], opts.entityBoostEntityIds)
    : undefined;
  const scored: Array<{ fileId: string; score: number; snippet: string | null; similarity: number | null }> = [];

  for (const fileId of allFileIds) {
    const fts = ftsResults.get(fileId);
    const vec = vecResults.get(fileId);

    // RRF: score = sum of 1/(k + rank) for each ranking the doc appears in
    let score = 0;
    if (fts) score += 1 / (RRF_K + fts.rank);
    if (vec) score += 1 / (RRF_K + vec.rank);

    // Entity boost: files linked to entities matching the query get a score bump
    if (entityFileIds?.has(fileId)) {
      score += ENTITY_BOOST;
    }

    scored.push({
      fileId,
      score,
      snippet: vec?.snippet ?? null,
      similarity: vec?.similarity ?? null,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  opts?.stageReport?.({
    stage: "fuse",
    label: "Fuse rankings",
    kind: "code",
    status: "done",
    summary: {
      rrfK: RRF_K,
      entityBoost: ENTITY_BOOST,
      boostedFiles: entityFileIds?.size ?? 0,
      scored: scored.length,
    },
  });

  // ── 4. Fetch file metadata and apply filters ────────────────
  const topFileIds = scored.slice(0, candidateLimit).map((s) => s.fileId);
  if (topFileIds.length === 0) {
    /**
     * Nothing scored, so the remaining stages never execute. They still report — a trace
     * that simply stops is indistinguishable from one that crashed, and "no candidates
     * survived scoring" is the answer someone opened the trace to find.
     */
    if (!isPg(db) && principalList.length > 0 && opts?.accessBypassReason !== "admin") {
      opts?.stageReport?.({
        stage: "rbac",
        label: "Access filter",
        kind: "code",
        status: "done",
        summary: {
          principals: principalList.length,
          mode: RBAC_MODE_SQLITE,
          allowed: 0,
          denied: 0,
        },
      });
    }
    if (!accessResolution && (isPg(db) || principalList.length === 0 || opts?.accessBypassReason === "admin")) {
      opts?.stageReport?.({
        stage: "rbac",
        label: "Access filter",
        kind: "code",
        status: "skipped",
        error: "No candidates were scored — keyword and vector search both returned nothing",
      });
    }
    reportNoScoredCandidateRemainder(
      opts?.stageReport,
      "No candidates were scored — keyword and vector search both returned nothing",
    );
    return [];
  }

  const scoreMap = new Map(scored.map((s) => [s.fileId, s]));

  // Build metadata query with filters
  let metaQuery = db
    .selectFrom("indexed_files")
    .select([
      "id",
      "file_name",
      "source",
      "content_category",
      "summary",
      "connector_config_id",
      "thread_id",
      "file_type",
      "provider_file_id",
      "provider_url",
      "source_path",
      "rollup_group_id",
      "source_updated_at",
      "source_created_at",
      "source_meta",
      "access_scope_id",
    ])
    .where(idInList(db, sql.ref("indexed_files.id"), topFileIds))
    .where("is_archived", "=", 0)
    .where(bodylessCrmActivityPredicateSql());

  if (opts?.source) {
    metaQuery = metaQuery.where("source", "=", opts.source);
  }
  if (opts?.sources && opts.sources.length > 0) {
    metaQuery = metaQuery.where("source", "in", opts.sources);
  }
  if (opts?.kindRules?.length) {
    const rules = opts.kindRules;
    metaQuery = metaQuery.where((eb) =>
      eb.or(
        rules.map((r) => {
          const conds = [];
          if (r.sources?.length) conds.push(eb("indexed_files.source", "in", r.sources));
          if (r.fileTypes?.length) conds.push(eb("indexed_files.file_type", "in", r.fileTypes));
          if (conds.length === 0) return eb.val(true);
          return conds.length === 1 ? conds[0] : eb.and(conds);
        }),
      ),
    );
  }
  if (opts?.category) {
    metaQuery = metaQuery.where("content_category", "=", opts.category);
  }
  if (opts?.contentTypes && opts.contentTypes.length > 0) {
    metaQuery = metaQuery.where("content_category", "in", opts.contentTypes);
  }
  metaQuery = metaQuery.where(sql<SqlBool>`TRUE ${extraFilterSql(opts)}`);

  const files = await metaQuery.execute();

  // ── 5. Apply time filter ────────────────────────────────────
  let filteredFiles = files;
  if (opts?.timeFilter) {
    const { after, before } = opts.timeFilter;

    if (after || before) {
      // Get file IDs that match time filter via timeframes
      const timeframeFileIds = new Set<string>();

      if (after || before) {
        let tfQuery = db
          .selectFrom("document_timeframes")
          .select("indexed_file_id")
          .where("indexed_file_id", "in", topFileIds);

        if (after) {
          tfQuery = tfQuery.where("end_date", ">=", after);
        }
        if (before) {
          tfQuery = tfQuery.where("start_date", "<=", before);
        }
        const tfRows = await tfQuery.execute();
        for (const row of tfRows) {
          timeframeFileIds.add(row.indexed_file_id);
        }
      }

      filteredFiles = files.filter((f) => {
        // Match on file metadata dates OR content timeframes
        const fileDate = f.source_created_at || f.source_updated_at;
        const matchesFileDate = fileDate && (!after || fileDate >= after) && (!before || fileDate <= before);
        const matchesTimeframe = timeframeFileIds.has(f.id);
        return matchesFileDate || matchesTimeframe;
      });
    }
  }

  const dropAttribution = opts?.stageReport
    ? await attributeFilterDrops(db, topFileIds, files, filteredFiles, opts)
    : undefined;
  opts?.stageReport?.({
    stage: "filter",
    label: "Metadata filters",
    kind: "code",
    status: "done",
    summary: {
      scored: topFileIds.length,
      survivedSqlFilters: files.length,
      survivedTimeFilter: filteredFiles.length,
      attributionAvailable: dropAttribution !== undefined,
    },
    outcomes: describeFilters(opts).map((entry) => ({
      subject: entry.label,
      kind: entry.field,
      result: entry.applied ? ("kept" as const) : ("suppressed" as const),
      reason: entry.detail,
    })),
  });

  // ── 6. Apply RBAC ──────────────────────────────────────────
  let accessFiltered = filteredFiles;

  /**
   * Postgres candidates all arrive pre-filtered. SQLite pre-filters FTS but its vector
   * arm has no indexed_files join, so vector-only hits are post-filtered here. Keeping
   * that SQLite check deliberately departs from D8's original drop-post-filter plan.
   */
  if (!isPg(db) && principalList.length > 0 && filteredFiles.length > 0) {
    const fileIds = filteredFiles.map((f) => f.id);

    const accessRows = await sql<{ id: string }>`
      SELECT indexed_files.id
      FROM indexed_files
      WHERE indexed_files.id IN (${sql.join(
        fileIds.map((id) => sql`${id}`),
        sql`,`,
      )})
      AND ${fileAccessFilterSql(principalList, opts?.slackEntitySyncEnabled ?? true)}
    `.execute(db);

    const allowedIds = new Set(accessRows.rows.map((r) => r.id));
    accessFiltered = filteredFiles.filter((f) => allowedIds.has(f.id));
  }

  if (!isPg(db) || principalList.length === 0 || opts?.accessBypassReason === "admin") {
    opts?.stageReport?.({
      stage: "rbac",
      label: "Access filter",
      kind: "code",
      status: principalList.length > 0 ? "done" : "skipped",
      ...(opts?.accessBypassReason === "admin"
        ? { error: "skipped — admin bypass" }
        : principalList.length > 0
          ? {
              summary: {
                principals: principalList.length,
                mode: RBAC_MODE_SQLITE,
                allowed: accessFiltered.length,
                denied: filteredFiles.length - accessFiltered.length,
              },
              outcomes: (() => {
                const allowed = new Set(accessFiltered.map((file) => file.id));
                return filteredFiles.map((file) => ({
                  subject: file.file_name,
                  kind: file.source,
                  result: allowed.has(file.id) ? ("kept" as const) : ("dropped" as const),
                  reason: allowed.has(file.id) ? "visible to these principals" : "no matching access principal",
                }));
              })(),
            }
          : { error: "No principals supplied — access filter not applied" }),
    });
  }

  // ── 7. Build final results ─────────────────────────────────
  const collapseRan = !opts?.expandThreads;
  const collapsed = collapseRan
    ? await collapseThreadSearchResults(
        db,
        accessFiltered,
        scoreMap,
        opts?.userPrincipals,
        opts?.slackEntitySyncEnabled ?? true,
      )
    : accessFiltered.map((file) => fileSearchResult(file, scoreMap.get(file.id)));

  const results: HybridSearchResult[] = collapsed.sort((a, b) => b.score - a.score).slice(0, limit);

  if (opts?.stageReport) {
    opts.stageReport({
      stage: "finalize",
      label: "Collapse and slice",
      kind: "code",
      status: "done",
      summary: {
        beforeCollapse: accessFiltered.length,
        afterCollapse: collapsed.length,
        limit,
        returned: results.length,
        droppedByLimit: Math.max(0, collapsed.length - results.length),
      },
      outcomes: collapsed
        .slice()
        .sort((a, b) => b.score - a.score)
        .map((result, index) => ({
          subject: result.fileName,
          kind: result.resultKind !== "file" ? `thread of ${result.messageCount ?? "?"}` : result.source,
          result: index < limit ? ("kept" as const) : ("dropped" as const),
          reason:
            index < limit
              ? `returned at position ${index + 1}, score ${result.score.toFixed(5)}`
              : `cut by limit ${limit} (would have been ${index + 1})`,
        })),
      candidates: draftCandidates({
        scored,
        ftsResults,
        vecResults,
        entityFileIds,
        attribution: dropAttribution,
        accessFiltered,
        collapsed,
        filteredFiles,
        collapseRan,
      }),
    });
  }

  return results;
}

/**
 * The subset of the metadata predicates that can be pushed into the KNN query.
 *
 * Previously the vector arm carried no WHERE at all: it took the globally nearest rows and
 * filtered afterwards in JS, so a filtered search spent its whole candidate budget on rows
 * it was about to discard. Entity-scoped searches were the worst case — a scope covering a
 * small fraction of the corpus expected almost no surviving candidates.
 *
 * Time stays out because it wants a plan measured against a real corpus before being
 * pushed down. On Postgres, RBAC is included so selective visibility cannot consume the
 * candidate budget before fusion.
 */
function vectorPredicateSql(db: Kysely<DB>, opts: HybridSearchOptions, accessFilter: RawBuilder<unknown> | null) {
  const requiredPredicate = sql`AND ${bodylessCrmActivityPredicateSql()}`;
  const parts = [];
  if (opts.fileIds && opts.fileIds.length > 0) {
    parts.push(sql`AND ${idInList(db, sql.ref("indexed_files.id"), opts.fileIds)}`);
  }
  if (opts.entityScope) {
    parts.push(sql`AND ${entityScopePredicateSql(sql.ref("indexed_files.id"), opts.entityScope)}`);
  }
  if (opts.source) parts.push(sql`AND indexed_files.source = ${opts.source}`);
  if (opts.sources && opts.sources.length > 0) {
    parts.push(
      sql`AND indexed_files.source IN (${sql.join(
        opts.sources.map((value) => sql`${value}`),
        sql`,`,
      )})`,
    );
  }
  if (opts.category) parts.push(sql`AND indexed_files.content_category = ${opts.category}`);
  if (opts.kindRules?.length) parts.push(kindFilterSql(opts.kindRules));
  parts.push(extraFilterSql(opts));
  if (accessFilter) parts.push(accessFilter);
  return sql`${requiredPredicate} ${sql.join(parts, sql` `)}`;
}

/**
 * Which predicates the metadata query actually carried, and which were absent.
 *
 * "no filters set" and "filters set but nothing matched" look identical from counts alone,
 * so the trace states each predicate rather than leaving it to be inferred.
 */
function describeFilters(opts: HybridSearchOptions): Array<{
  field: string;
  label: string;
  applied: boolean;
  detail: string;
}> {
  return [
    { field: "source", label: "Source", value: opts.source ?? null, shown: opts.source ?? "" },
    {
      field: "sources",
      label: "Sources",
      value: opts.sources?.length ? opts.sources : null,
      shown: (opts.sources ?? []).join(", "),
    },
    {
      field: "kind",
      label: "Kind rules",
      value: opts.kindRules?.length ? opts.kindRules : null,
      shown: `${opts.kindRules?.length ?? 0} rule(s)`,
    },
    {
      field: "fileTypes",
      label: "File types",
      value: opts.fileTypes?.length ? opts.fileTypes : null,
      shown: (opts.fileTypes ?? []).join(", "),
    },
    { field: "threadId", label: "Thread ID", value: opts.threadId ?? null, shown: opts.threadId ?? "" },
    {
      field: "parentRecordId",
      label: "Parent record ID",
      value: opts.parentRecordId ?? null,
      shown: opts.parentRecordId ?? "",
    },
    {
      field: "participantEmail",
      label: "Participant email",
      value: opts.participantEmail ?? null,
      shown: opts.participantEmail ?? "",
    },
    { field: "domain", label: "Participant domain", value: opts.domain ?? null, shown: opts.domain ?? "" },
    {
      field: "crmFields",
      label: "CRM fields",
      value: crmFieldFilterEntries(opts.crmFields).length > 0 ? opts.crmFields : null,
      shown: crmFieldFilterEntries(opts.crmFields)
        .map(([field, value]) => `${field}=${value}`)
        .join(", "),
    },
    { field: "category", label: "Category", value: opts.category ?? null, shown: opts.category ?? "" },
    {
      field: "contentTypes",
      label: "Content types",
      value: opts.contentTypes?.length ? opts.contentTypes : null,
      shown: (opts.contentTypes ?? []).join(", "),
    },
    {
      field: "time",
      label: "Time range",
      value: opts.timeFilter?.after || opts.timeFilter?.before ? opts.timeFilter : null,
      shown: `${opts.timeFilter?.after ?? "…"} → ${opts.timeFilter?.before ?? "…"}`,
    },
    {
      field: "fileIds",
      label: "File ID scope",
      value: opts.fileIds?.length ? opts.fileIds : null,
      shown: `${opts.fileIds?.length ?? 0} file(s)`,
    },
    {
      field: "entityScope",
      label: "Entity scope",
      value: opts.entityScope ?? null,
      shown: `${opts.entityScope?.entityIds.length ?? 0} entity/entities (${opts.entityScope?.mode ?? "and"})`,
    },
    { field: "archived", label: "Archived excluded", value: true, shown: "is_archived = 0" },
    {
      field: "bodylessCrmActivities",
      label: "Bodyless CRM activities hidden",
      value: true,
      shown: "structured CRM activity types summarized on parent objects",
    },
  ].map((entry) => ({
    field: entry.field,
    label: entry.label,
    applied: entry.value !== null,
    detail: entry.value !== null ? entry.shown : "not set",
  }));
}

/**
 * Why each scored file is missing from the metadata result set.
 *
 * Vector candidates are filtered by neither kind, source nor category — only by `fileIds`,
 * in JS — so a file of the wrong kind reaches the fuse and then vanishes when the metadata
 * SQL folds every predicate into one WHERE. At that point the row is gone and with it the
 * file's own name, so reconstructing the reason needs one deliberately unfiltered read.
 *
 * Runs only when a stage reporter is attached, and never propagates: a fault in
 * attribution must degrade the trace, not fail the search that is being traced.
 */
async function attributeFilterDrops(
  db: Kysely<DB>,
  scoredFileIds: string[],
  survivedSql: SearchMetadataFile[],
  survivedTime: SearchMetadataFile[],
  opts: HybridSearchOptions,
): Promise<Map<string, { fileName: string; source: string; droppedAt: StageKey; dropReason: string }> | undefined> {
  try {
    const attribution = new Map<
      string,
      { fileName: string; source: string; droppedAt: StageKey; dropReason: string }
    >();
    if (scoredFileIds.length === 0) return attribution;

    const rows = await db
      .selectFrom("indexed_files")
      .select([
        "id",
        "file_name",
        "source",
        "content_category",
        "file_type",
        "thread_id",
        "rollup_group_id",
        "is_archived",
      ])
      .where(idInList(db, sql.ref("indexed_files.id"), scoredFileIds))
      .execute();
    const participantEmails =
      opts.participantEmail || opts.domain ? await loadParticipantEmailsForFiles(db, scoredFileIds) : new Map();
    const crmFields = crmFieldFilterEntries(opts.crmFields).length
      ? await loadCrmFieldsForFiles(db, scoredFileIds)
      : new Map();

    const survivedSqlIds = new Set(survivedSql.map((file) => file.id));
    const survivedTimeIds = new Set(survivedTime.map((file) => file.id));

    for (const row of rows) {
      const identity = { fileName: row.file_name, source: row.source };
      if (!survivedSqlIds.has(row.id)) {
        attribution.set(row.id, {
          ...identity,
          droppedAt: "filter",
          dropReason: sqlFilterReason(row, opts, participantEmails.get(row.id) ?? [], crmFields.get(row.id) ?? []),
        });
        continue;
      }
      if (!survivedTimeIds.has(row.id)) {
        attribution.set(row.id, { ...identity, droppedAt: "filter", dropReason: "outside the requested time range" });
        continue;
      }
      attribution.set(row.id, { ...identity, droppedAt: "filter", dropReason: "" });
    }
    return attribution;
  } catch {
    return undefined;
  }
}

/**
 * Mirrors the predicates the metadata query folds into its WHERE. Pinned by test against
 * the SQL on both dialects — the day these drift, the trace starts lying.
 */
function sqlFilterReason(
  row: {
    is_archived: number;
    source: string;
    content_category: string;
    file_type: string | null;
    thread_id: string | null;
    rollup_group_id: string | null;
  },
  opts: HybridSearchOptions,
  participantEmails: string[],
  crmFields: Array<{ field: string; valueNorm: string }>,
): string {
  if (row.is_archived !== 0) return "archived";
  if (isBodylessCrmActivity(row)) return "bodyless CRM activity summarized on its parent object";
  if (opts.source && row.source !== opts.source) return `source is ${row.source}, not ${opts.source}`;
  if (opts.sources?.length && !opts.sources.includes(row.source))
    return `source ${row.source} not in the requested set`;
  if (opts.fileTypes?.length && !opts.fileTypes.includes(row.file_type ?? "")) {
    return `file type ${row.file_type ?? "none"} not in the requested set`;
  }
  if (opts.threadId && row.thread_id !== opts.threadId) {
    return `threadId is ${row.thread_id ?? "none"}, not ${opts.threadId}`;
  }
  if (opts.parentRecordId && row.rollup_group_id !== opts.parentRecordId) {
    return `parentRecordId is ${row.rollup_group_id ?? "none"}, not ${opts.parentRecordId}`;
  }
  if (opts.participantEmail) {
    const requested = opts.participantEmail.toLowerCase();
    if (!participantEmails.some((email) => email.toLowerCase() === requested)) {
      return `no attendee or correspondent fact for ${opts.participantEmail}`;
    }
  }
  const domain = normalizeDomainFilter(opts.domain);
  if (domain) {
    const suffix = `@${domain}`;
    if (!participantEmails.some((email) => email.toLowerCase().endsWith(suffix))) {
      return `no attendee or correspondent fact from domain ${domain}`;
    }
  }
  for (const [field, value] of crmFieldFilterEntries(opts.crmFields)) {
    const valueNorm = normalizeCrmRecordFieldValue(value);
    if (!crmFields.some((row) => row.field === field && row.valueNorm === valueNorm)) {
      return `no CRM field ${field}=${value}`;
    }
  }
  if (opts.category && row.content_category !== opts.category) {
    return `category is ${row.content_category}, not ${opts.category}`;
  }
  if (opts.contentTypes?.length && !opts.contentTypes.includes(row.content_category)) {
    return `content type ${row.content_category} not in the requested set`;
  }
  if (opts.kindRules?.length) {
    const matches = opts.kindRules.some((rule) => {
      const sourceOk = rule.sources?.length ? rule.sources.includes(row.source) : true;
      const typeOk = rule.fileTypes?.length ? rule.fileTypes.includes(row.file_type ?? "") : true;
      return rule.sources?.length || rule.fileTypes?.length ? sourceOk && typeOk : true;
    });
    if (!matches) return `does not match the requested kind (source ${row.source}, type ${row.file_type ?? "none"})`;
  }
  return "excluded by a metadata filter";
}

async function loadCrmFieldsForFiles(
  db: Kysely<DB>,
  fileIds: string[],
): Promise<Map<string, Array<{ field: string; valueNorm: string }>>> {
  const rows = await createCrmRecordFieldsRepository(db).listForFiles(fileIds);
  const byFile = new Map<string, Array<{ field: string; valueNorm: string }>>();
  for (const row of rows) {
    const fields = byFile.get(row.indexed_file_id) ?? [];
    fields.push({ field: row.field, valueNorm: row.value_norm });
    byFile.set(row.indexed_file_id, fields);
  }
  return byFile;
}

async function loadParticipantEmailsForFiles(db: Kysely<DB>, fileIds: string[]): Promise<Map<string, string[]>> {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select(["indexed_file_id", "subject_email"])
    .where("indexed_file_id", "in", fileIds)
    .where("deleted_at", "is", null)
    .where("fact_type", "in", ["attendee", "correspondent"])
    .where("subject_email", "is not", null)
    .execute();
  const byFile = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.indexed_file_id || !row.subject_email) continue;
    const emails = byFile.get(row.indexed_file_id) ?? [];
    emails.push(row.subject_email);
    byFile.set(row.indexed_file_id, emails);
  }
  return byFile;
}

/**
 * One row per scored candidate, with positions left null.
 *
 * Final positions cannot be assigned here: `search()` may still re-sort for recency, and
 * the Search tool applies its own post-sort after that. The caller fills them in once the
 * order the caller actually received is known.
 */
function draftCandidates(input: {
  scored: Array<{ fileId: string; score: number; similarity: number | null }>;
  ftsResults: Map<string, { rank: number }>;
  vecResults: Map<string, { rank: number; similarity: number }>;
  entityFileIds?: Set<string>;
  attribution?: Map<string, { fileName: string; source: string; droppedAt: StageKey; dropReason: string }>;
  accessFiltered: SearchMetadataFile[];
  collapsed: HybridSearchResult[];
  filteredFiles: SearchMetadataFile[];
  collapseRan: boolean;
}): SearchCandidate[] {
  const allowedIds = new Set(input.accessFiltered.map((file) => file.id));
  const timeSurvivorIds = new Set(input.filteredFiles.map((file) => file.id));
  const identity = new Map(input.accessFiltered.map((file) => [file.id, file]));
  const survivingHits = new Set(input.collapsed.map((result) => result.hitFileId));
  const threadOf = new Map<string, string>();
  for (const file of input.accessFiltered) {
    if (!input.collapseRan) continue;
    if (file.file_type === "email_message" || (file.file_type === "linkedin_conversation" && file.thread_id)) {
      threadOf.set(file.id, `${file.connector_config_id}:${file.thread_id ?? file.id}`);
    }
  }

  return input.scored.map((entry) => {
    const attributed = input.attribution?.get(entry.fileId);
    const file = identity.get(entry.fileId);
    const base: SearchCandidate = {
      fileId: entry.fileId,
      fileName: file?.file_name ?? attributed?.fileName ?? entry.fileId,
      source: file?.source ?? attributed?.source ?? "unknown",
      ftsRank: input.ftsResults.get(entry.fileId)?.rank ?? null,
      vecRank: input.vecResults.get(entry.fileId)?.rank ?? null,
      similarity: entry.similarity,
      boosted: input.entityFileIds?.has(entry.fileId) ?? false,
      score: entry.score,
      finalPosition: null,
      droppedAt: null,
      dropReason: null,
      mergedInto: null,
    };

    if (!timeSurvivorIds.has(entry.fileId)) {
      return {
        ...base,
        droppedAt: "filter",
        dropReason: attributed?.dropReason || "excluded by a metadata filter",
      };
    }
    if (!allowedIds.has(entry.fileId)) {
      return { ...base, droppedAt: "rbac", dropReason: "no matching access principal" };
    }
    if (!survivingHits.has(entry.fileId)) {
      const thread = threadOf.get(entry.fileId);
      return thread
        ? { ...base, mergedInto: thread }
        : { ...base, droppedAt: "finalize", dropReason: "below the result limit" };
    }
    return base;
  });
}

type SearchMetadataFile = {
  id: string;
  file_name: string;
  source: string;
  content_category: string;
  summary: string | null;
  connector_config_id: string;
  thread_id: string | null;
  file_type: string | null;
  provider_file_id: string;
  provider_url: string | null;
  source_path: string | null;
  rollup_group_id: string | null;
  source_updated_at: string | null;
  source_created_at: string | null;
  source_meta: string | null;
  access_scope_id: string | null;
};

type SearchScoreData = { fileId: string; score: number; snippet: string | null; similarity: number | null };

function fileSearchResult(file: SearchMetadataFile, scoreData: SearchScoreData | undefined): HybridSearchResult {
  return {
    resultKind: "file",
    id: file.id,
    hitFileId: file.id,
    fileName: file.file_name,
    source: file.source,
    contentCategory: file.content_category,
    summary: file.summary,
    providerFileId: file.provider_file_id,
    providerUrl: file.provider_url,
    sourcePath: file.source_path,
    sourceUpdatedAt: file.source_updated_at,
    sourceCreatedAt: file.source_created_at,
    snippet: scoreData?.snippet ?? null,
    similarity: scoreData?.similarity ?? null,
    score: scoreData?.score ?? 0,
    threadId: file.thread_id,
    rollupGroupId: file.rollup_group_id,
  };
}

type EmailEnvelopeSearchRow = {
  indexed_file_id: string;
  connector_config_id: string;
  thread_id: string | null;
  subject: string | null;
  sent_at: string | null;
  from_json: string;
  to_json: string;
  cc_json: string;
};

type LinkedInSegmentManifest = {
  messageCount?: number;
  inboundCount?: number;
  outboundCount?: number;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
};

function readLinkedInSegmentManifest(file: Pick<SearchMetadataFile, "source_meta">): LinkedInSegmentManifest {
  const meta = readSourceMeta(file);
  const raw = meta?.segmentManifest;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const manifest = raw as Record<string, unknown>;
  return {
    messageCount: typeof manifest.messageCount === "number" ? manifest.messageCount : undefined,
    inboundCount: typeof manifest.inboundCount === "number" ? manifest.inboundCount : undefined,
    outboundCount: typeof manifest.outboundCount === "number" ? manifest.outboundCount : undefined,
    lastInboundAt:
      typeof manifest.lastInboundAt === "string" || manifest.lastInboundAt === null
        ? manifest.lastInboundAt
        : undefined,
    lastOutboundAt:
      typeof manifest.lastOutboundAt === "string" || manifest.lastOutboundAt === null
        ? manifest.lastOutboundAt
        : undefined,
  };
}

function summarizeLinkedInSegments(segments: SearchMetadataFile[]): {
  messageCount: number;
  inboundCount: number;
  outboundCount: number;
  lastActivity: string | null;
  lastMessageFrom: "them" | "us" | null;
} {
  let messageCount = 0;
  let inboundCount = 0;
  let outboundCount = 0;
  let lastActivity: string | null = null;
  let lastInboundAt: string | null = null;
  let lastOutboundAt: string | null = null;

  for (const segment of segments) {
    const manifest = readLinkedInSegmentManifest(segment);
    messageCount += manifest.messageCount ?? 0;
    inboundCount += manifest.inboundCount ?? 0;
    outboundCount += manifest.outboundCount ?? 0;
    if (segment.source_updated_at && (!lastActivity || segment.source_updated_at > lastActivity)) {
      lastActivity = segment.source_updated_at;
    }
    if (manifest.lastInboundAt && (!lastInboundAt || manifest.lastInboundAt > lastInboundAt)) {
      lastInboundAt = manifest.lastInboundAt;
    }
    if (manifest.lastOutboundAt && (!lastOutboundAt || manifest.lastOutboundAt > lastOutboundAt)) {
      lastOutboundAt = manifest.lastOutboundAt;
    }
  }

  const lastMessageFrom =
    lastInboundAt && lastOutboundAt
      ? lastInboundAt > lastOutboundAt
        ? "them"
        : "us"
      : lastInboundAt
        ? "them"
        : lastOutboundAt
          ? "us"
          : null;

  return { messageCount, inboundCount, outboundCount, lastActivity, lastMessageFrom };
}

function emailLabel(addr: EmailAddr): string {
  return addr.name?.trim() || addr.email;
}

async function collapseThreadSearchResults(
  db: Kysely<DB>,
  files: SearchMetadataFile[],
  scoreMap: Map<string, SearchScoreData>,
  userPrincipals?: AccessPrincipalInput[],
  slackEntitySyncEnabled = true,
): Promise<HybridSearchResult[]> {
  const emailFiles = files.filter((file) => file.file_type === "email_message");
  const linkedinFiles = files.filter((file) => file.file_type === "linkedin_conversation" && file.thread_id);
  const visibleThreadEnvelopes = await loadVisibleThreadEnvelopes(
    db,
    emailFiles,
    userPrincipals,
    slackEntitySyncEnabled,
  );
  const visibleLinkedInSegments = await loadVisibleLinkedInThreadSegments(
    db,
    linkedinFiles,
    userPrincipals,
    slackEntitySyncEnabled,
  );
  const emailGroups = new Map<string, SearchMetadataFile[]>();
  const linkedinGroups = new Map<string, SearchMetadataFile[]>();
  const output: HybridSearchResult[] = [];

  for (const file of files) {
    if (file.file_type === "email_message") {
      const key = `${file.connector_config_id}:${file.thread_id ?? file.id}`;
      const group = emailGroups.get(key) ?? [];
      group.push(file);
      emailGroups.set(key, group);
      continue;
    }

    if (file.file_type === "linkedin_conversation" && file.thread_id) {
      const key = `${file.connector_config_id}:${file.thread_id}`;
      const group = linkedinGroups.get(key) ?? [];
      group.push(file);
      linkedinGroups.set(key, group);
      continue;
    }

    output.push(fileSearchResult(file, scoreMap.get(file.id)));
  }

  for (const [threadKey, group] of emailGroups) {
    const best = [...group].sort((a, b) => (scoreMap.get(b.id)?.score ?? 0) - (scoreMap.get(a.id)?.score ?? 0))[0];
    const bestScore = scoreMap.get(best.id);
    const envelopes = visibleThreadEnvelopes.get(threadKey) ?? [];
    const latest = [...envelopes].sort((a, b) => {
      if (a.sent_at && b.sent_at && a.sent_at !== b.sent_at) return b.sent_at.localeCompare(a.sent_at);
      if (a.sent_at && !b.sent_at) return -1;
      if (!a.sent_at && b.sent_at) return 1;
      return b.indexed_file_id.localeCompare(a.indexed_file_id);
    })[0];
    const participants = new Map<string, string>();
    for (const envelope of envelopes) {
      for (const addr of [
        parseEmailAddrJson(envelope.from_json),
        ...parseEmailAddrListJson(envelope.to_json),
        ...parseEmailAddrListJson(envelope.cc_json),
      ]) {
        if (!participants.has(addr.email)) participants.set(addr.email, emailLabel(addr));
      }
    }

    output.push({
      resultKind: "email_thread",
      id: best.id,
      hitFileId: best.id,
      threadKey,
      messageCount: envelopes.length || group.length,
      latestSubject: latest?.subject ?? best.file_name,
      lastActivity: latest?.sent_at ?? best.source_created_at ?? best.source_updated_at,
      participants: [...participants.values()].slice(0, 6),
      fileName: latest?.subject ?? best.file_name,
      source: best.source,
      contentCategory: best.content_category,
      summary: best.summary,
      providerFileId: best.provider_file_id,
      providerUrl: best.provider_url,
      sourcePath: best.source_path,
      sourceUpdatedAt: best.source_updated_at,
      sourceCreatedAt: best.source_created_at,
      snippet: bestScore?.snippet ?? null,
      similarity: bestScore?.similarity ?? null,
      score: bestScore?.score ?? 0,
      threadId: best.thread_id,
      rollupGroupId: best.rollup_group_id,
    });
  }

  for (const [threadKey, group] of linkedinGroups) {
    const best = [...group].sort((a, b) => (scoreMap.get(b.id)?.score ?? 0) - (scoreMap.get(a.id)?.score ?? 0))[0];
    const bestScore = scoreMap.get(best.id);
    const segments = visibleLinkedInSegments.get(threadKey) ?? group;
    const totals = summarizeLinkedInSegments(segments);

    output.push({
      resultKind: "linkedin_conversation",
      id: best.id,
      hitFileId: best.id,
      threadKey,
      messageCount: totals.messageCount,
      inboundCount: totals.inboundCount,
      outboundCount: totals.outboundCount,
      lastMessageFrom: totals.lastMessageFrom,
      lastActivity: totals.lastActivity,
      fileName: best.file_name,
      source: best.source,
      contentCategory: best.content_category,
      summary: best.summary,
      providerFileId: best.provider_file_id,
      providerUrl: best.provider_url,
      sourcePath: best.source_path,
      sourceUpdatedAt: best.source_updated_at,
      sourceCreatedAt: best.source_created_at,
      snippet: bestScore?.snippet ?? null,
      similarity: bestScore?.similarity ?? null,
      score: bestScore?.score ?? 0,
      threadId: best.thread_id,
      rollupGroupId: best.rollup_group_id,
    });
  }

  return output;
}

async function loadVisibleThreadEnvelopes(
  db: Kysely<DB>,
  emailFiles: SearchMetadataFile[],
  userPrincipals?: AccessPrincipalInput[],
  slackEntitySyncEnabled = true,
): Promise<Map<string, EmailEnvelopeSearchRow[]>> {
  const rowsByThread = new Map<string, EmailEnvelopeSearchRow[]>();
  if (emailFiles.length === 0) return rowsByThread;

  const threadIds = [...new Set(emailFiles.map((file) => file.thread_id).filter((id): id is string => !!id))];
  const directRows =
    threadIds.length > 0
      ? await db
          .selectFrom("email_message_envelopes")
          .innerJoin("indexed_files", "indexed_files.id", "email_message_envelopes.indexed_file_id")
          .select([
            "email_message_envelopes.indexed_file_id",
            "email_message_envelopes.connector_config_id",
            "email_message_envelopes.thread_id",
            "email_message_envelopes.subject",
            "email_message_envelopes.sent_at",
            "email_message_envelopes.from_json",
            "email_message_envelopes.to_json",
            "email_message_envelopes.cc_json",
          ])
          .where("indexed_files.is_archived", "=", 0)
          .where(idInList(db, sql.ref("email_message_envelopes.thread_id"), threadIds))
          .execute()
      : [];

  const singletonFileIds = emailFiles.filter((file) => !file.thread_id).map((file) => file.id);
  const singletonRows =
    singletonFileIds.length > 0
      ? await db
          .selectFrom("email_message_envelopes")
          .select([
            "indexed_file_id",
            "connector_config_id",
            "thread_id",
            "subject",
            "sent_at",
            "from_json",
            "to_json",
            "cc_json",
          ])
          .where(idInList(db, sql.ref("email_message_envelopes.indexed_file_id"), singletonFileIds))
          .execute()
      : [];

  const candidateKeys = new Set(emailFiles.map((file) => `${file.connector_config_id}:${file.thread_id ?? file.id}`));
  const allRows = [...directRows, ...singletonRows].filter((row) =>
    candidateKeys.has(`${row.connector_config_id}:${row.thread_id ?? row.indexed_file_id}`),
  );
  const visibleIds = await filterAccessibleFileIds(
    db,
    allRows.map((row) => row.indexed_file_id),
    userPrincipals,
    slackEntitySyncEnabled,
  );

  for (const row of allRows) {
    if (!visibleIds.has(row.indexed_file_id)) continue;
    const key = `${row.connector_config_id}:${row.thread_id ?? row.indexed_file_id}`;
    const group = rowsByThread.get(key) ?? [];
    group.push(row);
    rowsByThread.set(key, group);
  }

  return rowsByThread;
}

async function loadVisibleLinkedInThreadSegments(
  db: Kysely<DB>,
  linkedinFiles: SearchMetadataFile[],
  userPrincipals?: AccessPrincipalInput[],
  slackEntitySyncEnabled = true,
): Promise<Map<string, SearchMetadataFile[]>> {
  const rowsByThread = new Map<string, SearchMetadataFile[]>();
  if (linkedinFiles.length === 0) return rowsByThread;

  const connectorIds = [...new Set(linkedinFiles.map((file) => file.connector_config_id))];
  const threadIds = [...new Set(linkedinFiles.map((file) => file.thread_id).filter((id): id is string => !!id))];
  if (connectorIds.length === 0 || threadIds.length === 0) return rowsByThread;

  const candidateKeys = new Set(linkedinFiles.map((file) => `${file.connector_config_id}:${file.thread_id}`));
  const rows = (
    await db
      .selectFrom("indexed_files")
      .select([
        "id",
        "file_name",
        "source",
        "content_category",
        "summary",
        "connector_config_id",
        "thread_id",
        "file_type",
        "provider_file_id",
        "provider_url",
        "source_path",
        "rollup_group_id",
        "source_updated_at",
        "source_created_at",
        "source_meta",
        "access_scope_id",
      ])
      .where("is_archived", "=", 0)
      .where("file_type", "=", "linkedin_conversation")
      .where(idInList(db, sql.ref("indexed_files.connector_config_id"), connectorIds))
      .where(idInList(db, sql.ref("indexed_files.thread_id"), threadIds))
      .execute()
  ).filter((row) => row.thread_id && candidateKeys.has(`${row.connector_config_id}:${row.thread_id}`));

  const visibleIds = await filterAccessibleFileIds(
    db,
    rows.map((row) => row.id),
    userPrincipals,
    slackEntitySyncEnabled,
  );

  for (const row of rows) {
    if (!visibleIds.has(row.id) || !row.thread_id) continue;
    const key = `${row.connector_config_id}:${row.thread_id}`;
    const group = rowsByThread.get(key) ?? [];
    group.push(row);
    rowsByThread.set(key, group);
  }

  return rowsByThread;
}

/**
 * Browse files by folder path and source. No search query needed.
 */
export async function browseFiles(
  db: Kysely<DB>,
  opts?: {
    source?: string;
    folderPath?: string;
    contentCategory?: string;
    limit?: number;
    userPrincipals?: AccessPrincipalInput[];
    slackEntitySyncEnabled?: boolean;
  },
): Promise<
  Array<{
    id: string;
    fileName: string;
    providerUrl: string | null;
    sourcePath: string | null;
    contentCategory: string;
    sourceUpdatedAt: string | null;
  }>
> {
  const limit = opts?.limit ?? 20;

  let query = db
    .selectFrom("indexed_files")
    .select(["id", "file_name", "provider_url", "source_path", "content_category", "source_updated_at"])
    .where("is_archived", "=", 0);

  if (opts?.source) {
    query = query.where("source", "=", opts.source);
  }
  if (opts?.folderPath) {
    const escaped = opts.folderPath.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    query = query.where(sql<SqlBool>`source_path LIKE ${`%${escaped}%`} ESCAPE '\\'`);
  }
  if (opts?.contentCategory) {
    query = query.where("content_category", "=", opts.contentCategory);
  }

  query = query.orderBy("source_updated_at", "desc").limit(limit);

  const rows = await query.execute();

  return rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    providerUrl: r.provider_url,
    sourcePath: r.source_path,
    contentCategory: r.content_category,
    sourceUpdatedAt: r.source_updated_at,
  }));
}

/**
 * Coerce a date-like value (ISO string from SQLite, Date object from
 * node-postgres) to milliseconds since epoch. Returns null for null /
 * undefined / unparseable input so the caller can sort them last.
 */
function toMs(v: string | Date | null | undefined): number | null {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Deterministic recency-DESC comparator: source_updated_at, then
 * source_created_at, then id. Null/undefined timestamps sort last.
 */
function byRecencyDesc(a: HybridSearchResult, b: HybridSearchResult): number {
  const at = toMs(a.sourceUpdatedAt) ?? toMs(a.sourceCreatedAt) ?? Number.NEGATIVE_INFINITY;
  const bt = toMs(b.sourceUpdatedAt) ?? toMs(b.sourceCreatedAt) ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return bt - at;
  return b.id.localeCompare(a.id);
}

function byRecencyDescForThreads(a: HybridSearchResult, b: HybridSearchResult): number {
  const at = toMs(a.lastActivity) ?? toMs(a.sourceUpdatedAt) ?? toMs(a.sourceCreatedAt) ?? Number.NEGATIVE_INFINITY;
  const bt = toMs(b.lastActivity) ?? toMs(b.sourceUpdatedAt) ?? toMs(b.sourceCreatedAt) ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return bt - at;
  return b.id.localeCompare(a.id);
}

/**
 * Empty-query path: structural filters + RBAC + recency, no FTS / vector.
 *
 * Time filter mirrors hybridSearch (matches file dates OR a document_timeframes
 * overlap) so an `after`/`before` clause behaves the same way regardless of
 * whether the caller provided a query.
 */
async function browseLatest(
  db: Kysely<DB>,
  opts: {
    kindRules?: KindRule[];
    sources?: string[];
    entityScope?: EntityScope;
    userPrincipals?: AccessPrincipalInput[];
    slackEntitySyncEnabled?: boolean;
    fileTypes?: string[];
    threadId?: string;
    parentRecordId?: string;
    participantEmail?: string;
    domain?: string;
    crmFields?: Partial<Record<CrmFilterField, string>>;
    after?: string;
    before?: string;
    limit: number;
    expandThreads?: boolean;
  },
): Promise<HybridSearchResult[]> {
  if (opts.userPrincipals !== undefined && opts.userPrincipals.length === 0) return [];
  let q = db
    .selectFrom("indexed_files")
    .select([
      "id",
      "file_name",
      "provider_url",
      "provider_file_id",
      "content_category",
      "source",
      "source_path",
      "source_updated_at",
      "source_created_at",
      "summary",
      "connector_config_id",
      "thread_id",
      "file_type",
      "rollup_group_id",
      "source_meta",
      "access_scope_id",
    ])
    .where("is_archived", "=", 0)
    .where(bodylessCrmActivityPredicateSql());

  if (opts.kindRules?.length) {
    const rules = opts.kindRules;
    q = q.where((eb) =>
      eb.or(
        rules.map((r) => {
          const conds = [];
          if (r.sources?.length) conds.push(eb("indexed_files.source", "in", r.sources));
          if (r.fileTypes?.length) conds.push(eb("indexed_files.file_type", "in", r.fileTypes));
          if (conds.length === 0) return eb.val(true);
          return conds.length === 1 ? conds[0] : eb.and(conds);
        }),
      ),
    );
  }
  if (opts.sources?.length) q = q.where("source", "in", opts.sources);
  if (opts.entityScope) q = q.where(entityScopePredicateSql(sql.ref("indexed_files.id"), opts.entityScope));
  q = q.where(sql<SqlBool>`TRUE ${extraFilterSql(opts)}`);

  if ((opts.userPrincipals ?? []).length > 0) {
    const userPrincipals = opts.userPrincipals ?? [];
    q = q.where(fileAccessFilterSql(userPrincipals, opts.slackEntitySyncEnabled ?? true));
  }

  if (opts.after || opts.before) {
    const after = opts.after;
    const before = opts.before;
    q = q.where((eb) => {
      const fileDateExpr = eb.fn.coalesce("source_updated_at", "source_created_at");
      const conds = [];
      if (after) conds.push(eb(fileDateExpr, ">=", after));
      if (before) conds.push(eb(fileDateExpr, "<=", before));
      const fileDateMatches = conds.length === 1 ? conds[0] : eb.and(conds);
      const tfMatches = eb.exists(
        eb
          .selectFrom("document_timeframes")
          .select("indexed_file_id")
          .whereRef("document_timeframes.indexed_file_id", "=", "indexed_files.id")
          .$if(!!after, (qb) => qb.where("end_date", ">=", after as string))
          .$if(!!before, (qb) => qb.where("start_date", "<=", before as string)),
      );
      return eb.or([fileDateMatches, tfMatches]);
    });
  }

  q = q
    .orderBy(sql`COALESCE(source_updated_at, source_created_at)`, "desc")
    .orderBy("source_created_at", "desc")
    .orderBy("id", "desc")
    .limit(Math.max(opts.limit * 40, 200));

  const rows = await q.execute();

  const scoreMap = new Map<string, SearchScoreData>();
  const collapsed = opts.expandThreads
    ? rows.map((file) => fileSearchResult(file, undefined))
    : await collapseThreadSearchResults(db, rows, scoreMap, opts.userPrincipals, opts.slackEntitySyncEnabled ?? true);

  return collapsed.sort((a, b) => byRecencyDescForThreads(a, b)).slice(0, opts.limit);
}

/**
 * High-level search: embeds the query (best-effort) then runs hybridSearch.
 * Shared by the API endpoint and the agent Search tool.
 *
 * Routing:
 *   - empty query + at least one structural filter → browseLatest
 *   - non-empty query → hybridSearch
 *
 * sortBy: "recency" overfetches `max(limit*5, 50)` candidates from the hybrid
 * pipeline, then sorts the result set in JS so the truly-newest file isn't
 * dropped by RRF before the recency stage sees it.
 */
export async function search(
  db: Kysely<DB>,
  query: string,
  opts?: {
    source?: string;
    sources?: string[];
    kindRules?: KindRule[];
    fileTypes?: string[];
    threadId?: string;
    parentRecordId?: string;
    participantEmail?: string;
    domain?: string;
    crmFields?: Partial<Record<CrmFilterField, string>>;
    category?: string;
    limit?: number;
    after?: string;
    before?: string;
    userPrincipals?: AccessPrincipalInput[];
    accessBypassReason?: "admin";
    slackEntitySyncEnabled?: boolean;
    entityId?: string;
    entityIds?: string[];
    entityIdsMode?: "and" | "or";
    sortBy?: "relevance" | "recency";
    /** Suppress search()'s own auto-entity-boost when the caller manages entity matching. */
    skipAutoEntityBoost?: boolean;
    /**
     * Entity ids already resolved by the caller for the fusion boost. When this
     * option is present, including as an empty array, search uses exactly these
     * ids and performs no entity discovery. When absent, search discovers up to
     * ten unfiltered entities unless `skipAutoEntityBoost` is set. A hard entity
     * scope from `entityId` or `entityIds` takes precedence, and no fusion boost
     * is applied at all in that case.
     */
    boostEntityIds?: string[];
    geminiMaxRpm?: number;
    geminiMaxRetries?: number;
    openRouterApiKey?: string;
    settingsEncryptionKey?: string;
    logger?: Logger;
    /** Dev-tools trace hook. Undefined in production. */
    stageReport?: StageReporter;
    expandThreads?: boolean;
  },
): Promise<HybridSearchResult[]> {
  const limit = opts?.limit ?? 10;
  const isRecency = opts?.sortBy === "recency";
  const trimmedQuery = query.trim();

  const allEntityIds =
    opts?.entityIds && opts.entityIds.length > 0 ? opts.entityIds : opts?.entityId ? [opts.entityId] : [];
  const entityScope =
    allEntityIds.length > 0
      ? { entityIds: [...new Set(allEntityIds)], mode: opts?.entityIdsMode ?? ("and" as const) }
      : undefined;
  const scopeHasFiles = entityScope && trimmedQuery !== "" ? await entityScopeHasFiles(db, entityScope) : undefined;
  if (entityScope) {
    opts?.stageReport?.({
      stage: "resolveEntities",
      label: "Resolve entity scope",
      kind: "code",
      status: "done",
      summary: {
        entityIds: entityScope.entityIds.length,
        mode: entityScope.mode,
        resolution: "correlated database predicate",
        ...(scopeHasFiles === false ? { files: 0 } : {}),
      },
    });
  } else {
    opts?.stageReport?.({
      stage: "resolveEntities",
      label: "Resolve entity scope",
      kind: "code",
      status: "skipped",
      error: "No entityIds supplied — search was not entity-scoped",
    });
  }

  if (scopeHasFiles === false) return [];

  // Empty-query path: skip FTS/vector entirely. Require at least one structural filter.
  if (trimmedQuery === "") {
    const hasFilter =
      !!opts?.kindRules?.length ||
      !!opts?.sources?.length ||
      !!opts?.source ||
      !!entityScope ||
      !!opts?.fileTypes?.length ||
      !!opts?.threadId ||
      !!opts?.parentRecordId ||
      !!opts?.participantEmail ||
      !!opts?.domain ||
      crmFieldFilterEntries(opts?.crmFields).length > 0 ||
      !!opts?.after ||
      !!opts?.before;
    if (!hasFilter) return [];
    return browseLatest(db, {
      kindRules: opts?.kindRules,
      sources: opts?.sources ?? (opts?.source ? [opts.source] : undefined),
      entityScope,
      userPrincipals: opts?.userPrincipals,
      slackEntitySyncEnabled: opts?.slackEntitySyncEnabled,
      fileTypes: opts?.fileTypes,
      threadId: opts?.threadId,
      parentRecordId: opts?.parentRecordId,
      participantEmail: opts?.participantEmail,
      domain: opts?.domain,
      crmFields: opts?.crmFields,
      after: opts?.after,
      before: opts?.before,
      limit,
      expandThreads: opts?.expandThreads,
    });
  }

  if (opts?.userPrincipals !== undefined && opts.userPrincipals.length === 0) return [];

  const resolvedAccessPredicate = await resolveAccessPredicate(db, {
    userPrincipals: opts?.userPrincipals,
    accessBypassReason: opts?.accessBypassReason,
    slackEntitySyncEnabled: opts?.slackEntitySyncEnabled,
  });
  if (resolvedAccessPredicate?.mode === RBAC_MODE_VISIBLE_SET && resolvedAccessPredicate.visibleCount === 0) {
    reportPostgresRbacStage(opts?.stageReport, opts?.userPrincipals?.length ?? 0, resolvedAccessPredicate);
    reportNoScoredCandidateRemainder(
      opts?.stageReport,
      "No candidates were scored — the principal has no visible files",
    );
    return [];
  }

  let queryEmbedding: number[] | undefined;
  let embedSkippedReason: string | null = null;
  const embedStartedAt = Date.now();
  try {
    const settings = await createSettingsRepository(db, opts?.settingsEncryptionKey).get();
    if (settings?.enrichment_enabled === 0) embedSkippedReason = "Enrichment is disabled in settings";
    if (settings?.enrichment_enabled !== 0) {
      const openRouterConfig = resolveOpenRouterEnrichmentConfig(settings, opts?.openRouterApiKey);
      const embedQuery = createEnrichmentQueryEmbedder({
        geminiApiKey: settings?.gemini_api_key,
        embeddingProvider: settings?.embedding_provider,
        geminiMaxRpm: opts?.geminiMaxRpm,
        geminiMaxRetries: opts?.geminiMaxRetries,
        logger: opts?.logger,
        ...openRouterConfig,
      });
      if (embedQuery) queryEmbedding = await embedQuery(trimmedQuery);
      else embedSkippedReason = "No embedding provider is configured";
    }
  } catch (err) {
    // Vector search is best-effort — fall back to FTS5 only
    embedSkippedReason = err instanceof Error ? err.message : String(err);
  }

  /**
   * Losing the embedding silently turns every search into keyword-only matching, which on a
   * corpus with generated file names is close to no search at all. The stage reports are
   * dev-tools-only, so without this the degradation has no production signal whatsoever.
   */
  if (!queryEmbedding && trimmedQuery !== "") {
    opts?.logger?.error(
      { event: "search_query_embedding_unavailable", reason: embedSkippedReason },
      "Search fell back to keyword-only — no query embedding",
    );
  }

  opts?.stageReport?.(
    queryEmbedding
      ? {
          stage: "embedQuery",
          label: "Embed query",
          kind: "code",
          status: "done",
          summary: {
            dimensions: queryEmbedding.length,
            latencyMs: Date.now() - embedStartedAt,
            magnitude: Math.sqrt(queryEmbedding.reduce((sum, value) => sum + value * value, 0)),
            nonZero: queryEmbedding.filter((value) => value !== 0).length,
            /** First slice of the actual vector — enough to eyeball that it is real and not all zeros. */
            preview: queryEmbedding.slice(0, 24).map((value) => Number(value.toFixed(5))),
          },
        }
      : {
          stage: "embedQuery",
          label: "Embed query",
          kind: "code",
          status: "skipped",
          error: embedSkippedReason ?? "No embedding produced — keyword-only search",
        },
  );

  let entityBoostEntityIds: string[] | undefined;
  if (allEntityIds.length > 0) {
    opts?.stageReport?.({
      stage: "discoverEntities",
      label: "Discover entities",
      kind: "code",
      status: "skipped",
      error: "Caller supplied a hard entity scope — no fusion boost discovery applied",
    });
  } else if (opts?.boostEntityIds !== undefined) {
    entityBoostEntityIds = opts.boostEntityIds;
    opts?.stageReport?.({
      stage: "discoverEntities",
      label: "Discover entities",
      kind: "code",
      status: "done",
      summary: {
        set: "fuse boost",
        entitiesMatched: entityBoostEntityIds.length,
        source: "caller-provided",
        note: "Caller-resolved and visibility-filtered ids; search() performed no entity discovery.",
      },
      outcomes: entityBoostEntityIds.map((entityId) => ({
        subject: entityId,
        kind: "entity",
        result: "linked" as const,
        reason: "boosts files mentioning this entity",
      })),
    });
  } else if (!opts?.skipAutoEntityBoost) {
    try {
      const entityRepo = createEntityRepository(db);
      const matchingEntities = await entityRepo.searchEntities(trimmedQuery, { limit: 10, tokenFallback: true });
      if (matchingEntities.length > 0) {
        entityBoostEntityIds = matchingEntities.map((entity) => entity.id);
      }
      opts?.stageReport?.({
        stage: "discoverEntities",
        label: "Discover entities",
        kind: "code",
        status: "done",
        summary: {
          set: "fuse boost",
          entitiesMatched: matchingEntities.length,
          source: "search-discovery",
          note: "search()'s own discovery, limit 10, not public-filtered. Links are loaded only for fused candidates.",
        },
        outcomes: matchingEntities.map((entity) => ({
          subject: entity.name,
          kind: entity.source_type,
          result: "linked" as const,
          reason: "boosts files mentioning this entity",
        })),
      });
    } catch (err) {
      // Entity boost is best-effort
      opts?.stageReport?.({
        stage: "discoverEntities",
        label: "Discover entities",
        kind: "code",
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    opts?.stageReport?.({
      stage: "discoverEntities",
      label: "Discover entities",
      kind: "code",
      status: "skipped",
      error: "Caller suppressed automatic entity discovery",
    });
  }

  // Recency: overfetch from the hybrid pipeline so the truly newest file isn't
  // dropped past `limit` by RRF, then sort in JS and trim.
  const fetchLimit = isRecency ? Math.max(limit * 5, 50) : limit;

  const results = await hybridSearch(
    db,
    trimmedQuery,
    {
      stageReport: opts?.stageReport,
      source: opts?.source,
      sources: opts?.sources,
      kindRules: opts?.kindRules,
      fileTypes: opts?.fileTypes,
      threadId: opts?.threadId,
      parentRecordId: opts?.parentRecordId,
      participantEmail: opts?.participantEmail,
      domain: opts?.domain,
      crmFields: opts?.crmFields,
      category: opts?.category,
      limit: fetchLimit,
      queryEmbedding,
      userPrincipals: opts?.userPrincipals,
      ...(opts?.accessBypassReason ? { accessBypassReason: opts.accessBypassReason } : {}),
      slackEntitySyncEnabled: opts?.slackEntitySyncEnabled,
      entityScope,
      entityBoostEntityIds,
      timeFilter: opts?.after || opts?.before ? { after: opts?.after, before: opts?.before } : undefined,
      expandThreads: opts?.expandThreads,
    },
    { resolvedAccessPredicate },
  );

  if (isRecency) {
    results.sort(byRecencyDesc);
    return results.slice(0, limit);
  }
  return results;
}
