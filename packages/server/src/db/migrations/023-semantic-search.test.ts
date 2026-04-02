/**
 * Tests for the 023-semantic-search migration.
 *
 * Uses a fresh blank in-memory SQLite database. Prerequisites created manually:
 * - connector_configs and indexed_files (from 019) — document_chunks and
 *   document_timeframes both FK reference indexed_files.id.
 *
 * Tests verify that both tables are created with correct columns, that unique/regular
 * indexes work, and that down() reverses the migration.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./023-semantic-search";

type DocumentChunkRow = {
  id: string;
  indexed_file_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
};

type DocumentTimeframeRow = {
  id: string;
  indexed_file_id: string;
  start_date: string;
  end_date: string | null;
  context: string | null;
};

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
    .addColumn("file_name", "text", (col) => col.notNull())
    .addColumn("content_category", "text", (col) => col.notNull())
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("synced_at", "text", (col) => col.notNull())
    .addColumn("indexed_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("enrichment_status", "text", (col) => col.notNull().defaultTo("raw"))
    .addColumn("is_archived", "integer", (col) => col.notNull().defaultTo(0))
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

async function insertIndexedFile(db: Kysely<unknown>, id: string, connectorId: string): Promise<void> {
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
      provider_file_id: `provider-${id}`,
      file_name: "test.txt",
      content_category: "document",
      source: "google_drive",
      synced_at: "2024-04-01T00:00:00Z",
    })
    .execute();
}

describe("023-semantic-search migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await createPrerequisites(db);
    await up(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates document_chunks table and allows inserting rows", async () => {
    await insertConnector(db, "conn-001");
    await insertIndexedFile(db, "file-001", "conn-001");

    await (db as Kysely<{ document_chunks: DocumentChunkRow }>)
      .insertInto("document_chunks")
      .values({
        id: "chunk-001",
        indexed_file_id: "file-001",
        chunk_index: 0,
        content: "This is the first chunk of the document with substantial text.",
        token_count: 12,
      })
      .execute();

    await (db as Kysely<{ document_chunks: DocumentChunkRow }>)
      .insertInto("document_chunks")
      .values({
        id: "chunk-002",
        indexed_file_id: "file-001",
        chunk_index: 1,
        content: "This is the second chunk continuing the document.",
        token_count: 9,
      })
      .execute();

    const rows = await (db as Kysely<{ document_chunks: DocumentChunkRow }>)
      .selectFrom("document_chunks")
      .selectAll()
      .execute();

    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("chunk-001");
    expect(rows[0].chunk_index).toBe(0);
    expect(rows[0].token_count).toBe(12);
    expect(rows[1].chunk_index).toBe(1);
  });

  it("token_count defaults to null when not provided", async () => {
    await insertConnector(db, "conn-002");
    await insertIndexedFile(db, "file-002", "conn-002");

    await (db as Kysely<{ document_chunks: Omit<DocumentChunkRow, "token_count"> }>)
      .insertInto("document_chunks")
      .values({
        id: "chunk-003",
        indexed_file_id: "file-002",
        chunk_index: 0,
        content: "Chunk without token count.",
      })
      .execute();

    const rows = await (db as Kysely<{ document_chunks: DocumentChunkRow }>)
      .selectFrom("document_chunks")
      .selectAll()
      .execute();

    expect(rows[0].token_count).toBeNull();
  });

  it("enforces unique index on document_chunks(indexed_file_id, chunk_index)", async () => {
    await insertConnector(db, "conn-003");
    await insertIndexedFile(db, "file-003", "conn-003");

    await (db as Kysely<{ document_chunks: DocumentChunkRow }>)
      .insertInto("document_chunks")
      .values({ id: "chunk-004a", indexed_file_id: "file-003", chunk_index: 0, content: "First", token_count: null })
      .execute();

    await expect(
      (db as Kysely<{ document_chunks: DocumentChunkRow }>)
        .insertInto("document_chunks")
        .values({
          id: "chunk-004b",
          indexed_file_id: "file-003",
          chunk_index: 0,
          content: "Duplicate index",
          token_count: null,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("creates document_timeframes table and allows inserting rows", async () => {
    await insertConnector(db, "conn-004");
    await insertIndexedFile(db, "file-004", "conn-004");

    await (db as Kysely<{ document_timeframes: DocumentTimeframeRow }>)
      .insertInto("document_timeframes")
      .values({
        id: "tf-001",
        indexed_file_id: "file-004",
        start_date: "2024-01-01",
        end_date: "2024-03-31",
        context: "Q1 2024 planning document",
      })
      .execute();

    const rows = await (db as Kysely<{ document_timeframes: DocumentTimeframeRow }>)
      .selectFrom("document_timeframes")
      .selectAll()
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("tf-001");
    expect(rows[0].start_date).toBe("2024-01-01");
    expect(rows[0].end_date).toBe("2024-03-31");
    expect(rows[0].context).toBe("Q1 2024 planning document");
  });

  it("end_date and context default to null when not provided", async () => {
    await insertConnector(db, "conn-005");
    await insertIndexedFile(db, "file-005", "conn-005");

    await (db as Kysely<{ document_timeframes: Omit<DocumentTimeframeRow, "end_date" | "context"> }>)
      .insertInto("document_timeframes")
      .values({
        id: "tf-002",
        indexed_file_id: "file-005",
        start_date: "2024-06-01",
      })
      .execute();

    const rows = await (db as Kysely<{ document_timeframes: DocumentTimeframeRow }>)
      .selectFrom("document_timeframes")
      .selectAll()
      .execute();

    expect(rows[0].end_date).toBeNull();
    expect(rows[0].context).toBeNull();
  });

  it("allows multiple timeframes per file", async () => {
    await insertConnector(db, "conn-006");
    await insertIndexedFile(db, "file-006", "conn-006");

    const insertDb = db as Kysely<{ document_timeframes: DocumentTimeframeRow }>;

    await insertDb
      .insertInto("document_timeframes")
      .values({
        id: "tf-003",
        indexed_file_id: "file-006",
        start_date: "2024-01-01",
        end_date: "2024-03-31",
        context: "Q1",
      })
      .execute();

    await insertDb
      .insertInto("document_timeframes")
      .values({
        id: "tf-004",
        indexed_file_id: "file-006",
        start_date: "2024-04-01",
        end_date: "2024-06-30",
        context: "Q2",
      })
      .execute();

    const rows = await insertDb.selectFrom("document_timeframes").selectAll().execute();
    expect(rows).toHaveLength(2);
  });

  it("down() drops document_timeframes and document_chunks tables", async () => {
    await down(db);

    for (const table of ["document_timeframes", "document_chunks"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(0);
    }
  });
});
