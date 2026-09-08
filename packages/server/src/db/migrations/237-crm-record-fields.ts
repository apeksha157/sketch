import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("crm_record_fields")
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("field", "text", (col) => col.notNull())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("value_norm", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("crm_record_fields_pkey", ["indexed_file_id", "field", "value_norm"])
    .execute();

  await db.schema
    .createIndex("idx_crm_record_fields_lookup")
    .on("crm_record_fields")
    .columns(["field", "value_norm"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("crm_record_fields").execute();
}
