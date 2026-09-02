import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import { normalizeEntityMatchName } from "../../entities/name-keys";
import { evaluateAdjacencyFromDatabase } from "./adjacency";
import { buildDupSuspectGroups } from "./dup-groups";

export const DEFAULT_MANIFEST_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "eval-manifest.json");

export const contentClassSchema = z.enum([
  "meeting_transcript",
  "email_message",
  "slack_conversation_slice",
  "whatsapp_conversation_slice",
  "issue",
  "other",
]);

export const manifestFileSchema = z.object({
  id: z.string(),
  contentSha256: z.string(),
  contentLength: z.number().int().nonnegative(),
  contentClass: contentClassSchema,
  contentCategory: z.string(),
  fileType: z.string().nullable(),
  source: z.string(),
});

export const dupSuspectPairSchema = z.object({
  reviewId: z.string(),
  employerEntityId: z.string(),
  candidateEntityIds: z.tuple([z.string(), z.string()]),
});

export const adjacencyWrongLinkSchema = z.object({
  fileId: z.string(),
  token: z.string(),
  pickedEntityId: z.string(),
  truthEntityId: z.string(),
});

export const manifestSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  sourceDatabase: z.string(),
  targetFileCount: z.number().int().positive(),
  files: z.array(manifestFileSchema),
  sets: z.object({
    pendingDeferredReviewIds: z.array(z.string()),
    singleTokenPersonReviewIds: z.array(z.string()),
    firstNameCollisionPersonEntityIds: z.array(z.string()),
    companyPendingReviewIds: z.array(z.string()),
    dupSuspectPairs: z.array(dupSuspectPairSchema),
  }),
  expectations: z.object({
    queueCensus: z.unknown(),
    stalenessSweepPreview: z.unknown(),
    adjacencyGroundTruth: z.object({
      trials: z.number().int().nonnegative(),
      linked: z.number().int().nonnegative(),
      correct: z.number().int().nonnegative(),
      wrong: z.number().int().nonnegative(),
      abstainNoSignal: z.number().int().nonnegative(),
      abstainAmbiguous: z.number().int().nonnegative(),
      precision: z.number(),
      coverage: z.number(),
      knownWrongLinks: z.array(adjacencyWrongLinkSchema),
    }),
    aliasProvenancePreview: z.unknown(),
    dupGroups: z.unknown(),
  }),
});

export type ResolutionEvalManifest = z.infer<typeof manifestSchema>;
export type ManifestFile = z.infer<typeof manifestFileSchema>;

interface FileRow {
  id: string;
  file_name: string;
  file_type: string | null;
  content_category: string;
  content: string | null;
  content_hash: string | null;
  source: string;
  source_path: string | null;
}

export interface QueueRow {
  id: string;
  proposed_name: string;
  normalized_name: string;
  entity_type: string;
  status: string;
  candidate_entity_id: string | null;
  candidate_entity_ids: string | null;
}

export interface LiveEntityRow {
  id: string;
  name: string;
  source_type: string;
  aliases: string | null;
  provenance_tier: string | null;
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function candidateEntityIds(row: Pick<QueueRow, "candidate_entity_id" | "candidate_entity_ids">): string[] {
  return [
    ...new Set(
      [row.candidate_entity_id, ...parseStringArray(row.candidate_entity_ids)].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  ].sort();
}

function hashContent(content: string | null): string {
  return createHash("sha256")
    .update(content ?? "")
    .digest("hex");
}

function classifyFile(row: FileRow): z.infer<typeof contentClassSchema> {
  const source = row.source.toLowerCase();
  const type = (row.file_type ?? "").toLowerCase();
  const category = row.content_category.toLowerCase();
  const path = (row.source_path ?? "").toLowerCase();
  const name = row.file_name.toLowerCase();
  if (source.includes("slack") || path.includes("slack")) return "slack_conversation_slice";
  if (source.includes("whatsapp") || path.includes("whatsapp")) return "whatsapp_conversation_slice";
  if (source.includes("gmail") || source.includes("outlook") || type.includes("email")) return "email_message";
  if (category === "meeting" || type.includes("meeting") || source.includes("fireflies")) return "meeting_transcript";
  if (type.includes("issue") || type.includes("task") || source.includes("linear") || source.includes("clickup")) {
    return "issue";
  }
  if (category === "conversation" || name.includes("conversation")) return "slack_conversation_slice";
  return "other";
}

function toManifestFile(row: FileRow): ManifestFile {
  const content = row.content ?? "";
  return {
    id: row.id,
    contentSha256: hashContent(row.content),
    contentLength: content.length,
    contentClass: classifyFile(row),
    contentCategory: row.content_category,
    fileType: row.file_type,
    source: row.source,
  };
}

function addSelectedFile(selected: Map<string, FileRow>, row: FileRow): void {
  if (!selected.has(row.id)) selected.set(row.id, row);
}

function selectCorpusFiles(requiredRows: FileRow[], candidateRows: FileRow[], targetFileCount: number): ManifestFile[] {
  const selected = new Map<string, FileRow>();
  for (const row of requiredRows) addSelectedFile(selected, row);

  const buckets = new Map<z.infer<typeof contentClassSchema>, FileRow[]>();
  for (const row of candidateRows) {
    const bucket = buckets.get(classifyFile(row));
    if (bucket) bucket.push(row);
    else buckets.set(classifyFile(row), [row]);
  }

  const classes = contentClassSchema.options;
  let madeProgress = true;
  while (selected.size < targetFileCount && madeProgress) {
    madeProgress = false;
    for (const contentClass of classes) {
      const bucket = buckets.get(contentClass) ?? [];
      while (bucket.length > 0) {
        const next = bucket.shift() as FileRow;
        if (selected.has(next.id)) continue;
        addSelectedFile(selected, next);
        madeProgress = true;
        break;
      }
      if (selected.size >= targetFileCount) break;
    }
  }

  return [...selected.values()].map(toManifestFile).sort((a, b) => a.id.localeCompare(b.id));
}

async function loadPendingDeferredRows(client: pg.Client): Promise<QueueRow[]> {
  const { rows } = await client.query<QueueRow>(
    `select id, proposed_name, normalized_name, entity_type, status, candidate_entity_id, candidate_entity_ids
     from entity_review_queue
     where status in ('pending', 'deferred')
     order by entity_type, normalized_name, id`,
  );
  return rows;
}

export function isSingleTokenPersonRow(row: Pick<QueueRow, "entity_type" | "proposed_name">): boolean {
  return row.entity_type === "person" && !/\s/.test(row.proposed_name.trim()) && row.proposed_name.trim().length > 0;
}

function candidatePresence(row: QueueRow): "none" | "single" | "multi" {
  const count = candidateEntityIds(row).length;
  if (count === 0) return "none";
  return count === 1 ? "single" : "multi";
}

function incrementNested(target: Record<string, Record<string, number>>, key: string, nestedKey: string): void {
  target[key] = target[key] ?? {};
  target[key][nestedKey] = (target[key][nestedKey] ?? 0) + 1;
}

export function queueCensusFromRows(rows: QueueRow[]): {
  byEntityType: Record<string, number>;
  byEntityTypeAndCandidatePresence: Record<string, Record<string, number>>;
  singleTokenPerson: { count: number; fanOut: Record<"1" | "2" | "3+", number> };
} {
  const byEntityType: Record<string, number> = {};
  const byEntityTypeAndCandidatePresence: Record<string, Record<string, number>> = {};
  const fanOut: Record<"1" | "2" | "3+", number> = { "1": 0, "2": 0, "3+": 0 };
  let singleTokenCount = 0;

  for (const row of rows) {
    byEntityType[row.entity_type] = (byEntityType[row.entity_type] ?? 0) + 1;
    incrementNested(byEntityTypeAndCandidatePresence, row.entity_type, candidatePresence(row));
    if (!isSingleTokenPersonRow(row)) continue;
    singleTokenCount += 1;
    const count = candidateEntityIds(row).length;
    if (count <= 1) fanOut["1"] += 1;
    else if (count === 2) fanOut["2"] += 1;
    else fanOut["3+"] += 1;
  }

  return { byEntityType, byEntityTypeAndCandidatePresence, singleTokenPerson: { count: singleTokenCount, fanOut } };
}

async function loadLiveEntities(client: pg.Client): Promise<LiveEntityRow[]> {
  const { rows } = await client.query<LiveEntityRow>(
    `select id, name, source_type, aliases, provenance_tier
     from entities
     where deleted_at is null and merged_into_entity_id is null
     order by source_type, name, id`,
  );
  return rows;
}

export function firstNameCollisionPersonIds(entities: LiveEntityRow[]): string[] {
  const groups = new Map<string, string[]>();
  for (const entity of entities) {
    if (entity.source_type !== "person") continue;
    const token = entity.name.trim().toLowerCase().split(/\s+/)[0] ?? "";
    if (token.length < 3) continue;
    const bucket = groups.get(token);
    if (bucket) bucket.push(entity.id);
    else groups.set(token, [entity.id]);
  }
  return [...groups.values()]
    .filter((ids) => ids.length >= 2)
    .flat()
    .sort();
}

export function stalenessSweepPreview(
  rows: QueueRow[],
  entities: LiveEntityRow[],
): {
  rows: number;
  uniqueMatchRows: number;
  multiMatchRows: number;
  noMatchRows: number;
  matchKind: Record<"name_only" | "alias_only" | "name_and_alias", number>;
} {
  const names = new Map<string, Set<string>>();
  const aliases = new Map<string, Set<string>>();
  for (const entity of entities) {
    const nameKey = `${entity.source_type}:${normalizeEntityMatchName(entity.source_type, entity.name)}`;
    const nameBucket = names.get(nameKey);
    if (nameBucket) nameBucket.add(entity.id);
    else names.set(nameKey, new Set([entity.id]));
    for (const alias of parseStringArray(entity.aliases)) {
      const aliasKey = `${entity.source_type}:${normalizeEntityMatchName(entity.source_type, alias)}`;
      const aliasBucket = aliases.get(aliasKey);
      if (aliasBucket) aliasBucket.add(entity.id);
      else aliases.set(aliasKey, new Set([entity.id]));
    }
  }

  const matchKind: Record<"name_only" | "alias_only" | "name_and_alias", number> = {
    name_only: 0,
    alias_only: 0,
    name_and_alias: 0,
  };
  let uniqueMatchRows = 0;
  let multiMatchRows = 0;
  let noMatchRows = 0;

  for (const row of rows) {
    const key = `${row.entity_type}:${row.normalized_name}`;
    const nameMatches = names.get(key) ?? new Set<string>();
    const aliasMatches = aliases.get(key) ?? new Set<string>();
    const allMatches = new Set([...nameMatches, ...aliasMatches]);
    if (allMatches.size === 0) {
      noMatchRows += 1;
      continue;
    }
    if (allMatches.size === 1) uniqueMatchRows += 1;
    else multiMatchRows += 1;
    if (nameMatches.size > 0 && aliasMatches.size > 0) matchKind.name_and_alias += 1;
    else if (nameMatches.size > 0) matchKind.name_only += 1;
    else matchKind.alias_only += 1;
  }

  return { rows: rows.length, uniqueMatchRows, multiMatchRows, noMatchRows, matchKind };
}

export async function buildAliasProvenancePreview(
  client: pg.Client,
  entities: LiveEntityRow[],
): Promise<{
  totalLiveAliases: number;
  byHeuristicSignal: Record<string, number>;
}> {
  const { rows: confirmedRows } = await client.query<{
    resolved_entity_id: string;
    proposed_name: string;
    entity_type: string;
  }>(
    `select resolved_entity_id, proposed_name, entity_type
     from entity_review_queue
     where status = 'confirmed' and resolved_entity_id is not null`,
  );
  const humanConfirmed = new Set(
    confirmedRows.map(
      (row) => `${row.resolved_entity_id}:${normalizeEntityMatchName(row.entity_type, row.proposed_name)}`,
    ),
  );

  const { rows: mergeRows } = await client.query<{
    survivor_entity_id: string;
    merged_name: string | null;
    merged_aliases: string | null;
    merged_source_type: string | null;
  }>(
    `select m.survivor_entity_id, e.name as merged_name, e.aliases as merged_aliases, e.source_type as merged_source_type
     from entity_merges m
     left join entities e on e.id = m.merged_entity_id
     where m.unmerged_at is null`,
  );
  const mergeAliases = new Set<string>();
  for (const row of mergeRows) {
    const entityType = row.merged_source_type ?? "";
    for (const value of [row.merged_name, ...parseStringArray(row.merged_aliases)]) {
      if (!value) continue;
      mergeAliases.add(`${row.survivor_entity_id}:${normalizeEntityMatchName(entityType, value)}`);
    }
  }

  const { rows: seedRows } = await client.query<{
    candidate_entity_id: string | null;
    entity_type: string;
    seed_aliases: string | null;
  }>(
    `select candidate_entity_id, entity_type, seed_aliases
     from entity_review_queue
     where candidate_entity_id is not null and seed_aliases is not null`,
  );
  const seedAliases = new Set<string>();
  for (const row of seedRows) {
    if (!row.candidate_entity_id) continue;
    for (const alias of parseStringArray(row.seed_aliases)) {
      seedAliases.add(`${row.candidate_entity_id}:${normalizeEntityMatchName(row.entity_type, alias)}`);
    }
  }

  const byHeuristicSignal: Record<string, number> = {};
  let totalLiveAliases = 0;
  for (const entity of entities) {
    for (const alias of parseStringArray(entity.aliases)) {
      totalLiveAliases += 1;
      const key = `${entity.id}:${normalizeEntityMatchName(entity.source_type, alias)}`;
      let signal = "legacy_unknown";
      if (humanConfirmed.has(key)) signal = "human_confirmed_review";
      else if (mergeAliases.has(key)) signal = "merge_loser_name_or_alias";
      else if (seedAliases.has(key)) signal = "seed_alias";
      else if (entity.provenance_tier && !["declared", "human_confirmed"].includes(entity.provenance_tier)) {
        signal = "model_or_sync_entity_row";
      }
      byHeuristicSignal[signal] = (byHeuristicSignal[signal] ?? 0) + 1;
    }
  }

  return { totalLiveAliases, byHeuristicSignal };
}

async function loadRequiredSingleTokenEvidenceFiles(client: pg.Client): Promise<FileRow[]> {
  const { rows } = await client.query<FileRow>(
    `select distinct f.id, f.file_name, f.file_type, f.content_category, f.content, f.content_hash, f.source, f.source_path
     from entity_review_queue q
     join entity_review_evidence ev on ev.review_id = q.id
     join indexed_files f on f.id = ev.indexed_file_id
     where q.status in ('pending', 'deferred')
       and q.entity_type = 'person'
       and trim(q.proposed_name) !~ '\\s'
     order by f.id`,
  );
  return rows;
}

async function loadCandidateFiles(client: pg.Client): Promise<FileRow[]> {
  const { rows } = await client.query<FileRow>(
    `select id, file_name, file_type, content_category, content, content_hash, source, source_path
     from indexed_files
     where is_archived = 0
     order by
       case
         when content_category = 'meeting' then 0
         when content_category = 'conversation' then 1
         when source ilike '%gmail%' or source ilike '%outlook%' then 2
         when source ilike '%linear%' or source ilike '%clickup%' then 3
         else 4
       end,
       source_updated_at desc nulls last,
       indexed_at desc,
       id
     limit 2000`,
  );
  return rows;
}

export async function buildResolutionEvalManifest(
  client: pg.Client,
  options: { sourceDatabase: string; targetFileCount?: number },
): Promise<ResolutionEvalManifest> {
  const targetFileCount = options.targetFileCount ?? 100;
  const pendingDeferredRows = await loadPendingDeferredRows(client);
  const entities = await loadLiveEntities(client);
  const requiredRows = await loadRequiredSingleTokenEvidenceFiles(client);
  const candidateRows = await loadCandidateFiles(client);
  const adjacency = await evaluateAdjacencyFromDatabase(client);
  const dupSuspectPairs = await buildDupSuspectGroups(
    client,
    pendingDeferredRows.map((row) => row.id),
  );
  const companyPendingReviewIds = pendingDeferredRows
    .filter((row) => row.entity_type === "company" && row.status === "pending")
    .map((row) => row.id)
    .sort();

  return manifestSchema.parse({
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceDatabase: options.sourceDatabase,
    targetFileCount,
    files: selectCorpusFiles(requiredRows, candidateRows, targetFileCount),
    sets: {
      pendingDeferredReviewIds: pendingDeferredRows.map((row) => row.id).sort(),
      singleTokenPersonReviewIds: pendingDeferredRows
        .filter(isSingleTokenPersonRow)
        .map((row) => row.id)
        .sort(),
      firstNameCollisionPersonEntityIds: firstNameCollisionPersonIds(entities),
      companyPendingReviewIds,
      dupSuspectPairs,
    },
    expectations: {
      queueCensus: queueCensusFromRows(pendingDeferredRows),
      stalenessSweepPreview: stalenessSweepPreview(pendingDeferredRows, entities),
      adjacencyGroundTruth: {
        ...adjacency.modes.edgeWinCoMentionVeto,
        knownWrongLinks: adjacency.modes.edgeWinCoMentionVeto.wrongLinks,
      },
      aliasProvenancePreview: await buildAliasProvenancePreview(client, entities),
      dupGroups: { pairCount: dupSuspectPairs.length, pairs: dupSuspectPairs },
    },
  });
}

export async function readManifest(path = DEFAULT_MANIFEST_PATH): Promise<ResolutionEvalManifest> {
  return manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function writeManifest(path: string, manifest: ResolutionEvalManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
