/**
 * Tests for the 019-connectors migration.
 *
 * Uses a fresh blank in-memory SQLite database with no prerequisites (connector_configs
 * and indexed_files are new tables created by this migration). Tests verify that both
 * tables are created with correct columns and defaults, that FTS5 and triggers are
 * functional, and that down() drops everything cleanly.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./019-connectors";

type ConnectorConfigRow = {
  id: string;
  connector_type: string;
  auth_type: string;
  credentials: string;
  scope_config: string;
  sync_status: string;
  sync_cursor: string | null;
  last_synced_at: string | null;
  error_message: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type IndexedFileRow = {
  id: string;
  connector_config_id: string;
  provider_file_id: string;
  provider_url: string | null;
  file_name: string;
  file_type: string | null;
  content_category: string;
  content: string | null;
  summary: string | null;
  tags: string | null;
  source: string;
  source_path: string | null;
  content_hash: string | null;
  is_archived: number;
  source_created_at: string | null;
  source_updated_at: string | null;
  synced_at: string;
  indexed_at: string;
  context_note: string | null;
  enrichment_status: string;
  access_scope_id: string | null;
  mime_type: string | null;
  embedding_status: string | null;
};

function createBlankDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("019-connectors migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await up(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates connector_configs table and allows inserting a row", async () => {
    type InsertRow = Omit<ConnectorConfigRow, "created_at" | "updated_at" | "scope_config" | "sync_status">;
    await (db as Kysely<{ connector_configs: InsertRow }>)
      .insertInto("connector_configs")
      .values({
        id: "connector-001",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: JSON.stringify({ access_token: "tok", refresh_token: "ref" }),
        sync_cursor: null,
        last_synced_at: null,
        error_message: null,
        created_by: "user-admin",
      })
      .execute();

    const rows = await (db as Kysely<{ connector_configs: ConnectorConfigRow }>)
      .selectFrom("connector_configs")
      .selectAll()
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("connector-001");
    expect(rows[0].connector_type).toBe("google_drive");
    expect(rows[0].auth_type).toBe("oauth");
  });

  it("applies default scope_config='{}' and sync_status='pending'", async () => {
    type InsertRow = Omit<ConnectorConfigRow, "created_at" | "updated_at" | "scope_config" | "sync_status">;
    await (db as Kysely<{ connector_configs: InsertRow }>)
      .insertInto("connector_configs")
      .values({
        id: "connector-002",
        connector_type: "notion",
        auth_type: "integration_token",
        credentials: JSON.stringify({ token: "secret" }),
        sync_cursor: null,
        last_synced_at: null,
        error_message: null,
        created_by: "user-admin",
      })
      .execute();

    const rows = await (db as Kysely<{ connector_configs: ConnectorConfigRow }>)
      .selectFrom("connector_configs")
      .selectAll()
      .execute();

    expect(rows[0].scope_config).toBe("{}");
    expect(rows[0].sync_status).toBe("pending");
    expect(rows[0].created_at).toBeDefined();
    expect(rows[0].updated_at).toBeDefined();
  });

  it("creates indexed_files table and allows inserting a row", async () => {
    await (
      db as Kysely<{
        connector_configs: Omit<ConnectorConfigRow, "created_at" | "updated_at" | "scope_config" | "sync_status">;
      }>
    )
      .insertInto("connector_configs")
      .values({
        id: "connector-003",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        sync_cursor: null,
        last_synced_at: null,
        error_message: null,
        created_by: "user-admin",
      })
      .execute();

    type InsertFile = Omit<IndexedFileRow, "is_archived" | "indexed_at" | "enrichment_status" | "embedding_status">;
    await (db as Kysely<{ indexed_files: InsertFile }>)
      .insertInto("indexed_files")
      .values({
        id: "file-001",
        connector_config_id: "connector-003",
        provider_file_id: "drive-abc123",
        provider_url: "https://drive.google.com/file/abc123",
        file_name: "Q1 Report.docx",
        file_type: "document",
        content_category: "document",
        content: "Full text content here",
        summary: null,
        tags: null,
        source: "google_drive",
        source_path: "/Reports/Q1",
        content_hash: "sha256abc",
        source_created_at: "2024-01-01T00:00:00Z",
        source_updated_at: "2024-03-31T00:00:00Z",
        synced_at: "2024-04-01T00:00:00Z",
        context_note: null,
        access_scope_id: null,
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })
      .execute();

    const rows = await (db as Kysely<{ indexed_files: IndexedFileRow }>)
      .selectFrom("indexed_files")
      .selectAll()
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("file-001");
    expect(rows[0].file_name).toBe("Q1 Report.docx");
    expect(rows[0].source).toBe("google_drive");
  });

  it("defaults is_archived=0, enrichment_status='raw', embedding_status='pending'", async () => {
    await (
      db as Kysely<{
        connector_configs: Omit<ConnectorConfigRow, "created_at" | "updated_at" | "scope_config" | "sync_status">;
      }>
    )
      .insertInto("connector_configs")
      .values({
        id: "connector-004",
        connector_type: "linear",
        auth_type: "api_key",
        credentials: "{}",
        sync_cursor: null,
        last_synced_at: null,
        error_message: null,
        created_by: "user-admin",
      })
      .execute();

    type InsertFile = Omit<IndexedFileRow, "is_archived" | "indexed_at" | "enrichment_status" | "embedding_status">;
    await (db as Kysely<{ indexed_files: InsertFile }>)
      .insertInto("indexed_files")
      .values({
        id: "file-002",
        connector_config_id: "connector-004",
        provider_file_id: "linear-issue-001",
        provider_url: null,
        file_name: "Bug: Login fails",
        file_type: "issue",
        content_category: "structured",
        content: null,
        summary: null,
        tags: null,
        source: "linear",
        source_path: null,
        content_hash: null,
        source_created_at: null,
        source_updated_at: null,
        synced_at: "2024-04-01T00:00:00Z",
        context_note: null,
        access_scope_id: null,
        mime_type: null,
      })
      .execute();

    const rows = await (db as Kysely<{ indexed_files: IndexedFileRow }>)
      .selectFrom("indexed_files")
      .selectAll()
      .execute();

    expect(rows[0].is_archived).toBe(0);
    expect(rows[0].enrichment_status).toBe("raw");
    expect(rows[0].embedding_status).toBe("pending");
    expect(rows[0].indexed_at).toBeDefined();
  });

  it("FTS5 trigger keeps indexed_files_fts in sync on insert", async () => {
    await (
      db as Kysely<{
        connector_configs: Omit<ConnectorConfigRow, "created_at" | "updated_at" | "scope_config" | "sync_status">;
      }>
    )
      .insertInto("connector_configs")
      .values({
        id: "connector-005",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        sync_cursor: null,
        last_synced_at: null,
        error_message: null,
        created_by: "user-admin",
      })
      .execute();

    type InsertFile = Omit<IndexedFileRow, "is_archived" | "indexed_at" | "enrichment_status" | "embedding_status">;
    await (db as Kysely<{ indexed_files: InsertFile }>)
      .insertInto("indexed_files")
      .values({
        id: "file-003",
        connector_config_id: "connector-005",
        provider_file_id: "drive-fts-test",
        provider_url: null,
        file_name: "Annual Strategy Document",
        file_type: "document",
        content_category: "document",
        content: "Strategic planning for next year",
        summary: "High-level strategy overview",
        tags: '["strategy", "planning"]',
        source: "google_drive",
        source_path: "/Strategy",
        content_hash: null,
        source_created_at: null,
        source_updated_at: null,
        synced_at: "2024-04-01T00:00:00Z",
        context_note: null,
        access_scope_id: null,
        mime_type: null,
      })
      .execute();

    // FTS5 MATCH query should find the inserted file
    const ftsResults = await sql<{ file_name: string }>`
      SELECT file_name FROM indexed_files_fts WHERE indexed_files_fts MATCH 'strategy'
    `.execute(db);

    expect(ftsResults.rows).toHaveLength(1);
    expect(ftsResults.rows[0].file_name).toBe("Annual Strategy Document");
  });

  it("down() drops indexed_files, connector_configs, FTS5 table, and triggers", async () => {
    await down(db);

    await expect(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='indexed_files'`.execute(db),
    ).resolves.toMatchObject({ rows: [] });

    await expect(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='connector_configs'`.execute(db),
    ).resolves.toMatchObject({ rows: [] });

    await expect(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='indexed_files_fts'`.execute(db),
    ).resolves.toMatchObject({ rows: [] });
  });
});
