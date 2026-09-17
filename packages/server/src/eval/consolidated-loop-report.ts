import { type Kysely, sql } from "kysely";
import {
  CONSOLIDATED_EXTRACTOR_VERSION,
  type ConsolidatedLoopGuard,
  type ConsolidatedResolutionCandidate,
} from "../connectors/consolidated-loop";
import { type ExtractionStage, createExtractionStageRepository } from "../db/repositories/extraction-stages";
import type { DB } from "../db/schema";
import { parseAliasesString, readJsonObject } from "../entities/materialize-json";
import { normalizeEntityMatchName, normalizeName } from "../entities/name-keys";

export interface ConsolidatedLoopReportFile {
  id: string;
  connector_config_id: string;
  file_name: string;
  file_type: string | null;
  content_category: string;
  content: string | null;
  summary: string | null;
  source: string;
  source_path: string | null;
  thread_id: string | null;
  content_hash: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  enrichment_status: string;
}

export interface LinkedMentionCandidate {
  entityId: string;
  entityName: string;
  entityType: string;
  aliases?: string[];
}

export interface QueuedMentionCandidate {
  normalizedName: string;
  entityType: string;
  status: string;
}

export type LegacyMentionClassification =
  | { kind: "linked"; entityId: string; entityName: string }
  | { kind: "queued"; status: string }
  | { kind: "ambiguous"; entityIds: string[]; reviewIds: string[] }
  | { kind: "none" };

export interface LoopMentionDiagnostic {
  mention: string;
  type: string;
  resolutionKind: LoopResolutionKind;
  targetEntityId: string | null;
  targetEntityName: string | null;
  holdReason: string | null;
  legacy: LegacyMentionClassification;
}

interface ReportRowBase {
  fileId: string;
  source: string;
  stageUpdatedAt: string;
}

export interface StaleReportRow extends ReportRowBase {
  stale: true;
  staleNote: string;
  stageContentHash: string | null;
  currentContentHash: string | null;
}

export interface ComparedReportRow extends ReportRowBase {
  stale: false;
  mentionRecall: number | null;
  mentionPrecision: number | null;
  legacyMentionCount: number;
  loopMentionCount: number;
  legacyRelationCount: number;
  loopRelationCount: number;
  legacyFactCount: number;
  loopFactCount: number;
  legacySummary: string;
  loopSummary: string;
  holdCount: number;
  holdsWithCandidates: number;
  guard: Pick<
    ConsolidatedLoopGuard,
    | "overriddenByMatcher"
    | "demotedUnoffered"
    | "heldUnjudged"
    | "heldPending"
    | "newOverCandidates"
    | "suppressed"
    | "registryLinked"
    | "droppedFacts"
    | "matchToolCalls"
    | "matchToolCalled"
  >;
  legacyCostUsd: number | null;
  loopCostUsd: number | null;
  legacyTokens: number | null;
  loopTokens: number | null;
  mentionDiagnostics: LoopMentionDiagnostic[];
  resolvedLegacyQueuedCount: number;
}

export type ConsolidatedLoopReportRow = StaleReportRow | ComparedReportRow;

export interface ConsolidatedLoopReportTotals {
  files: number;
  comparedFiles: number;
  staleFiles: number;
  legacyMentionCount: number;
  loopMentionCount: number;
  aggregateRecall: number | null;
  meanLegacyCostUsd: number | null;
  medianLegacyCostUsd: number | null;
  meanLoopCostUsd: number | null;
  medianLoopCostUsd: number | null;
  resolvedLegacyQueuedCount: number;
  overriddenByMatcher: number;
  demotedUnoffered: number;
}

export interface ExistingStageSelection {
  file: ConsolidatedLoopReportFile;
  stage: ExtractionStage;
}

export const SUPPORTED_CONSOLIDATED_EXTRACTOR_VERSIONS = ["loop-v1", "loop-v2"] as const;

export type LoopResolutionKind = "known" | "tool" | "matched" | "judged" | "new" | "hold";

export type ConsolidatedLoopExtractorVersion = (typeof SUPPORTED_CONSOLIDATED_EXTRACTOR_VERSIONS)[number];

export type LoopCompareSourceBucket = "fireflies" | "email" | "slack" | "whatsapp" | "docs";

export interface ReportLoopMention {
  mention: string;
  type: string;
  variations: string[];
  facts?: string[];
  resolution:
    | { kind: "known" | "tool" | "matched"; entityId: string }
    | { kind: "judged"; entityId: string; reason: string }
    | { kind: "new"; rejectedCandidates?: string[] }
    | { kind: "hold"; reason: string; candidates: ConsolidatedResolutionCandidate[] };
}

export interface ReportStageValidation {
  droppedMentions: number;
  droppedRelations: number;
  invalidType: number;
  droppedSingleTokenPerson: number;
  schemaInvalid: number;
  droppedSamples: Array<{ mention: string; type: string; reason: string }>;
  malformedResolution: number;
  malformedSamples: Array<{ mention: string; type: string; reason: string }>;
}

export interface ReportStageToolStep {
  name: string;
  durationMs: number;
  cached: boolean;
}

export interface ReportStagedDocument {
  mentions: ReportLoopMention[];
  relations: unknown[];
  entityFacts: Array<{ entityId: string; facts: string[] }>;
  summary: string;
  meta: {
    guard?: Partial<ConsolidatedLoopGuard>;
    validation?: Partial<ReportStageValidation>;
    toolSteps?: ReportStageToolStep[];
    model?: string;
    registrySize?: number;
  };
}

export interface SummarizedConsolidatedLoopStage {
  loopMentionCount: number;
  holdCount: number;
  guard: ConsolidatedLoopGuard;
  validation: ReportStageValidation;
  toolSteps: ReportStageToolStep[];
  model: string | null;
  registrySize: number;
}

export interface LoopCompareListParams {
  fileIds?: string[] | null;
  since?: string | null;
  limit?: number | null;
  bucket?: LoopCompareSourceBucket | null;
  version?: ConsolidatedLoopExtractorVersion | null;
}

export type LoopCompareVerdict =
  | "same_target"
  | "different_target"
  | "loop_resolved_legacy_queued"
  | "loop_resolved_legacy_unresolved"
  | "loop_hold_legacy_linked"
  | "loop_new_legacy_linked"
  | "loop_new_legacy_queued"
  | "loop_only"
  | "legacy_only"
  | "both_unresolved"
  | "indeterminate";

export type LegacyMentionStatus =
  | { status: "linked"; entityId: string; entityName: string }
  | { status: "queued"; reviewId: string; reviewStatus: string }
  | { status: "ambiguous"; entityIds: string[]; reviewIds: string[] }
  | { status: "none" };

export interface LegacyCompareMention {
  key: string;
  name: string;
  type: string;
  status: LegacyMentionStatus["status"];
  entityId?: string;
  entityName?: string;
  reviewId?: string;
  reviewStatus?: string;
  entityIds?: string[];
  reviewIds?: string[];
}

export interface LoopCompareEntityName {
  name: string;
  live: boolean;
  mergedIntoEntityId?: string;
}

export interface LoopCompareMention {
  name: string;
  type: string;
  variations: string[];
  facts: string[];
  kind: "resolved" | "new" | "hold";
  originalKind: LoopResolutionKind;
  entityId?: string;
  entityName?: string;
  live?: boolean;
  mergedIntoEntityId?: string;
  reason?: string;
  candidates?: Array<{ entityId: string; name: string; live?: boolean }>;
  rejectedCandidates?: Array<{ entityId: string; name: string }>;
}

export interface AlignedMention {
  key: string;
  name: string;
  type: string;
  legacy?: Omit<LegacyCompareMention, "key" | "name" | "type">;
  loop?: Pick<
    LoopCompareMention,
    | "kind"
    | "originalKind"
    | "entityId"
    | "entityName"
    | "live"
    | "mergedIntoEntityId"
    | "reason"
    | "candidates"
    | "rejectedCandidates"
  >;
  verdict: LoopCompareVerdict;
}

export interface LoopCompareListRow {
  fileId: string;
  fileName: string;
  source: string;
  sourceBucket: LoopCompareSourceBucket;
  fileType: string | null;
  extractorVersion: ConsolidatedLoopExtractorVersion;
  stageUpdatedAt: string;
  stale: boolean;
  loopMentionCount: number;
  holdCount: number;
  legacyMentionCount: number;
  guard: Pick<ConsolidatedLoopGuard, "overriddenByMatcher" | "demotedUnoffered" | "registryLinked">;
  validation: Pick<ReportStageValidation, "schemaInvalid" | "malformedResolution">;
}

export interface LoopCompareDetail {
  file: {
    id: string;
    fileName: string;
    source: string;
    sourceBucket: LoopCompareSourceBucket;
    fileType: string | null;
    sourceCreatedAt: string | null;
    contentHash: string | null;
    enrichmentStatus: string;
    summary: string | null;
  };
  stage: {
    id: string;
    extractorVersion: ConsolidatedLoopExtractorVersion;
    updatedAt: string;
    stale: boolean;
    staleNote?: string;
    model: string | null;
    costUsd: number | null;
    tokens: { input: number | null; output: number | null };
    toolSteps: ReportStageToolStep[];
    guard: ConsolidatedLoopGuard;
    validation: ReportStageValidation;
  };
  legacy: {
    summary: string | null;
    mentions: LegacyCompareMention[];
    relationCount: number;
    factCount: number;
    costUsd: number | null;
    tokens: number | null;
    reconstructed: true;
  };
  loop: {
    summary: string;
    mentions: LoopCompareMention[];
    relations: unknown[];
    entityFacts: Array<{ entityId: string; entityName: string; facts: string[] }>;
    staged: ReportStagedDocument;
  };
  aligned: AlignedMention[];
  totals: {
    legacyMentions: number;
    loopMentions: number;
    holds: number;
    verdicts: Record<LoopCompareVerdict, number>;
  };
}

export function sourceBucketFor(
  file: Pick<ConsolidatedLoopReportFile, "source" | "file_type" | "content_category">,
): LoopCompareSourceBucket {
  const value = `${file.source} ${file.file_type ?? ""} ${file.content_category}`.toLowerCase();
  if (value.includes("fireflies")) return "fireflies";
  if (value.includes("email") || value.includes("outlook")) return "email";
  if (value.includes("slack")) return "slack";
  if (value.includes("whatsapp")) return "whatsapp";
  return "docs";
}

export async function selectConsolidatedLoopSampleFiles(
  db: Kysely<DB>,
  limit: number,
): Promise<ConsolidatedLoopReportFile[]> {
  const rows = await db
    .selectFrom("indexed_files")
    .select([
      "id",
      "connector_config_id",
      "file_name",
      "file_type",
      "content_category",
      "content",
      "summary",
      "source",
      "source_path",
      "thread_id",
      "content_hash",
      "source_created_at",
      "source_updated_at",
      "enrichment_status",
    ])
    .where("summary_status", "=", "done")
    .where("content", "is not", null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("indexed_file_facts")
          .select("id")
          .whereRef("indexed_file_facts.indexed_file_id", "=", "indexed_files.id")
          .where("fact_type", "=", "llm_extracted")
          .where("deleted_at", "is", null),
      ),
    )
    .orderBy("id", "asc")
    .execute();
  const buckets = new Map<string, ConsolidatedLoopReportFile[]>();
  for (const row of rows) {
    const bucket = sourceBucketFor(row);
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), row]);
  }
  const selected: ConsolidatedLoopReportFile[] = [];
  const names = ["fireflies", "email", "slack", "whatsapp", "docs"];
  while (selected.length < limit && names.some((name) => (buckets.get(name)?.length ?? 0) > 0)) {
    for (const name of names) {
      const row = buckets.get(name)?.shift();
      if (row) selected.push(row);
      if (selected.length >= limit) break;
    }
  }
  return selected.sort((left, right) => left.id.localeCompare(right.id));
}

export async function selectConsolidatedLoopFilesById(
  db: Kysely<DB>,
  ids: string[],
): Promise<ConsolidatedLoopReportFile[]> {
  if (ids.length === 0) return [];
  return db
    .selectFrom("indexed_files")
    .select([
      "id",
      "connector_config_id",
      "file_name",
      "file_type",
      "content_category",
      "content",
      "summary",
      "source",
      "source_path",
      "thread_id",
      "content_hash",
      "source_created_at",
      "source_updated_at",
      "enrichment_status",
    ])
    .where("id", "in", ids)
    .orderBy("id", "asc")
    .execute();
}

/** The dev-tools selector loads all matching stages before deduplication and limiting. */
export async function selectExistingConsolidatedLoopStages(
  db: Kysely<DB>,
  options: LoopCompareListParams,
): Promise<ExistingStageSelection[]> {
  if (options.fileIds?.length === 0) return [];
  let query = db
    .selectFrom("extraction_stages")
    .selectAll()
    .where("extractor_version", "in", [...SUPPORTED_CONSOLIDATED_EXTRACTOR_VERSIONS])
    .where("status", "=", "staged");
  if (options.fileIds) query = query.where("indexed_file_id", "in", options.fileIds);
  if (options.version) query = query.where("extractor_version", "=", options.version);
  const rows = await query.orderBy("updated_at", "desc").orderBy("created_at", "desc").orderBy("id", "desc").execute();
  const since = options.since ? normalizeTimestamp(options.since) : null;
  const eligibleRows = since ? rows.filter((row) => normalizeTimestamp(row.updated_at) >= since) : rows;
  const orderedRows = [...eligibleRows].sort(
    (left, right) =>
      normalizeTimestamp(right.updated_at).localeCompare(normalizeTimestamp(left.updated_at)) ||
      normalizeTimestamp(right.created_at).localeCompare(normalizeTimestamp(left.created_at)) ||
      right.id.localeCompare(left.id),
  );
  const latestByFile = new Map<string, ExtractionStage>();
  for (const stage of orderedRows) {
    if (!latestByFile.has(stage.indexed_file_id)) latestByFile.set(stage.indexed_file_id, stage);
  }
  const latestStages = [...latestByFile.values()];
  const files = await selectConsolidatedLoopFilesById(
    db,
    latestStages.map((stage) => stage.indexed_file_id),
  );
  const filesById = new Map(files.map((file) => [file.id, file]));
  const selections = latestStages
    .flatMap((stage) => {
      const file = filesById.get(stage.indexed_file_id);
      return file ? [{ file, stage }] : [];
    })
    .filter((selection) => !options.bucket || sourceBucketFor(selection.file) === options.bucket)
    .sort(
      (left, right) =>
        normalizeTimestamp(right.stage.updated_at).localeCompare(normalizeTimestamp(left.stage.updated_at)) ||
        normalizeTimestamp(right.stage.created_at).localeCompare(normalizeTimestamp(left.stage.created_at)) ||
        right.stage.id.localeCompare(left.stage.id),
    );
  return options.limit == null ? selections : selections.slice(0, options.limit);
}

export async function listConsolidatedLoopStagesForCompare(
  db: Kysely<DB>,
  params: LoopCompareListParams,
): Promise<LoopCompareListRow[]> {
  const selections = await selectExistingConsolidatedLoopStages(db, params);
  const fileIds = selections.map((selection) => selection.file.id);
  if (fileIds.length === 0) return [];
  const factRows = await db
    .selectFrom("indexed_file_facts")
    .select(["indexed_file_id", "subject_name", "raw_mention_type", "mention_type", "raw"])
    .where("indexed_file_id", "in", fileIds)
    .where("fact_type", "=", "llm_extracted")
    .where("deleted_at", "is", null)
    .execute();
  const legacyMentionCounts = new Map<string, number>();
  const legacyMentionKeys = new Map<string, Set<string>>();
  for (const row of factRows) {
    if (!row.indexed_file_id) continue;
    const mention = exactLegacyMentionFromFact(row);
    if (!mention) continue;
    const keys = legacyMentionKeys.get(row.indexed_file_id) ?? new Set<string>();
    keys.add(mention.key);
    legacyMentionKeys.set(row.indexed_file_id, keys);
    legacyMentionCounts.set(row.indexed_file_id, keys.size);
  }
  return selections.map(({ file, stage }) => {
    const summary = summarizeStage(JSON.parse(stage.staged_json) as ReportStagedDocument);
    return {
      fileId: file.id,
      fileName: file.file_name,
      source: file.source,
      sourceBucket: sourceBucketFor(file),
      fileType: file.file_type,
      extractorVersion: stage.extractor_version as ConsolidatedLoopExtractorVersion,
      stageUpdatedAt: stage.updated_at,
      stale: stage.content_hash !== file.content_hash,
      loopMentionCount: summary.loopMentionCount,
      holdCount: summary.holdCount,
      legacyMentionCount: legacyMentionCounts.get(file.id) ?? 0,
      guard: {
        overriddenByMatcher: summary.guard.overriddenByMatcher,
        demotedUnoffered: summary.guard.demotedUnoffered,
        registryLinked: summary.guard.registryLinked,
      },
      validation: {
        schemaInvalid: summary.validation.schemaInvalid,
        malformedResolution: summary.validation.malformedResolution,
      },
    };
  });
}

function normalizeTimestamp(value: string): string {
  const isoLike = value.includes("T") ? value : value.includes(" ") ? value.replace(" ", "T") : `${value}T00:00:00`;
  const offsetNormalized = isoLike.replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(offsetNormalized) ? offsetNormalized : `${offsetNormalized}Z`);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 19).replace("T", " ");
  return value
    .replace("T", " ")
    .replace(/\.\d{3}Z?$/, "")
    .replace(/Z$/, "")
    .slice(0, 19);
}

function normalizedMentionKey(name: string, type: string): string {
  const normalizedType = type.trim().toLowerCase();
  return `${normalizeEntityMatchName(normalizedType, name)}\t${normalizedType}`;
}

export function summarizeStage(staged: ReportStagedDocument): SummarizedConsolidatedLoopStage {
  const guard = staged.meta?.guard ?? {};
  const validation = staged.meta?.validation ?? {};
  return {
    loopMentionCount: staged.mentions.filter((mention) => mention.type !== "team").length,
    holdCount: staged.mentions.filter((mention) => mention.resolution.kind === "hold").length,
    guard: {
      overriddenByMatcher: guard.overriddenByMatcher ?? 0,
      demotedUnoffered: guard.demotedUnoffered ?? 0,
      heldUnjudged: guard.heldUnjudged ?? 0,
      heldPending: guard.heldPending ?? 0,
      newOverCandidates: guard.newOverCandidates ?? 0,
      suppressed: guard.suppressed ?? 0,
      registryLinked: guard.registryLinked ?? 0,
      droppedFacts: guard.droppedFacts ?? 0,
      matchToolCalls: guard.matchToolCalls ?? 0,
      matchToolCalled: guard.matchToolCalled ?? false,
    },
    validation: {
      droppedMentions: validation.droppedMentions ?? 0,
      droppedRelations: validation.droppedRelations ?? 0,
      invalidType: validation.invalidType ?? 0,
      droppedSingleTokenPerson: validation.droppedSingleTokenPerson ?? 0,
      schemaInvalid: validation.schemaInvalid ?? 0,
      droppedSamples: validation.droppedSamples ?? [],
      malformedResolution: validation.malformedResolution ?? 0,
      malformedSamples: validation.malformedSamples ?? [],
    },
    toolSteps: staged.meta?.toolSteps ?? [],
    model: staged.meta?.model ?? null,
    registrySize: staged.meta?.registrySize ?? 0,
  };
}

export function staleReportRow(file: ConsolidatedLoopReportFile, stage: ExtractionStage): StaleReportRow | null {
  if (stage.content_hash === file.content_hash) return null;
  const stageHash = stage.content_hash ?? "null";
  const currentHash = file.content_hash ?? "null";
  const staleNote = [
    `stale: stage content hash ${stageHash} does not match current content hash ${currentHash};`,
    "comparison skipped",
  ].join(" ");
  return {
    fileId: file.id,
    source: sourceBucketFor(file),
    stageUpdatedAt: stage.updated_at,
    stale: true,
    staleNote,
    stageContentHash: stage.content_hash,
    currentContentHash: file.content_hash,
  };
}

function mentionKeys(name: string, type: string): string[] {
  const normalized = normalizeName(name);
  const typeKey = type.trim().toLowerCase();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return [
    `${normalized}\t${typeKey}`,
    `${[...tokens].sort().join(" ")}\t${typeKey}`,
    `${normalized.replace(/\s+/g, "")}\t${typeKey}`,
  ];
}

function keysForMention(name: string, variations: unknown, type: string): Set<string> {
  const names = [
    name,
    ...(Array.isArray(variations) ? variations.filter((value): value is string => typeof value === "string") : []),
  ];
  return new Set(names.flatMap((value) => mentionKeys(value, type)));
}

type LegacyMentionRow = { keys: Set<string> };

export interface LegacyMentionFactProjection {
  subject_name: string | null;
  raw_mention_type: string | null;
  mention_type: string | null;
  raw: string | null;
}

export function exactLegacyMentionFromFact(
  row: LegacyMentionFactProjection,
): Pick<LegacyCompareMention, "key" | "name" | "type"> | null {
  const raw = readJsonObject(row.raw);
  const name = row.subject_name ?? (typeof raw.mention === "string" ? raw.mention : null);
  const type = row.mention_type ?? row.raw_mention_type ?? (typeof raw.type === "string" ? raw.type : null);
  if (!name || !type || type === "team") return null;
  return { key: normalizedMentionKey(name, type), name, type };
}

export async function loadExactLegacyMentionRows(
  db: Kysely<DB>,
  fileId: string,
): Promise<Array<Pick<LegacyCompareMention, "key" | "name" | "type">>> {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select(["subject_name", "raw_mention_type", "mention_type", "raw"])
    .where("indexed_file_id", "=", fileId)
    .where("fact_type", "=", "llm_extracted")
    .where("deleted_at", "is", null)
    .execute();
  const mentions = new Map<string, Pick<LegacyCompareMention, "key" | "name" | "type">>();
  for (const row of rows) {
    const mention = exactLegacyMentionFromFact(row);
    if (mention && !mentions.has(mention.key)) mentions.set(mention.key, mention);
  }
  return [...mentions.values()];
}

async function legacyMentionRows(db: Kysely<DB>, fileId: string): Promise<LegacyMentionRow[]> {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select(["subject_name", "raw_mention_type", "mention_type", "raw"])
    .where("indexed_file_id", "=", fileId)
    .where("fact_type", "=", "llm_extracted")
    .where("deleted_at", "is", null)
    .execute();
  return rows.flatMap((row) => {
    const exact = exactLegacyMentionFromFact(row);
    if (!exact) return [];
    const raw = readJsonObject(row.raw);
    return [{ keys: keysForMention(exact.name, raw.variations, exact.type) }];
  });
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

async function legacyRelationCount(db: Kysely<DB>, fileId: string): Promise<number> {
  const row = await db
    .selectFrom("indexed_file_facts")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("indexed_file_id", "=", fileId)
    .where("fact_type", "=", "llm_relation")
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

async function legacyFactCount(db: Kysely<DB>, fileId: string): Promise<number> {
  const rows = await db.selectFrom("entities").select("metadata").execute();
  let count = 0;
  for (const row of rows) {
    const facts = readJsonObject(row.metadata).learned_facts;
    if (!Array.isArray(facts)) continue;
    count += facts.filter((fact) => {
      return fact && typeof fact === "object" && (fact as Record<string, unknown>).source_file_id === fileId;
    }).length;
  }
  return count;
}

async function legacyUsage(db: Kysely<DB>, fileId: string): Promise<{ costUsd: number | null; tokens: number | null }> {
  const row = await db
    .selectFrom("llm_usage_events")
    .select([
      sql<number>`SUM(cost_usd)`.as("cost_usd"),
      sql<number>`SUM(
        CASE
          WHEN prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL
          THEN COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)
          ELSE NULL
        END
      )`.as("tokens"),
    ])
    .where("indexed_file_id", "=", fileId)
    .where("context", "like", "enrichment:%")
    .where("context", "!=", "enrichment:consolidatedLoop")
    .executeTakeFirst();
  const costUsd = row?.cost_usd == null ? null : Number(row.cost_usd);
  const tokens = row?.tokens == null ? null : Number(row.tokens);
  return { costUsd, tokens };
}

function pushUniqueById<T extends { id: string }>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? [];
  if (!values.some((candidate) => candidate.id === value.id)) values.push(value);
  map.set(key, values);
}

/** Reconstructs legacy mention decisions from current mutable rows. */
export async function loadLegacyMentionClassifications(
  db: Kysely<DB>,
  fileId: string,
): Promise<LegacyCompareMention[]> {
  const exactRows = await loadExactLegacyMentionRows(db, fileId);
  const linkedRows = await db
    .selectFrom("entity_mentions")
    .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
    .select([
      "entities.id as entityId",
      "entities.name as entityName",
      "entities.source_type as entityType",
      "entities.aliases",
    ])
    .where("entity_mentions.indexed_file_id", "=", fileId)
    .where("entity_mentions.relation", "=", "mentioned")
    .where("entity_mentions.source", "in", ["llm_extraction", "llm_relation"])
    .orderBy("entities.name", "asc")
    .orderBy("entities.id", "asc")
    .execute();
  const linkedByKey = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of linkedRows) {
    for (const name of [row.entityName, ...parseAliasesString(row.aliases)]) {
      pushUniqueById(linkedByKey, normalizedMentionKey(name, row.entityType), {
        id: row.entityId,
        name: row.entityName,
      });
    }
  }
  const queuedRows = await db
    .selectFrom("entity_review_evidence")
    .innerJoin("entity_review_queue", "entity_review_queue.id", "entity_review_evidence.review_id")
    .select([
      "entity_review_queue.id as reviewId",
      "entity_review_queue.normalized_name as normalizedName",
      "entity_review_queue.entity_type as entityType",
      "entity_review_queue.status as reviewStatus",
      "entity_review_queue.resolved_entity_id as resolvedEntityId",
    ])
    .where("entity_review_evidence.indexed_file_id", "=", fileId)
    .where("entity_review_evidence.source", "=", "llm_extraction")
    .orderBy("entity_review_queue.id", "asc")
    .execute();
  const reviewsByKey = new Map<string, Array<{ id: string; status: string; resolvedEntityId: string | null }>>();
  for (const row of queuedRows) {
    pushUniqueById(reviewsByKey, normalizedMentionKey(row.normalizedName, row.entityType), {
      id: row.reviewId,
      status: row.reviewStatus,
      resolvedEntityId: row.resolvedEntityId,
    });
  }
  return exactRows.map((mention) => {
    const entities = linkedByKey.get(mention.key) ?? [];
    const reviews = reviewsByKey.get(mention.key) ?? [];
    const remainingReviews =
      entities.length === 1 ? reviews.filter((review) => review.resolvedEntityId !== entities[0].id) : reviews;
    let classification: LegacyMentionStatus;
    if (entities.length === 1 && remainingReviews.length === 0) {
      classification = { status: "linked", entityId: entities[0].id, entityName: entities[0].name };
    } else if (entities.length === 0 && remainingReviews.length === 1) {
      classification = {
        status: "queued",
        reviewId: remainingReviews[0].id,
        reviewStatus: remainingReviews[0].status,
      };
    } else if (
      entities.length > 1 ||
      remainingReviews.length > 1 ||
      (entities.length > 0 && remainingReviews.length > 0)
    ) {
      classification = {
        status: "ambiguous",
        entityIds: entities.map((entity) => entity.id).sort(),
        reviewIds: remainingReviews.map((review) => review.id).sort(),
      };
    } else {
      classification = { status: "none" };
    }
    return { ...mention, ...classification };
  });
}

async function loadEntityNamesById(
  db: Kysely<DB>,
  entityIds: Iterable<string>,
): Promise<Map<string, LoopCompareEntityName>> {
  const ids = [...new Set(entityIds)].filter((id) => !id.startsWith("review:"));
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom("entities")
    .select(["id", "name", "deleted_at", "merged_into_entity_id"])
    .where("id", "in", ids)
    .execute();
  return new Map(
    rows.map((row) => [
      row.id,
      {
        name: row.name,
        live: row.deleted_at === null,
        ...(row.merged_into_entity_id ? { mergedIntoEntityId: row.merged_into_entity_id } : {}),
      },
    ]),
  );
}

function loopEntityIds(staged: ReportStagedDocument): string[] {
  return staged.mentions.flatMap((mention) => {
    const resolution = mention.resolution;
    if (["known", "tool", "matched", "judged"].includes(resolution.kind)) {
      return [(resolution as { entityId: string }).entityId];
    }
    if (resolution.kind === "hold") return resolution.candidates.map((candidate) => candidate.entityId);
    if (resolution.kind === "new") return resolution.rejectedCandidates ?? [];
    return [];
  });
}

export async function loadLoopCompareEntityNames(
  db: Kysely<DB>,
  staged: ReportStagedDocument,
): Promise<Map<string, LoopCompareEntityName>> {
  return loadEntityNamesById(db, [
    ...loopEntityIds(staged),
    ...staged.entityFacts.map((entityFact) => entityFact.entityId),
  ]);
}

async function loadMentionClassifications(
  db: Kysely<DB>,
  fileId: string,
  mentions: ReportLoopMention[],
): Promise<LoopMentionDiagnostic[]> {
  const legacyRows = await loadLegacyMentionClassifications(db, fileId);
  const legacyByKey = new Map(legacyRows.map((row) => [row.key, row]));
  const targetEntityIds = mentions.flatMap((mention) =>
    ["known", "tool", "matched", "judged"].includes(mention.resolution.kind)
      ? [(mention.resolution as { entityId: string }).entityId]
      : [],
  );
  const targetEntityNames = await loadEntityNamesById(db, targetEntityIds);
  return mentions.map((mention) => {
    const resolution = mention.resolution;
    const targetEntityId = ["known", "tool", "matched", "judged"].includes(resolution.kind)
      ? (resolution as { entityId: string }).entityId
      : null;
    const reconstructed = legacyByKey.get(normalizedMentionKey(mention.mention, mention.type));
    let legacy: LegacyMentionClassification;
    if (reconstructed?.status === "linked") {
      legacy = { kind: "linked", entityId: reconstructed.entityId ?? "", entityName: reconstructed.entityName ?? "" };
    } else if (reconstructed?.status === "queued") {
      legacy = { kind: "queued", status: reconstructed.reviewStatus ?? "" };
    } else if (reconstructed?.status === "ambiguous") {
      legacy = {
        kind: "ambiguous",
        entityIds: reconstructed.entityIds ?? [],
        reviewIds: reconstructed.reviewIds ?? [],
      };
    } else {
      legacy = { kind: "none" };
    }
    return {
      mention: mention.mention,
      type: mention.type,
      resolutionKind: resolution.kind,
      targetEntityId,
      targetEntityName: targetEntityId ? (targetEntityNames.get(targetEntityId)?.name ?? null) : null,
      holdReason: resolution.kind === "hold" ? resolution.reason : null,
      legacy,
    };
  });
}

function normalizeLoopMention(
  mention: ReportLoopMention,
  names: ReadonlyMap<string, LoopCompareEntityName>,
): LoopCompareMention {
  const resolution = mention.resolution;
  const base = {
    name: mention.mention,
    type: mention.type,
    variations: mention.variations,
    facts: mention.facts ?? [],
    originalKind: resolution.kind,
  };
  if (["known", "tool", "matched", "judged"].includes(resolution.kind)) {
    const entityId = (resolution as { entityId: string }).entityId;
    const entity = names.get(entityId);
    return {
      ...base,
      kind: "resolved",
      entityId,
      entityName: entity?.name ?? entityId,
      ...(entity ? { live: entity.live } : {}),
      ...(entity?.mergedIntoEntityId ? { mergedIntoEntityId: entity.mergedIntoEntityId } : {}),
      ...(resolution.kind === "judged" ? { reason: resolution.reason } : {}),
    };
  }
  if (resolution.kind === "hold") {
    return {
      ...base,
      kind: "hold",
      reason: resolution.reason,
      candidates: resolution.candidates.map((candidate) => {
        const entity = names.get(candidate.entityId);
        return {
          entityId: candidate.entityId,
          name: entity?.name ?? candidate.name ?? candidate.entityId,
          ...(entity ? { live: entity.live } : {}),
        };
      }),
    };
  }
  const rejectedCandidates = resolution.kind === "new" ? resolution.rejectedCandidates : undefined;
  return {
    ...base,
    kind: "new",
    rejectedCandidates: (rejectedCandidates ?? []).map((entityId) => ({
      entityId,
      name: names.get(entityId)?.name ?? entityId,
    })),
  };
}

function alignedLegacy(mention: LegacyCompareMention): NonNullable<AlignedMention["legacy"]> {
  const { key: _key, name: _name, type: _type, ...legacy } = mention;
  return legacy;
}

function alignedLoop(mention: LoopCompareMention): NonNullable<AlignedMention["loop"]> {
  return {
    kind: mention.kind,
    originalKind: mention.originalKind,
    ...(mention.entityId ? { entityId: mention.entityId } : {}),
    ...(mention.entityName ? { entityName: mention.entityName } : {}),
    ...(mention.live == null ? {} : { live: mention.live }),
    ...(mention.mergedIntoEntityId ? { mergedIntoEntityId: mention.mergedIntoEntityId } : {}),
    ...(mention.reason ? { reason: mention.reason } : {}),
    ...(mention.candidates ? { candidates: mention.candidates } : {}),
    ...(mention.rejectedCandidates ? { rejectedCandidates: mention.rejectedCandidates } : {}),
  };
}

function compareVerdict(
  legacy: LegacyCompareMention | undefined,
  loop: LoopCompareMention | undefined,
): LoopCompareVerdict {
  if (!legacy) return "loop_only";
  if (!loop) return "legacy_only";
  if (legacy.status === "ambiguous") return "indeterminate";
  if (loop.kind === "resolved") {
    if (legacy.status === "linked") return legacy.entityId === loop.entityId ? "same_target" : "different_target";
    if (legacy.status === "queued") return "loop_resolved_legacy_queued";
    return "loop_resolved_legacy_unresolved";
  }
  if (loop.kind === "hold") return legacy.status === "linked" ? "loop_hold_legacy_linked" : "both_unresolved";
  if (legacy.status === "linked") return "loop_new_legacy_linked";
  if (legacy.status === "queued") return "loop_new_legacy_queued";
  return "both_unresolved";
}

export function alignMentions(
  legacyRows: LegacyCompareMention[],
  loopMentions: ReportLoopMention[],
  names: ReadonlyMap<string, LoopCompareEntityName>,
): AlignedMention[] {
  const legacyByKey = new Map<string, LegacyCompareMention>();
  for (const row of legacyRows) {
    if (!legacyByKey.has(row.key)) legacyByKey.set(row.key, row);
  }
  const normalizedLoopMentions = loopMentions.map((mention) => normalizeLoopMention(mention, names));
  const loopByKey = new Map<string, LoopCompareMention>();
  for (const mention of normalizedLoopMentions) {
    const key = normalizedMentionKey(mention.name, mention.type);
    if (!loopByKey.has(key)) loopByKey.set(key, mention);
  }
  const keys = [...legacyByKey.keys(), ...[...loopByKey.keys()].filter((key) => !legacyByKey.has(key))];
  return keys
    .map((key) => {
      const legacy = legacyByKey.get(key);
      const loop = loopByKey.get(key);
      return {
        key,
        name: loop?.name ?? legacy?.name ?? key.split("\t")[0],
        type: loop?.type ?? legacy?.type ?? key.split("\t")[1],
        ...(legacy ? { legacy: alignedLegacy(legacy) } : {}),
        ...(loop ? { loop: alignedLoop(loop) } : {}),
        verdict: compareVerdict(legacy, loop),
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

const LOOP_COMPARE_VERDICTS: LoopCompareVerdict[] = [
  "same_target",
  "different_target",
  "loop_resolved_legacy_queued",
  "loop_resolved_legacy_unresolved",
  "loop_hold_legacy_linked",
  "loop_new_legacy_linked",
  "loop_new_legacy_queued",
  "loop_only",
  "legacy_only",
  "both_unresolved",
  "indeterminate",
];

export async function compareConsolidatedLoopStage(
  db: Kysely<DB>,
  file: ConsolidatedLoopReportFile,
  stage: ExtractionStage,
): Promise<LoopCompareDetail> {
  const staged = JSON.parse(stage.staged_json) as ReportStagedDocument;
  const stageSummary = summarizeStage(staged);
  const [legacyMentions, names, relationCount, factCount, usage] = await Promise.all([
    loadLegacyMentionClassifications(db, file.id),
    loadLoopCompareEntityNames(db, staged),
    legacyRelationCount(db, file.id),
    legacyFactCount(db, file.id),
    legacyUsage(db, file.id),
  ]);
  const loopMentions = staged.mentions.map((mention) => normalizeLoopMention(mention, names));
  const aligned = alignMentions(legacyMentions, staged.mentions, names);
  const verdicts = Object.fromEntries(LOOP_COMPARE_VERDICTS.map((verdict) => [verdict, 0])) as Record<
    LoopCompareVerdict,
    number
  >;
  for (const row of aligned) verdicts[row.verdict] += 1;
  const stale = stage.content_hash !== file.content_hash;
  return {
    file: {
      id: file.id,
      fileName: file.file_name,
      source: file.source,
      sourceBucket: sourceBucketFor(file),
      fileType: file.file_type,
      sourceCreatedAt: file.source_created_at,
      contentHash: file.content_hash,
      enrichmentStatus: file.enrichment_status,
      summary: file.summary,
    },
    stage: {
      id: stage.id,
      extractorVersion: stage.extractor_version as ConsolidatedLoopExtractorVersion,
      updatedAt: stage.updated_at,
      stale,
      ...(stale
        ? {
            staleNote:
              "stage content hash differs from the file's current content; legacy rows are from the current content",
          }
        : {}),
      model: stageSummary.model ?? stage.model,
      costUsd: stage.cost_usd == null ? null : Number(stage.cost_usd),
      tokens: {
        input: stage.input_tokens == null ? null : Number(stage.input_tokens),
        output: stage.output_tokens == null ? null : Number(stage.output_tokens),
      },
      toolSteps: stageSummary.toolSteps,
      guard: stageSummary.guard,
      validation: stageSummary.validation,
    },
    legacy: {
      summary: file.summary,
      mentions: legacyMentions,
      relationCount,
      factCount,
      costUsd: usage.costUsd,
      tokens: usage.tokens,
      reconstructed: true,
    },
    loop: {
      summary: staged.summary,
      mentions: loopMentions,
      relations: staged.relations,
      entityFacts: staged.entityFacts.map((row) => ({
        entityId: row.entityId,
        entityName: names.get(row.entityId)?.name ?? row.entityId,
        facts: row.facts,
      })),
      staged,
    },
    aligned,
    totals: {
      legacyMentions: legacyMentions.length,
      loopMentions: stageSummary.loopMentionCount,
      holds: stageSummary.holdCount,
      verdicts,
    },
  };
}

export async function evaluateConsolidatedLoopStage(
  db: Kysely<DB>,
  file: ConsolidatedLoopReportFile,
  stage: ExtractionStage,
): Promise<ConsolidatedLoopReportRow> {
  const stale = staleReportRow(file, stage);
  if (stale) return stale;
  const staged = JSON.parse(stage.staged_json) as ReportStagedDocument;
  const stageSummary = summarizeStage(staged);
  const legacyMentions = await legacyMentionRows(db, file.id);
  const loopMentionRows = staged.mentions.flatMap((mention) =>
    mention.type !== "team" ? [keysForMention(mention.mention, mention.variations, mention.type)] : [],
  );
  const loopKeys = new Set(loopMentionRows.flatMap((keys) => [...keys]));
  const legacyKeys = new Set(legacyMentions.flatMap((row) => [...row.keys]));
  const common = legacyMentions.filter((row) => intersects(row.keys, loopKeys)).length;
  const loopMatched = loopMentionRows.filter((keys) => intersects(keys, legacyKeys)).length;
  const holds = staged.mentions.filter((mention) => mention.resolution.kind === "hold");
  const legacy = await legacyUsage(db, file.id);
  const mentionDiagnostics = await loadMentionClassifications(db, file.id, staged.mentions);
  const loopTokens =
    stage.input_tokens == null && stage.output_tokens == null
      ? null
      : Number(stage.input_tokens ?? 0) + Number(stage.output_tokens ?? 0);
  return {
    fileId: file.id,
    source: sourceBucketFor(file),
    stageUpdatedAt: stage.updated_at,
    stale: false,
    mentionRecall: legacyMentions.length === 0 ? null : common / legacyMentions.length,
    mentionPrecision: loopMentionRows.length === 0 ? null : loopMatched / loopMentionRows.length,
    legacyMentionCount: legacyMentions.length,
    loopMentionCount: stageSummary.loopMentionCount,
    legacyRelationCount: await legacyRelationCount(db, file.id),
    loopRelationCount: staged.relations.length,
    legacyFactCount: await legacyFactCount(db, file.id),
    loopFactCount: staged.entityFacts.reduce((sum, row) => sum + row.facts.length, 0),
    legacySummary: (file.summary ?? "").slice(0, 200),
    loopSummary: staged.summary.slice(0, 200),
    holdCount: stageSummary.holdCount,
    holdsWithCandidates: holds.filter(
      (mention) => mention.resolution.kind === "hold" && mention.resolution.candidates.length > 0,
    ).length,
    guard: stageSummary.guard,
    legacyCostUsd: legacy.costUsd,
    loopCostUsd: stage.cost_usd == null ? null : Number(stage.cost_usd),
    legacyTokens: legacy.tokens,
    loopTokens,
    mentionDiagnostics,
    resolvedLegacyQueuedCount: mentionDiagnostics.filter(
      (diagnostic) =>
        ["known", "tool", "matched", "judged"].includes(diagnostic.resolutionKind) && isLegacyQueued(diagnostic.legacy),
    ).length,
  };
}

function isLegacyQueued(classification: LegacyMentionClassification): boolean {
  switch (classification.kind) {
    case "queued":
      return true;
    case "linked":
    case "ambiguous":
    case "none":
      return false;
  }
}

export async function evaluateCurrentConsolidatedLoopStage(
  db: Kysely<DB>,
  file: ConsolidatedLoopReportFile,
): Promise<ConsolidatedLoopReportRow> {
  const stage = await createExtractionStageRepository(db).getStage(
    file.id,
    file.content_hash,
    CONSOLIDATED_EXTRACTOR_VERSION,
  );
  if (!stage) throw new Error(`no ${CONSOLIDATED_EXTRACTOR_VERSION} stage found for file ${file.id}`);
  return evaluateConsolidatedLoopStage(db, file, stage);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function aggregateConsolidatedLoopReport(rows: ConsolidatedLoopReportRow[]): ConsolidatedLoopReportTotals {
  const compared = rows.filter((row): row is ComparedReportRow => !row.stale);
  const legacyCosts = compared.flatMap((row) => (row.legacyCostUsd == null ? [] : [row.legacyCostUsd]));
  const loopCosts = compared.flatMap((row) => (row.loopCostUsd == null ? [] : [row.loopCostUsd]));
  const legacyMentions = compared.reduce((sum, row) => sum + row.legacyMentionCount, 0);
  const common = compared.reduce((sum, row) => {
    const recall = row.mentionRecall ?? 0;
    return sum + recall * row.legacyMentionCount;
  }, 0);
  return {
    files: rows.length,
    comparedFiles: compared.length,
    staleFiles: rows.length - compared.length,
    legacyMentionCount: legacyMentions,
    loopMentionCount: compared.reduce((sum, row) => sum + row.loopMentionCount, 0),
    aggregateRecall: legacyMentions === 0 ? null : common / legacyMentions,
    meanLegacyCostUsd: mean(legacyCosts),
    medianLegacyCostUsd: median(legacyCosts),
    meanLoopCostUsd: mean(loopCosts),
    medianLoopCostUsd: median(loopCosts),
    resolvedLegacyQueuedCount: compared.reduce((sum, row) => sum + row.resolvedLegacyQueuedCount, 0),
    overriddenByMatcher: compared.reduce((sum, row) => sum + row.guard.overriddenByMatcher, 0),
    demotedUnoffered: compared.reduce((sum, row) => sum + row.guard.demotedUnoffered, 0),
  };
}

function markdownInline(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function targetDescription(diagnostic: LoopMentionDiagnostic): string {
  if (!diagnostic.targetEntityId) return diagnostic.resolutionKind;
  const name = diagnostic.targetEntityName ? ` (${markdownInline(diagnostic.targetEntityName)})` : "";
  return `${diagnostic.resolutionKind} -> ${diagnostic.targetEntityId}${name}`;
}

function legacyDescription(classification: LegacyMentionClassification): string {
  if (classification.kind === "linked") return `linked -> ${markdownInline(classification.entityName)}`;
  if (classification.kind === "queued") return `queued (${classification.status})`;
  if (classification.kind === "ambiguous") {
    return `ambiguous (${classification.entityIds.length} entities, ${classification.reviewIds.length} reviews)`;
  }
  return "none";
}

export function renderConsolidatedLoopReportMarkdown(
  runId: string,
  rows: ConsolidatedLoopReportRow[],
  totals: ConsolidatedLoopReportTotals,
): string {
  const tableHeader = [
    "| file | source | recall | precision | mentions legacy/loop | relations legacy/loop | facts legacy/loop",
    "| holds | guard | cost legacy/loop | tokens legacy/loop | summaries |",
  ].join(" ");
  const lines = [
    `# Consolidated Loop Eval ${runId}`,
    "",
    `Files: ${totals.files} (${totals.comparedFiles} compared, ${totals.staleFiles} stale)`,
    `Aggregate mention recall: ${totals.aggregateRecall == null ? "n/a" : totals.aggregateRecall.toFixed(3)}`,
    `Legacy cost mean/median: ${totals.meanLegacyCostUsd ?? "n/a"} / ${totals.medianLegacyCostUsd ?? "n/a"}`,
    `Loop cost mean/median: ${totals.meanLoopCostUsd ?? "n/a"} / ${totals.medianLoopCostUsd ?? "n/a"}`,
    `Loop-resolved mentions queued by legacy: ${totals.resolvedLegacyQueuedCount}`,
    `overriddenByMatcher: ${totals.overriddenByMatcher}`,
    `demotedUnoffered: ${totals.demotedUnoffered}`,
    "Legacy usage is all recorded usage for this file; run-level pairing is not available.",
    "",
    tableHeader,
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |",
  ];
  for (const row of rows) {
    if (row.stale) {
      lines.push(`| ${row.fileId} | ${row.source} | stale | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`);
      continue;
    }
    const guardSummary = [
      `${row.guard.overriddenByMatcher} overridden`,
      `${row.guard.demotedUnoffered} demoted`,
      `${row.guard.heldUnjudged} unjudged`,
      `${row.guard.heldPending} pending`,
      `${row.guard.newOverCandidates} new-over-candidates`,
      `${row.guard.registryLinked} registry-linked`,
      `${row.guard.matchToolCalls} match calls`,
      `${row.guard.droppedFacts} facts dropped`,
    ].join(", ");
    lines.push(
      `| ${[
        row.fileId,
        row.source,
        row.mentionRecall == null ? "n/a" : row.mentionRecall.toFixed(3),
        row.mentionPrecision == null ? "n/a" : row.mentionPrecision.toFixed(3),
        `${row.legacyMentionCount}/${row.loopMentionCount}`,
        `${row.legacyRelationCount}/${row.loopRelationCount}`,
        `${row.legacyFactCount}/${row.loopFactCount}`,
        `${row.holdCount} (${row.holdsWithCandidates} with candidates)`,
        guardSummary,
        `${row.legacyCostUsd ?? "n/a"}/${row.loopCostUsd ?? "n/a"}`,
        `${row.legacyTokens ?? "n/a"}/${row.loopTokens ?? "n/a"}`,
        `${markdownInline(row.legacySummary)} / ${markdownInline(row.loopSummary)}`,
      ].join(" | ")} |`,
    );
  }
  for (const row of rows) {
    lines.push("", `## ${row.fileId}`, "");
    if (row.stale) {
      lines.push(row.staleNote);
      continue;
    }
    lines.push(`Loop-resolved mentions queued by legacy: ${row.resolvedLegacyQueuedCount}`, "");
    if (row.mentionDiagnostics.length === 0) {
      lines.push("Loop mentions: none");
      continue;
    }
    for (const diagnostic of row.mentionDiagnostics) {
      const holdReason = diagnostic.holdReason ? `; hold reason: ${markdownInline(diagnostic.holdReason)}` : "";
      const resolution = targetDescription(diagnostic);
      const legacy = legacyDescription(diagnostic.legacy);
      const prefix = `- ${markdownInline(diagnostic.mention)} (${diagnostic.type})`;
      lines.push(`${prefix}: resolution ${resolution}${holdReason}; legacy ${legacy}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
