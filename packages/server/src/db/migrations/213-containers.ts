import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("containers")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("connector_config_id", "text", (col) =>
      col.notNull().references("connector_configs.id").onDelete("cascade"),
    )
    .addColumn("connector_type", "text", (col) => col.notNull())
    .addColumn("external_id", "text", (col) => col.notNull())
    .addColumn("level_key", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("path_ids", "text", (col) => col.notNull())
    .addColumn("path_names", "text", (col) => col.notNull())
    .addColumn("parent_container_id", "text", (col) => col.references("containers.id").onDelete("set null"))
    .addColumn("item_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("first_item_at", "text")
    .addColumn("last_item_at", "text")
    .addColumn("provider_archived", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("provider_typed_kind", "text")
    .addColumn("has_dates", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("discovered_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("last_seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("classification", "text")
    .addColumn("classification_status", "text")
    .addColumn("classified_entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .addColumn("verdict_id", "text", (col) => col.references("graph_verdicts.id").onDelete("set null"))
    .addColumn("last_reviewed_fingerprint", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("containers_connector_external_unique", ["connector_config_id", "external_id"])
    .execute();

  await db.schema.createIndex("idx_containers_connector").on("containers").column("connector_config_id").execute();
  await db.schema.createIndex("idx_containers_parent").on("containers").column("parent_container_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_containers_parent").execute();
  await db.schema.dropIndex("idx_containers_connector").execute();
  await db.schema.dropTable("containers").execute();
}
