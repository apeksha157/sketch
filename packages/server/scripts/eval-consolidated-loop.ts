import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config as loadEnv } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import pino from "pino";
import { CONSOLIDATED_EXTRACTOR_VERSION, runConsolidatedLoopShadow } from "../src/connectors/consolidated-loop";
import { getEmailThreadSummary } from "../src/connectors/email/thread-summary";
import { loadBaselineKnownEntities } from "../src/connectors/enrichment";
import { resolveOpenRouterEnrichmentConfig } from "../src/connectors/enrichment-providers";
import { type KnownEntityForPrompt, buildFileScopedKnownEntities } from "../src/connectors/file-scope-context";
import { createOpenRouterGenerator } from "../src/connectors/openrouter-generate";
import { buildParticipantBlock } from "../src/connectors/participant-block";
import { buildPersonCandidateBlock, buildPersonCandidateScan } from "../src/connectors/person-candidate-scan";
import { createSettingsRepository, parseOrgContext } from "../src/db/repositories/settings";
import type { DB } from "../src/db/schema";
import { readJsonObject } from "../src/entities/materialize-json";
import { normalizeName } from "../src/entities/name-keys";

loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

type FileRow = {
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
};

type StagedDoc = {
  mentions?: Array<{ mention?: unknown; type?: unknown; resolution?: { kind?: unknown; candidates?: unknown[] } }>;
  relations?: unknown[];
  entityFacts?: Array<{ facts?: unknown[] }>;
  summary?: unknown;
  meta?: {
    guard?: { demotedUnoffered?: number; droppedFacts?: number };
  };
};

type ReportRow = {
  fileId: string;
  source: string;
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
};

const REPORT_DIR = join(dirname(fileURLToPath(import.meta.url)), "eval-consolidated-loop-reports");
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.6-luna";
const logger = pino({ level: "silent" });

function stringArg(value: string | string[] | boolean | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function parseCli() {
  const parsed = parseArgs({
    options: {
      db: { type: "string" },
      files: { type: "string" },
      "file-ids": { type: "string" },
      model: { type: "string" },
    },
  });
  const files = stringArg(parsed.values.files);
  const fileIds = stringArg(parsed.values["file-ids"]);
  if (!files && !fileIds) throw new Error("pass --files <n> or --file-ids a,b,c");
  return {
    db: stringArg(parsed.values.db) ?? process.env.DATABASE_URL ?? null,
    files: files ? Number(files) : null,
    fileIds: fileIds
      ? fileIds
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : null,
    model: stringArg(parsed.values.model) ?? process.env.CONSOLIDATED_LOOP_MODEL ?? null,
  };
}

function bucketFor(file: Pick<FileRow, "source" | "file_type" | "content_category">): string {
  const value = `${file.source} ${file.file_type ?? ""} ${file.content_category}`.toLowerCase();
  if (value.includes("fireflies")) return "fireflies";
  if (value.includes("email") || value.includes("outlook")) return "email";
  if (value.includes("slack")) return "slack";
  if (value.includes("whatsapp")) return "whatsapp";
  return "docs";
}

async function selectSampleFiles(db: Kysely<DB>, limit: number): Promise<FileRow[]> {
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
  const buckets = new Map<string, FileRow[]>();
  for (const row of rows) {
    const bucket = bucketFor(row);
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), row]);
  }
  const selected: FileRow[] = [];
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

async function selectExplicitFiles(db: Kysely<DB>, ids: string[]): Promise<FileRow[]> {
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
    ...(Array.isArray(variations) ? variations.filter((v): v is string => typeof v === "string") : []),
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
    .executeTakeFirst();
  const costUsd = row?.cost_usd == null ? null : Number(row.cost_usd);
  const tokens = row?.tokens == null ? null : Number(row.tokens);
  return { costUsd, tokens };
}

function parseStage(raw: string): StagedDoc {
  return JSON.parse(raw) as StagedDoc;
}

async function evaluateFile(
  db: Kysely<DB>,
  generator: ReturnType<typeof createOpenRouterGenerator>,
  file: FileRow,
): Promise<ReportRow> {
  if (!file.content) throw new Error(`file ${file.id} has no content`);
  const settings = await createSettingsRepository(db).get();
  const parsedOrg = settings?.org_context ? parseOrgContext(settings.org_context) : null;
  const orgContext = parsedOrg
    ? {
        orgName: settings?.org_name ?? undefined,
        description: parsedOrg.description,
        industry: parsedOrg.industry,
        disambiguationGuidance: parsedOrg.disambiguationGuidance,
      }
    : null;
  const baselineKnown = await loadBaselineKnownEntities(db);
  const knownEntities = await buildFileScopedKnownEntities({ db, logger }, file.id, baselineKnown, file.content);
  const participantBlock = await buildParticipantBlock({ db, logger }, { fileId: file.id, fileContent: file.content });
  const scan = await buildPersonCandidateScan(db);
  const personCandidateBlock = buildPersonCandidateBlock(scan, file.content, { participantBlock });
  const threadContext =
    file.file_type === "email_message"
      ? await getEmailThreadSummary(db, file.connector_config_id, file.thread_id)
      : null;
  await runConsolidatedLoopShadow(
    {
      db,
      logger,
      agenticGenerator: generator,
      orgContext,
      knownEntities,
      participantBlock,
      personCandidateBlock,
      threadContext,
    },
    {
      id: file.id,
      fileName: file.file_name,
      content: file.content,
      threadContext,
      contentCategory: file.content_category,
      fileType: file.file_type,
      source: file.source_path?.split("/")[0] ?? file.source,
      sourcePath: file.source_path,
      contentHash: file.content_hash,
      connectorConfigId: file.connector_config_id,
      sourceCreatedAt: file.source_created_at,
      sourceUpdatedAt: file.source_updated_at,
    },
  );
  const stage = await db
    .selectFrom("extraction_stages")
    .selectAll()
    .where("indexed_file_id", "=", file.id)
    .where("content_hash", file.content_hash === null ? "is" : "=", file.content_hash)
    .where("extractor_version", "=", CONSOLIDATED_EXTRACTOR_VERSION)
    .executeTakeFirstOrThrow();
  const staged = parseStage(stage.staged_json);
  const legacyMentions = await legacyMentionRows(db, file.id);
  const loopMentionRows = (staged.mentions ?? []).flatMap((mention) =>
    typeof mention.mention === "string" && typeof mention.type === "string" && mention.type !== "team"
      ? [keysForMention(mention.mention, (mention as { variations?: unknown }).variations, mention.type)]
      : [],
  );
  const loopKeys = new Set(loopMentionRows.flatMap((keys) => [...keys]));
  const legacyKeys = new Set(legacyMentions.flatMap((row) => [...row.keys]));
  const common = legacyMentions.filter((row) => intersects(row.keys, loopKeys)).length;
  const loopMatched = loopMentionRows.filter((keys) => intersects(keys, legacyKeys)).length;
  const holds = (staged.mentions ?? []).filter((mention) => mention.resolution?.kind === "hold");
  const legacy = await legacyUsage(db, file.id);
  const loopTokens =
    stage.input_tokens == null && stage.output_tokens == null
      ? null
      : Number(stage.input_tokens ?? 0) + Number(stage.output_tokens ?? 0);
  return {
    fileId: file.id,
    source: bucketFor(file),
    mentionRecall: legacyMentions.length === 0 ? null : common / legacyMentions.length,
    mentionPrecision: loopMentionRows.length === 0 ? null : loopMatched / loopMentionRows.length,
    legacyMentionCount: legacyMentions.length,
    loopMentionCount: loopMentionRows.length,
    legacyRelationCount: await legacyRelationCount(db, file.id),
    loopRelationCount: staged.relations?.length ?? 0,
    legacyFactCount: await legacyFactCount(db, file.id),
    loopFactCount: (staged.entityFacts ?? []).reduce((sum, row) => sum + (row.facts?.length ?? 0), 0),
    legacySummary: (file.summary ?? "").slice(0, 200),
    loopSummary: typeof staged.summary === "string" ? staged.summary.slice(0, 200) : "",
    holdCount: holds.length,
    holdsWithCandidates: holds.filter((mention) => (mention.resolution?.candidates?.length ?? 0) > 0).length,
    guard: {
      demotedUnoffered: staged.meta?.guard?.demotedUnoffered ?? 0,
      droppedFacts: staged.meta?.guard?.droppedFacts ?? 0,
    },
    legacyCostUsd: legacy.costUsd,
    loopCostUsd: stage.cost_usd,
    legacyTokens: legacy.tokens,
    loopTokens,
  };
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

function aggregate(rows: ReportRow[]) {
  const legacyCosts = rows.flatMap((row) => (row.legacyCostUsd == null ? [] : [row.legacyCostUsd]));
  const loopCosts = rows.flatMap((row) => (row.loopCostUsd == null ? [] : [row.loopCostUsd]));
  const legacyMentions = rows.reduce((sum, row) => sum + row.legacyMentionCount, 0);
  const common = rows.reduce((sum, row) => {
    const recall = row.mentionRecall ?? 0;
    return sum + recall * row.legacyMentionCount;
  }, 0);
  return {
    files: rows.length,
    legacyMentionCount: legacyMentions,
    loopMentionCount: rows.reduce((sum, row) => sum + row.loopMentionCount, 0),
    aggregateRecall: legacyMentions === 0 ? null : common / legacyMentions,
    meanLegacyCostUsd: mean(legacyCosts),
    medianLegacyCostUsd: median(legacyCosts),
    meanLoopCostUsd: mean(loopCosts),
    medianLoopCostUsd: median(loopCosts),
  };
}

function markdown(runId: string, rows: ReportRow[], totals: ReturnType<typeof aggregate>): string {
  const lines = [
    `# Consolidated Loop Eval ${runId}`,
    "",
    `Files: ${totals.files}`,
    `Aggregate mention recall: ${totals.aggregateRecall == null ? "n/a" : totals.aggregateRecall.toFixed(3)}`,
    `Legacy cost mean/median: ${totals.meanLegacyCostUsd ?? "n/a"} / ${totals.medianLegacyCostUsd ?? "n/a"}`,
    `Loop cost mean/median: ${totals.meanLoopCostUsd ?? "n/a"} / ${totals.medianLoopCostUsd ?? "n/a"}`,
    "",
    "| file | source | recall | precision | mentions legacy/loop | relations legacy/loop | facts legacy/loop | holds | guard | cost legacy/loop | tokens legacy/loop | summaries |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |",
  ];
  for (const row of rows) {
    lines.push(
      [
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
        `${row.legacySummary.replace(/\|/g, "\\|")} / ${row.loopSummary.replace(/\|/g, "\\|")}`,
      ].join(" | "),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const cli = parseCli();
  if (!cli.db) throw new Error("DATABASE_URL is not set and --db was not provided");
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: cli.db, max: 2 }) }),
  });
  try {
    const settings = await createSettingsRepository(db).get();
    const openRouter = resolveOpenRouterEnrichmentConfig(settings, process.env.OPENROUTER_API_KEY);
    if (!openRouter.openRouterApiKey) throw new Error("OpenRouter API key is required");
    const model =
      cli.model ?? process.env.PROJECT_MINTING_MODEL ?? openRouter.openRouterModel ?? DEFAULT_OPENROUTER_MODEL;
    const generator = createOpenRouterGenerator(openRouter.openRouterApiKey, {
      model,
      reasoningEffort: "medium",
      timeoutMs: 300_000,
    });
    const files = cli.fileIds
      ? await selectExplicitFiles(db, cli.fileIds)
      : await selectSampleFiles(db, cli.files ?? 0);
    const rows: ReportRow[] = [];
    const failures: Array<{ fileId: string; error: string }> = [];
    for (const file of files) {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          rows.push(await evaluateFile(db, generator, file));
          console.log(`evaluated ${file.id}`);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) {
        const message = lastError instanceof Error ? lastError.message : String(lastError);
        failures.push({ fileId: file.id, error: message });
        console.log(`failed ${file.id}: ${message}`);
      }
    }
    if (failures.length > 0) console.log(`failures: ${failures.length}/${files.length}`);
    const totals = aggregate(rows);
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(join(REPORT_DIR, `${runId}.json`), JSON.stringify({ runId, totals, failures, rows }, null, 2));
    writeFileSync(join(REPORT_DIR, `${runId}.md`), markdown(runId, rows, totals));
    console.log(`wrote ${join(REPORT_DIR, `${runId}.json`)}`);
    console.log(`wrote ${join(REPORT_DIR, `${runId}.md`)}`);
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
