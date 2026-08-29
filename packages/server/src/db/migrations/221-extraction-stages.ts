import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("extraction_stages")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("content_hash", "text")
    .addColumn("extractor_version", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("staged_json", "text", (col) => col.notNull())
    .addColumn("model", "text")
    .addColumn("rounds", "integer")
    .addColumn("tool_calls", "integer")
    .addColumn("input_tokens", "integer")
    .addColumn("output_tokens", "integer")
    .addColumn("cost_usd", "real")
    .addColumn("duration_ms", "integer")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_extraction_stages_indexed_file_id")
    .on("extraction_stages")
    .column("indexed_file_id")
    .execute();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_extraction_stages_file_hash_version
    ON extraction_stages(indexed_file_id, content_hash, extractor_version)
    WHERE content_hash IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("extraction_stages").execute();
}
