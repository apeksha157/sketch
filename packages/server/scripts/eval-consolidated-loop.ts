import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config as loadEnv } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import pino from "pino";
import { runConsolidatedLoopShadow } from "../src/connectors/consolidated-loop";
import { getEmailThreadSummary } from "../src/connectors/email/thread-summary";
import { loadBaselineKnownEntities } from "../src/connectors/enrichment";
import { resolveOpenRouterEnrichmentConfig } from "../src/connectors/enrichment-providers";
import { buildFileScopedKnownEntities } from "../src/connectors/file-scope-context";
import { createOpenRouterGenerator } from "../src/connectors/openrouter-generate";
import { buildParticipantBlock } from "../src/connectors/participant-block";
import { buildPersonCandidateBlock, buildPersonCandidateScan } from "../src/connectors/person-candidate-scan";
import { createSettingsRepository, parseOrgContext } from "../src/db/repositories/settings";
import type { DB } from "../src/db/schema";
import {
  type ConsolidatedLoopReportFile,
  type ConsolidatedLoopReportRow,
  aggregateConsolidatedLoopReport,
  evaluateConsolidatedLoopStage,
  evaluateCurrentConsolidatedLoopStage,
  renderConsolidatedLoopReportMarkdown,
  selectConsolidatedLoopFilesById,
  selectConsolidatedLoopSampleFiles,
  selectExistingConsolidatedLoopStages,
} from "../src/eval/consolidated-loop-report";

loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const REPORT_DIR = join(dirname(fileURLToPath(import.meta.url)), "eval-consolidated-loop-reports");
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.6-luna";
const logger = pino({ level: "silent" });

function stringArg(value: string | string[] | boolean | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function positiveInteger(value: string | null, name: string): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string | null, name: string): number {
  if (value === null) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function isoDate(value: string | null): string | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) throw new Error("--since must be a valid ISO date");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("--since must be a valid ISO date");
  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

function parseCli() {
  const parsed = parseArgs({
    options: {
      db: { type: "string" },
      existing: { type: "boolean", default: false },
      files: { type: "string" },
      "file-ids": { type: "string" },
      limit: { type: "string" },
      model: { type: "string" },
      retries: { type: "string" },
      since: { type: "string" },
    },
  });
  const existing = parsed.values.existing === true;
  const filesArg = stringArg(parsed.values.files);
  const fileIdsArg = stringArg(parsed.values["file-ids"]);
  const modelArg = stringArg(parsed.values.model);
  if (existing && (filesArg !== null || modelArg !== null)) {
    throw new Error("--existing cannot be combined with --files or --model");
  }
  if (!existing && !filesArg && !fileIdsArg) throw new Error("pass --files <n> or --file-ids a,b,c");
  return {
    db: stringArg(parsed.values.db) ?? process.env.DATABASE_URL ?? null,
    existing,
    files: positiveInteger(filesArg, "--files"),
    fileIds: fileIdsArg
      ? fileIdsArg
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : null,
    limit: positiveInteger(stringArg(parsed.values.limit), "--limit"),
    model: modelArg ?? process.env.CONSOLIDATED_LOOP_MODEL ?? null,
    retries: nonNegativeInteger(stringArg(parsed.values.retries), "--retries"),
    since: isoDate(stringArg(parsed.values.since)),
  };
}

async function runAndEvaluateFile(
  db: Kysely<DB>,
  generator: ReturnType<typeof createOpenRouterGenerator>,
  file: ConsolidatedLoopReportFile,
): Promise<ConsolidatedLoopReportRow> {
  if (!file.content) throw new Error(`file ${file.id} has no content`);
  const settings = await createSettingsRepository(db, process.env.ENCRYPTION_KEY).get();
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
  return evaluateCurrentConsolidatedLoopStage(db, file);
}

async function evaluateExisting(
  db: Kysely<DB>,
  cli: ReturnType<typeof parseCli>,
): Promise<{
  rows: ConsolidatedLoopReportRow[];
  failures: Array<{ fileId: string; error: string }>;
}> {
  const selections = await selectExistingConsolidatedLoopStages(db, {
    fileIds: cli.fileIds,
    since: cli.since,
    limit: cli.limit,
  });
  const rows: ConsolidatedLoopReportRow[] = [];
  const failures: Array<{ fileId: string; error: string }> = [];
  for (const { file, stage } of selections) {
    try {
      rows.push(await evaluateConsolidatedLoopStage(db, file, stage));
      console.log(`reported ${file.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ fileId: file.id, error: message });
      console.log(`failed ${file.id}: ${message}`);
    }
  }
  return { rows, failures };
}

async function evaluateWithModel(
  db: Kysely<DB>,
  cli: ReturnType<typeof parseCli>,
): Promise<{
  rows: ConsolidatedLoopReportRow[];
  failures: Array<{ fileId: string; error: string }>;
}> {
  const settings = await createSettingsRepository(db, process.env.ENCRYPTION_KEY).get();
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
    ? await selectConsolidatedLoopFilesById(db, cli.fileIds)
    : await selectConsolidatedLoopSampleFiles(db, cli.files ?? 0);
  const rows: ConsolidatedLoopReportRow[] = [];
  const failures: Array<{ fileId: string; error: string }> = [];
  for (const file of files) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= cli.retries; attempt += 1) {
      try {
        rows.push(await runAndEvaluateFile(db, generator, file));
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
  return { rows, failures };
}

async function main(): Promise<void> {
  const cli = parseCli();
  if (!cli.db) throw new Error("DATABASE_URL is not set and --db was not provided");
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: cli.db, max: 2 }) }),
  });
  try {
    const { rows, failures } = cli.existing ? await evaluateExisting(db, cli) : await evaluateWithModel(db, cli);
    if (failures.length > 0) console.log(`failures: ${failures.length}/${rows.length + failures.length}`);
    const totals = aggregateConsolidatedLoopReport(rows);
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      join(REPORT_DIR, `${runId}.json`),
      JSON.stringify({ runId, mode: cli.existing ? "existing" : "model", totals, failures, rows }, null, 2),
    );
    writeFileSync(join(REPORT_DIR, `${runId}.md`), renderConsolidatedLoopReportMarkdown(runId, rows, totals));
    console.log(`wrote ${join(REPORT_DIR, `${runId}.json`)}`);
    console.log(`wrote ${join(REPORT_DIR, `${runId}.md`)}`);
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (message.includes("ENCRYPTION_KEY")) {
    console.error("set ENCRYPTION_KEY to the tenant's key to read encrypted settings");
  }
  process.exitCode = 1;
});
