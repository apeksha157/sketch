import { parseArgs } from "node:util";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { loadConfig, validateConfig } from "../config";
import { createDatabase } from "../db";
import { runMigrations } from "../db/migrate";
import type { DB } from "../db/schema";
import { backfillEntityMentions } from "../entities/backfill-entity-mentions";
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

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      db: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const db = await createDbFromArg(parsed.values.db);
  try {
    await runMigrations(db);
    console.log(JSON.stringify(await backfillEntityMentions(db, { apply: parsed.values.apply }), null, 2));
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
