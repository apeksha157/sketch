import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import pino from "pino";
import type { Config } from "../config";
import type { DB } from "./schema";

/** Embedding dimensions by provider. Used when creating vec0 virtual tables. */
export const EMBEDDING_DIMENSIONS = 3072;

/**
 * Whether sqlite-vec was successfully loaded on the last createDatabase() call.
 * Search falls back to FTS-only when false.
 */
export let sqliteVecAvailable = false;

export function isSqliteVecAvailable(): boolean {
  return sqliteVecAvailable;
}

export function createPostgresPoolConfig(config: Config) {
  return {
    connectionString: config.DATABASE_URL,
    max: config.POSTGRES_POOL_MAX,
    ssl: { rejectUnauthorized: false },
  };
}

/**
 * Creates sqlite-vec virtual tables after the extension has been loaded. These live
 * outside Kysely migrations because vec0 table creation depends on the extension being
 * available in the raw SQLite connection first.
 */
export function ensureSqliteVecTables(sqlite: BetterSqlite3.Database): void {
  const pkByTable = {
    chunk_embeddings: "chunk_id",
    file_embeddings: "indexed_file_id",
    entity_name_embeddings: "entity_id",
    entity_review_queue_embeddings: "review_id",
  } as const;

  /**
   * Trunk-name dedup tables use explicit cosine distance so a `1 - distance`
   * conversion yields true cosine similarity, matching the Postgres halfvec
   * `<=>` path and making the dedup similarity threshold portable. The
   * chunk/file tables keep the default L2 metric — their score is only a soft
   * ranking signal blended with FTS, so changing it would shift existing search.
   */
  const cosineTables = new Set<keyof typeof pkByTable>(["entity_name_embeddings", "entity_review_queue_embeddings"]);

  for (const table of Object.keys(pkByTable) as Array<keyof typeof pkByTable>) {
    const pk = pkByTable[table];
    const metric = cosineTables.has(table) ? " distance_metric=cosine" : "";
    const existingDef = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as
      | { sql: string }
      | undefined;

    if (existingDef) {
      const dimMatch = existingDef.sql.match(/float\[(\d+)\]/);
      if (dimMatch && Number(dimMatch[1]) !== EMBEDDING_DIMENSIONS) {
        sqlite.exec(`DROP TABLE ${table}`);
        sqlite.exec(
          `UPDATE indexed_files SET embedding_status = 'pending' WHERE embedding_status IN ('done', 'processing')`,
        );
      } else {
        continue;
      }
    }

    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
        ${pk} TEXT PRIMARY KEY,
        embedding float[${EMBEDDING_DIMENSIONS}]${metric}
      )
    `);
  }
}

/**
 * Single source of truth for Postgres connections shared with the WhatsApp
 * gateway child, so TLS and tuning can never drift from the app's pool: a
 * divergence would make the gateway fail to reach the very database the app
 * is connected to. Callers may cap `max` below the configured
 * POSTGRES_POOL_MAX for low-concurrency processes.
 */
export async function createPgPool(config: Config, options: { max?: number } = {}) {
  const { Pool } = await import("pg");
  const poolConfig = createPostgresPoolConfig(config);
  return new Pool(options.max === undefined ? poolConfig : { ...poolConfig, max: options.max });
}

export async function createDatabase(config: Config): Promise<Kysely<DB>> {
  if (config.DB_TYPE === "postgres") {
    return new Kysely<DB>({
      dialect: new PostgresDialect({ pool: await createPgPool(config) }),
    });
  }

  const logger = pino({ level: "warn" });
  const Database = (await import("better-sqlite3")).default;
  mkdirSync(dirname(config.SQLITE_PATH), { recursive: true });
  const sqlite = new Database(config.SQLITE_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  // Load sqlite-vec extension for vector search. Treat as optional — the
  // extension may not be present in all environments. When unavailable, search
  // falls back to FTS-only and embedding operations are skipped.
  try {
    const sqliteVec = await import("sqlite-vec");
    sqliteVec.load(sqlite);
    sqliteVecAvailable = true;
    ensureSqliteVecTables(sqlite);
  } catch (err) {
    sqliteVecAvailable = false;
    logger.warn({ err }, "sqlite-vec extension unavailable — vector search disabled, falling back to FTS-only");
  }

  return new Kysely<DB>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
}
