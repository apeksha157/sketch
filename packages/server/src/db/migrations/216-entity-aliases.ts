import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("entity_aliases")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("cascade"))
    .addColumn("alias", "text", (col) => col.notNull())
    .addColumn("normalized_alias", "text", (col) => col.notNull())
    .addColumn("provenance", "text", (col) => col.notNull())
    .addColumn("created_by", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("entity_aliases_entity_normalized_unique", ["entity_id", "normalized_alias"])
    .execute();

  await db.schema.createIndex("idx_entity_aliases_entity_id").on("entity_aliases").column("entity_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("entity_aliases").execute();
}
