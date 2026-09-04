import { parseArgs } from "node:util";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { loadConfig, validateConfig } from "../config";
import { createOpenRouterGenerator } from "../connectors/openrouter-generate";
import { createDatabase } from "../db";
import { runMigrations } from "../db/migrate";
import type { DB } from "../db/schema";
import { defaultJudgeDrainModel, runJudgeDrain } from "../entities/judge-drain";
import { connectionStringForDbArg } from "./resolution-eval/db";

async function createDbFromArg(dbArg: string | undefined): Promise<Kysely<DB>> {
  if (!dbArg) {
    const config = loadConfig();
    validateConfig(config);
    return createDatabase(config);
  }
  const pool = new pg.Pool({ connectionString: connectionStringForDbArg(dbArg) });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--limit must be a positive integer");
  return parsed;
}

function rowIds(value: string | undefined): string[] | undefined {
  const ids = value
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids && ids.length > 0 ? ids : undefined;
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      db: { type: "string" },
      limit: { type: "string" },
      model: { type: "string" },
      propose: { type: "boolean", default: false },
      "row-ids": { type: "string" },
    },
  });
  const config = loadConfig();
  validateConfig(config);
  const model = defaultJudgeDrainModel(parsed.values.model);
  if (!config.OPENROUTER_API_KEY) {
    throw new Error("Judge drain requires OPENROUTER_API_KEY because every docket row needs a model call.");
  }
  const db = await createDbFromArg(parsed.values.db);
  try {
    await runMigrations(db);
    const generator = createOpenRouterGenerator(config.OPENROUTER_API_KEY, {
      model,
      reasoningEffort: "medium",
      timeoutMs: 300_000,
    });
    const report = await runJudgeDrain(
      { db, generateAgenticJSON: generator.generateAgenticJSON, model },
      {
        limit: positiveInt(parsed.values.limit),
        propose: parsed.values.propose,
        rowIds: rowIds(parsed.values["row-ids"]),
      },
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
