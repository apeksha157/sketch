import { type Kysely, sql } from "kysely";
import {
  CONSOLIDATED_EXTRACTOR_VERSION,
  type ConsolidatedMention,
  type ConsolidatedStagedDocument,
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
  | { kind: "none" };

export interface LoopMentionDiagnostic {
  mention: string;
  type: string;
  resolutionKind: ConsolidatedMention["resolution"]["kind"];
  targetEntityId: string | null;
  targetEntityName: string | null;
  holdReason: string | null;
  legacy: LegacyMentionClassification;
}

interface ReportRowBase {
  fileId: string;
  source: string;
  stageCreatedAt: string;
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
  guard: { demotedUnoffered: number; droppedFacts: number };
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
}

export interface ExistingStageSelection {
  file: ConsolidatedLoopReportFile;
  stage: ExtractionStage;
}

function bucketFor(file: Pick<ConsolidatedLoopReportFile, "source" | "file_type" | "content_category">): string {
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
    const bucket = bucketFor(row);
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
    ])
    .where("id", "in", ids)
    .orderBy("id", "asc")
    .execute();
}

export async function selectExistingConsolidatedLoopStages(
  db: Kysely<DB>,
  options: { fileIds?: string[] | null; since?: string | null; limit?: number | null },
): Promise<ExistingStageSelection[]> {
  if (options.fileIds?.length === 0) return [];
  let query = db
    .selectFrom("extraction_stages")
    .selectAll()
    .where("extractor_version", "=", CONSOLIDATED_EXTRACTOR_VERSION)
    .where("status", "=", "staged");
  if (options.fileIds) query = query.where("indexed_file_id", "in", options.fileIds);
  if (options.since) query = query.where("created_at", ">=", options.since);
  const stages = await query
    .orderBy("updated_at", "desc")
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .execute();
  const latestByFile = new Map<string, ExtractionStage>();
  for (const stage of stages) {
    if (!latestByFile.has(stage.indexed_file_id)) latestByFile.set(stage.indexed_file_id, stage);
  }
  const latestStages = [...latestByFile.values()];
  const selectedStages = options.limit == null ? latestStages : latestStages.slice(0, options.limit);
  const files = await selectConsolidatedLoopFilesById(
    db,
    selectedStages.map((stage) => stage.indexed_file_id),
  );
  const filesById = new Map(files.map((file) => [file.id, file]));
  return selectedStages
    .flatMap((stage) => {
      const file = filesById.get(stage.indexed_file_id);
      return file ? [{ file, stage }] : [];
    })
    .sort((left, right) => left.file.id.localeCompare(right.file.id));
}

function normalizedMentionKey(name: string, type: string): string {
  const normalizedType = type.trim().toLowerCase();
  return `${normalizeEntityMatchName(normalizedType, name)}\t${normalizedType}`;
}

export function classifyLoopMentions(
  mentions: ConsolidatedMention[],
  linkedCandidates: LinkedMentionCandidate[],
  queuedCandidates: QueuedMentionCandidate[],
  targetEntityNames: ReadonlyMap<string, string>,
): LoopMentionDiagnostic[] {
  const linkedByMention = new Map<string, LinkedMentionCandidate>();
  for (const candidate of linkedCandidates) {
    for (const name of [candidate.entityName, ...(candidate.aliases ?? [])]) {
      const key = normalizedMentionKey(name, candidate.entityType);
      if (!linkedByMention.has(key)) linkedByMention.set(key, candidate);
    }
  }
  const queuedByMention = new Map<string, QueuedMentionCandidate>();
  for (const candidate of queuedCandidates) {
    const key = `${candidate.normalizedName}\t${candidate.entityType.trim().toLowerCase()}`;
    if (!queuedByMention.has(key)) queuedByMention.set(key, candidate);
  }
  return mentions.map((mention) => {
    const key = normalizedMentionKey(mention.mention, mention.type);
    const linked = linkedByMention.get(key);
    const queued = queuedByMention.get(key);
    const resolution = mention.resolution;
    const targetEntityId = resolution.kind === "known" || resolution.kind === "tool" ? resolution.entityId : null;
    const legacy: LegacyMentionClassification = linked
      ? { kind: "linked", entityId: linked.entityId, entityName: linked.entityName }
      : queued
        ? { kind: "queued", status: queued.status }
        : { kind: "none" };
    return {
      mention: mention.mention,
      type: mention.type,
      resolutionKind: resolution.kind,
      targetEntityId,
      targetEntityName: targetEntityId ? (targetEntityNames.get(targetEntityId) ?? null) : null,
      holdReason: resolution.kind === "hold" ? resolution.reason : null,
      legacy,
    };
  });
}

export function staleReportRow(file: ConsolidatedLoopReportFile, stage: ExtractionStage): StaleReportRow | null {
  if (stage.content_hash === file.content_hash) return null;
  const stageHash = stage.content_hash ?? "null";
  const currentHash = file.content_hash ?? "null";
  const staleNote = `stale: stage content hash ${stageHash} does not match current content hash ${currentHash}; comparison skipped`;
  return {
    fileId: file.id,
    source: bucketFor(file),
    stageCreatedAt: stage.created_at,
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

async function legacyMentionRows(db: Kysely<DB>, fileId: string): Promise<LegacyMentionRow[]> {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select(["subject_name", "raw_mention_type", "mention_type", "raw"])
    .where("indexed_file_id", "=", fileId)
    .where("fact_type", "=", "llm_extracted")
    .where("deleted_at", "is", null)
    .execute();
  return rows.flatMap((row) => {
    const raw = readJsonObject(row.raw);
    const name = row.subject_name ?? (typeof raw.mention === "string" ? raw.mention : null);
    const type = row.mention_type ?? row.raw_mention_type ?? (typeof raw.type === "string" ? raw.type : null);
    if (!name || !type || type === "team") return [];
    return [{ keys: keysForMention(name, raw.variations, type) }];
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
      sql<number>`SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0))`.as("tokens"),
    ])
    .where("indexed_file_id", "=", fileId)
    .where("context", "like", "enrichment:%")
    .where("context", "!=", "enrichment:consolidatedLoop")
    .executeTakeFirst();
  const costUsd = row?.cost_usd == null ? null : Number(row.cost_usd);
  const tokens = row?.tokens == null ? null : Number(row.tokens);
  return { costUsd, tokens };
}

async function loadMentionClassifications(
  db: Kysely<DB>,
  fileId: string,
  mentions: ConsolidatedMention[],
): Promise<LoopMentionDiagnostic[]> {
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
    .orderBy("entities.name", "asc")
    .orderBy("entities.id", "asc")
    .execute();
  const linkedCandidates = linkedRows.map((row) => ({
    entityId: row.entityId,
    entityName: row.entityName,
    entityType: row.entityType,
    aliases: parseAliasesString(row.aliases),
  }));
  const queuedCandidates = await db
    .selectFrom("entity_review_evidence")
    .innerJoin("entity_review_queue", "entity_review_queue.id", "entity_review_evidence.review_id")
    .select([
      "entity_review_queue.normalized_name as normalizedName",
      "entity_review_queue.entity_type as entityType",
      "entity_review_queue.status as status",
    ])
    .where("entity_review_evidence.indexed_file_id", "=", fileId)
    .orderBy("entity_review_queue.id", "asc")
    .execute();
  const targetEntityIds = [
    ...new Set(
      mentions.flatMap((mention) =>
        mention.resolution.kind === "known" || mention.resolution.kind === "tool" ? [mention.resolution.entityId] : [],
      ),
    ),
  ];
  const targetEntities =
    targetEntityIds.length === 0
      ? []
      : await db.selectFrom("entities").select(["id", "name"]).where("id", "in", targetEntityIds).execute();
  return classifyLoopMentions(
    mentions,
    linkedCandidates,
    queuedCandidates,
    new Map(targetEntities.map((entity) => [entity.id, entity.name])),
  );
}

export async function evaluateConsolidatedLoopStage(
  db: Kysely<DB>,
  file: ConsolidatedLoopReportFile,
  stage: ExtractionStage,
): Promise<ConsolidatedLoopReportRow> {
  const stale = staleReportRow(file, stage);
  if (stale) return stale;
  const staged = JSON.parse(stage.staged_json) as ConsolidatedStagedDocument;
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
    source: bucketFor(file),
    stageCreatedAt: stage.created_at,
    stale: false,
    mentionRecall: legacyMentions.length === 0 ? null : common / legacyMentions.length,
    mentionPrecision: loopMentionRows.length === 0 ? null : loopMatched / loopMentionRows.length,
    legacyMentionCount: legacyMentions.length,
    loopMentionCount: loopMentionRows.length,
    legacyRelationCount: await legacyRelationCount(db, file.id),
    loopRelationCount: staged.relations.length,
    legacyFactCount: await legacyFactCount(db, file.id),
    loopFactCount: staged.entityFacts.reduce((sum, row) => sum + row.facts.length, 0),
    legacySummary: (file.summary ?? "").slice(0, 200),
    loopSummary: staged.summary.slice(0, 200),
    holdCount: holds.length,
    holdsWithCandidates: holds.filter(
      (mention) => mention.resolution.kind === "hold" && mention.resolution.candidates.length > 0,
    ).length,
    guard: {
      demotedUnoffered: staged.meta.guard.demotedUnoffered,
      droppedFacts: staged.meta.guard.droppedFacts,
    },
    legacyCostUsd: legacy.costUsd,
    loopCostUsd: stage.cost_usd == null ? null : Number(stage.cost_usd),
    legacyTokens: legacy.tokens,
    loopTokens,
    mentionDiagnostics,
    resolvedLegacyQueuedCount: mentionDiagnostics.filter(
      (diagnostic) =>
        (diagnostic.resolutionKind === "known" || diagnostic.resolutionKind === "tool") &&
        diagnostic.legacy.kind === "queued",
    ).length,
  };
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
  return "none";
}

export function renderConsolidatedLoopReportMarkdown(
  runId: string,
  rows: ConsolidatedLoopReportRow[],
  totals: ConsolidatedLoopReportTotals,
): string {
  const tableHeader =
    "| file | source | recall | precision | mentions legacy/loop | relations legacy/loop | facts legacy/loop " +
    "| holds | guard | cost legacy/loop | tokens legacy/loop | summaries |";
  const lines = [
    `# Consolidated Loop Eval ${runId}`,
    "",
    `Files: ${totals.files} (${totals.comparedFiles} compared, ${totals.staleFiles} stale)`,
    `Aggregate mention recall: ${totals.aggregateRecall == null ? "n/a" : totals.aggregateRecall.toFixed(3)}`,
    `Legacy cost mean/median: ${totals.meanLegacyCostUsd ?? "n/a"} / ${totals.medianLegacyCostUsd ?? "n/a"}`,
    `Loop cost mean/median: ${totals.meanLoopCostUsd ?? "n/a"} / ${totals.medianLoopCostUsd ?? "n/a"}`,
    `Loop-resolved mentions queued by legacy: ${totals.resolvedLegacyQueuedCount}`,
    "",
    tableHeader,
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |",
  ];
  for (const row of rows) {
    if (row.stale) {
      lines.push(`| ${row.fileId} | ${row.source} | stale | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`);
      continue;
    }
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
        `${row.guard.demotedUnoffered} demoted, ${row.guard.droppedFacts} facts dropped`,
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
