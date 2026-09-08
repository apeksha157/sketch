import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("crm_field_history")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .addColumn("field", "text", (col) => col.notNull())
    .addColumn("old_value", "text")
    .addColumn("new_value", "text", (col) => col.notNull())
    .addColumn("observed_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("source_modified_at", "text")
    .execute();

  await db.schema
    .createIndex("idx_crm_field_history_file_observed")
    .on("crm_field_history")
    .columns(["indexed_file_id", "observed_at"])
    .execute();

  await db.schema
    .createIndex("idx_crm_field_history_entity_observed")
    .on("crm_field_history")
    .columns(["entity_id", "observed_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("crm_field_history").execute();
}
