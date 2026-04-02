/**
 * Tests for the 021-file-access migration.
 *
 * Uses a fresh blank in-memory SQLite database. Prerequisites created manually:
 * - connector_configs (from 019)
 * - indexed_files (from 019, without FTS/triggers for simplicity)
 *
 * Tests verify that access_scopes, access_scope_members, connector_files, and
 * file_access tables are created with correct columns and unique indexes, and that
 * the unique deduplication index on indexed_files(source, provider_file_id) is
 * enforced. down() reverses all of this.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./021-file-access";

function createBlankDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

async function createPrerequisites(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("connector_configs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("connector_type", "text", (col) => col.notNull())
    .addColumn("auth_type", "text", (col) => col.notNull())
    .addColumn("credentials", "text", (col) => col.notNull())
    .addColumn("scope_config", "text", (col) => col.notNull().defaultTo("{}"))
    .addColumn("sync_status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("sync_cursor", "text")
    .addColumn("last_synced_at", "text")
    .addColumn("error_message", "text")
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createTable("indexed_files")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("connector_config_id", "text", (col) =>
      col.notNull().references("connector_configs.id").onDelete("cascade"),
    )
    .addColumn("provider_file_id", "text", (col) => col.notNull())
    .addColumn("provider_url", "text")
    .addColumn("file_name", "text", (col) => col.notNull())
    .addColumn("file_type", "text")
    .addColumn("content_category", "text", (col) => col.notNull())
    .addColumn("content", "text")
    .addColumn("summary", "text")
    .addColumn("tags", "text")
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("source_path", "text")
    .addColumn("content_hash", "text")
    .addColumn("is_archived", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("source_created_at", "text")
    .addColumn("source_updated_at", "text")
    .addColumn("synced_at", "text", (col) => col.notNull())
    .addColumn("indexed_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("context_note", "text")
    .addColumn("enrichment_status", "text", (col) => col.notNull().defaultTo("raw"))
    .addColumn("access_scope_id", "text")
    .addColumn("mime_type", "text")
    .addColumn("embedding_status", "text", (col) => col.defaultTo("pending"))
    .execute();
}

async function insertConnector(db: Kysely<unknown>, id: string): Promise<void> {
  await (
    db as Kysely<{
      connector_configs: {
        id: string;
        connector_type: string;
        auth_type: string;
        credentials: string;
        created_by: string;
      };
    }>
  )
    .insertInto("connector_configs")
    .values({ id, connector_type: "google_drive", auth_type: "oauth", credentials: "{}", created_by: "admin" })
    .execute();
}

async function insertIndexedFile(
  db: Kysely<unknown>,
  id: string,
  connectorId: string,
  source: string,
  providerId: string,
): Promise<void> {
  await (
    db as Kysely<{
      indexed_files: {
        id: string;
        connector_config_id: string;
        provider_file_id: string;
        file_name: string;
        content_category: string;
        source: string;
        synced_at: string;
      };
    }>
  )
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: connectorId,
      provider_file_id: providerId,
      file_name: "test-file.txt",
      content_category: "document",
      source,
      synced_at: "2024-04-01T00:00:00Z",
    })
    .execute();
}

describe("021-file-access migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await createPrerequisites(db);
    await up(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates access_scopes table and allows inserting a row", async () => {
    await insertConnector(db, "conn-001");

    type ScopeRow = {
      id: string;
      connector_config_id: string;
      scope_type: string;
      provider_scope_id: string;
      label: string | null;
    };
    await (db as Kysely<{ access_scopes: ScopeRow }>)
      .insertInto("access_scopes")
      .values({
        id: "scope-001",
        connector_config_id: "conn-001",
        scope_type: "drive",
        provider_scope_id: "drive-root-123",
        label: "My Drive",
      })
      .execute();

    const rows = await (db as Kysely<{ access_scopes: ScopeRow }>).selectFrom("access_scopes").selectAll().execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("scope-001");
    expect(rows[0].scope_type).toBe("drive");
    expect(rows[0].provider_scope_id).toBe("drive-root-123");
    expect(rows[0].label).toBe("My Drive");
  });

  it("enforces unique index on access_scopes(connector_config_id, provider_scope_id)", async () => {
    await insertConnector(db, "conn-002");

    type ScopeRow = {
      id: string;
      connector_config_id: string;
      scope_type: string;
      provider_scope_id: string;
      label: string | null;
    };
    const insertDb = db as Kysely<{ access_scopes: ScopeRow }>;

    await insertDb
      .insertInto("access_scopes")
      .values({
        id: "scope-002a",
        connector_config_id: "conn-002",
        scope_type: "folder",
        provider_scope_id: "folder-xyz",
        label: null,
      })
      .execute();

    await expect(
      insertDb
        .insertInto("access_scopes")
        .values({
          id: "scope-002b",
          connector_config_id: "conn-002",
          scope_type: "folder",
          provider_scope_id: "folder-xyz",
          label: null,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("creates access_scope_members table and allows inserting rows", async () => {
    await insertConnector(db, "conn-003");

    type ScopeRow = {
      id: string;
      connector_config_id: string;
      scope_type: string;
      provider_scope_id: string;
      label: string | null;
    };
    await (db as Kysely<{ access_scopes: ScopeRow }>)
      .insertInto("access_scopes")
      .values({
        id: "scope-003",
        connector_config_id: "conn-003",
        scope_type: "workspace",
        provider_scope_id: "ws-001",
        label: null,
      })
      .execute();

    type MemberRow = { access_scope_id: string; email: string };
    await (db as Kysely<{ access_scope_members: MemberRow }>)
      .insertInto("access_scope_members")
      .values({ access_scope_id: "scope-003", email: "alice@example.com" })
      .execute();

    await (db as Kysely<{ access_scope_members: MemberRow }>)
      .insertInto("access_scope_members")
      .values({ access_scope_id: "scope-003", email: "bob@example.com" })
      .execute();

    const rows = await (db as Kysely<{ access_scope_members: MemberRow }>)
      .selectFrom("access_scope_members")
      .selectAll()
      .execute();

    expect(rows).toHaveLength(2);
  });

  it("enforces unique index on access_scope_members(access_scope_id, email)", async () => {
    await insertConnector(db, "conn-004");

    type ScopeRow = {
      id: string;
      connector_config_id: string;
      scope_type: string;
      provider_scope_id: string;
      label: string | null;
    };
    await (db as Kysely<{ access_scopes: ScopeRow }>)
      .insertInto("access_scopes")
      .values({
        id: "scope-004",
        connector_config_id: "conn-004",
        scope_type: "drive",
        provider_scope_id: "drive-004",
        label: null,
      })
      .execute();

    type MemberRow = { access_scope_id: string; email: string };
    await (db as Kysely<{ access_scope_members: MemberRow }>)
      .insertInto("access_scope_members")
      .values({ access_scope_id: "scope-004", email: "charlie@example.com" })
      .execute();

    await expect(
      (db as Kysely<{ access_scope_members: MemberRow }>)
        .insertInto("access_scope_members")
        .values({ access_scope_id: "scope-004", email: "charlie@example.com" })
        .execute(),
    ).rejects.toThrow();
  });

  it("creates connector_files junction table and allows inserting rows", async () => {
    await insertConnector(db, "conn-005");
    await insertIndexedFile(db, "file-005", "conn-005", "google_drive", "drive-file-005");

    type JunctionRow = { connector_config_id: string; indexed_file_id: string };
    await (db as Kysely<{ connector_files: JunctionRow }>)
      .insertInto("connector_files")
      .values({ connector_config_id: "conn-005", indexed_file_id: "file-005" })
      .execute();

    const rows = await (db as Kysely<{ connector_files: JunctionRow }>)
      .selectFrom("connector_files")
      .selectAll()
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].connector_config_id).toBe("conn-005");
    expect(rows[0].indexed_file_id).toBe("file-005");
  });

  it("creates file_access table and allows inserting rows", async () => {
    await insertConnector(db, "conn-006");
    await insertIndexedFile(db, "file-006", "conn-006", "google_drive", "drive-file-006");

    type FileAccessRow = { indexed_file_id: string; email: string };
    await (db as Kysely<{ file_access: FileAccessRow }>)
      .insertInto("file_access")
      .values({ indexed_file_id: "file-006", email: "alice@example.com" })
      .execute();

    const rows = await (db as Kysely<{ file_access: FileAccessRow }>).selectFrom("file_access").selectAll().execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("alice@example.com");
  });

  it("enforces unique index on indexed_files(source, provider_file_id)", async () => {
    await insertConnector(db, "conn-007");
    await insertIndexedFile(db, "file-007a", "conn-007", "notion", "notion-page-abc");

    await expect(insertIndexedFile(db, "file-007b", "conn-007", "notion", "notion-page-abc")).rejects.toThrow();
  });

  it("down() drops all four new tables and the deduplication index", async () => {
    await down(db);

    for (const table of ["file_access", "connector_files", "access_scope_members", "access_scopes"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(0);
    }

    // The deduplication index should also be gone
    const idxResult = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='index' AND name='idx_indexed_files_source_provider'
    `.execute(db);
    expect(idxResult.rows).toHaveLength(0);
  });
});
