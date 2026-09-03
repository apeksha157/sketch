import { type Kysely, sql } from "kysely";

/**
 * Raw retrieval-only payloads (e.g. full meeting transcripts) stored apart from
 * indexed_files.content so they never feed content_hash, chunking, embeddings,
 * or enrichment. Composite key (indexed_file_id, kind) leaves room for other
 * raw kinds per file later.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("indexed_file_raw_contents")
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("char_length", "integer", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("indexed_file_raw_contents_pk", ["indexed_file_id", "kind"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("indexed_file_raw_contents").execute();
}
