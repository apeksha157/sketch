import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import pg from "pg";
import { loadConfig, validateConfig } from "../config";
import { SalesqlClient } from "../connectors/enrichment/salesql-client";
import { parseLinkedinEnrichmentScope } from "../connectors/enrichment/scope";
import { createDatabase } from "../db";
import { runMigrations } from "../db/migrate";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { DB } from "../db/schema";
import { emptyEnrichmentSweepReport, runEnrichmentSweep } from "../entities/enrichment-sweep";
import { createLogger } from "../logger";
import { connectionStringForDbArg, isConnectionString } from "./resolution-eval/db";

async function createDbFromArg(dbArg: string | undefined): Promise<Kysely<DB>> {
  if (!dbArg) {
    const config = loadConfig();
    validateConfig(config);
    return createDatabase(config);
  }
  if (isConnectionString(dbArg) && !dbArg.startsWith("file:")) {
    const pool = new pg.Pool({ connectionString: connectionStringForDbArg(dbArg) });
    return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  }
  const path = dbArg.startsWith("file:") ? new URL(dbArg).pathname : dbArg;
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--limit must be a positive integer");
  return parsed;
}

async function readScope(db: Kysely<DB>, encryptionKey: string | undefined) {
  const configs = await createConnectorRepository(db, encryptionKey).findConfigsByType("linkedin_aimfox");
  for (const config of configs) {
    const scope = parseLinkedinEnrichmentScope(JSON.parse(config.scope_config) as Record<string, unknown>);
    if (scope.enabled) return scope;
  }
  return null;
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      db: { type: "string" },
      apply: { type: "boolean", default: false },
      limit: { type: "string" },
    },
  });
  const config = loadConfig();
  validateConfig(config);
  if (!config.SALESQL_API_KEY) throw new Error("SalesQL enrichment requires SALESQL_API_KEY.");

  const db = await createDbFromArg(parsed.values.db);
  try {
    await runMigrations(db);
    const scope = await readScope(db, config.ENCRYPTION_KEY);
    const report = scope?.enabled
      ? await runEnrichmentSweep(
          {
            db,
            provider: new SalesqlClient(config.SALESQL_API_KEY),
            logger: createLogger(config).child({ component: "salesql-enrichment-cli" }),
          },
          {
            apply: parsed.values.apply,
            limit: positiveInt(parsed.values.limit),
            dailyCap: scope.dailyCap,
            batch: scope.batch,
            autoMerge: scope.autoMerge,
          },
        )
      : emptyEnrichmentSweepReport();
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
