import { type Kysely, sql } from "kysely";

/**
 * Speeds up the unrestricted visibility door used by set-based RBAC pre-filtering.
 * `source` is included because that door also excludes Slack and WhatsApp rows while
 * Slack entity sync is enabled.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS idx_indexed_files_public
    ON indexed_files (id, source)
    WHERE is_archived = 0 AND access_scope_id IS NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_indexed_files_public`.execute(db);
}
