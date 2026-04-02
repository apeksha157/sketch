/**
 * File access control infrastructure.
 *
 * - access_scopes: scope-level grouping (workspace, space, drive) instead of
 *   per-file × per-user materialized rows
 * - access_scope_members: email-based scope membership
 * - connector_files: junction table for file deduplication across connectors
 * - file_access: email-based per-file access list
 * - Unique index on (source, provider_file_id) for file deduplication
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── 1. Create access_scopes table ──────────────────────
  await db.schema
    .createTable("access_scopes")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("connector_config_id", "text", (col) => col.notNull().references("connector_configs.id"))
    .addColumn("scope_type", "text", (col) => col.notNull()) // 'workspace' | 'space' | 'drive' | 'folder'
    .addColumn("provider_scope_id", "text", (col) => col.notNull())
    .addColumn("label", "text")
    .execute();

  await sql`CREATE UNIQUE INDEX idx_access_scopes_connector_provider ON access_scopes(connector_config_id, provider_scope_id)`.execute(
    db,
  );

  // ── 2. Create access_scope_members table ───────────────
  await db.schema
    .createTable("access_scope_members")
    .addColumn("access_scope_id", "text", (col) => col.notNull().references("access_scopes.id").onDelete("cascade"))
    .addColumn("email", "text", (col) => col.notNull())
    .execute();

  await sql`CREATE UNIQUE INDEX idx_scope_members_pk ON access_scope_members(access_scope_id, email)`.execute(db);
  await sql`CREATE INDEX idx_scope_members_email ON access_scope_members(email)`.execute(db);

  // ── 3. Create connector_files junction table ───────────
  await db.schema
    .createTable("connector_files")
    .addColumn("connector_config_id", "text", (col) =>
      col.notNull().references("connector_configs.id").onDelete("cascade"),
    )
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .execute();

  await sql`CREATE UNIQUE INDEX idx_connector_files_pk ON connector_files(connector_config_id, indexed_file_id)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_connector_files_file ON connector_files(indexed_file_id)`.execute(db);

  // ── 4. Create file_access table (email-based) ──────────
  await db.schema
    .createTable("file_access")
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("email", "text", (col) => col.notNull())
    .execute();

  await sql`CREATE UNIQUE INDEX idx_file_access_pk ON file_access(indexed_file_id, email)`.execute(db);
  await sql`CREATE INDEX idx_file_access_email ON file_access(email)`.execute(db);

  // ── 5. Unique index for file deduplication ─────────────
  await sql`CREATE UNIQUE INDEX idx_indexed_files_source_provider ON indexed_files(source, provider_file_id)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_indexed_files_source_provider`.execute(db);
  await db.schema.dropTable("file_access").execute();
  await db.schema.dropTable("connector_files").execute();
  await db.schema.dropTable("access_scope_members").execute();
  await db.schema.dropTable("access_scopes").execute();
}
