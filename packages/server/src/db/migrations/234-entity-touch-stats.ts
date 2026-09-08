import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("entity_contact_points").addColumn("last_replied_at", "text").execute();

  await db.schema
    .createTable("entity_touch_stats")
    .addColumn("entity_id", "text", (col) => col.primaryKey().references("entities.id").onDelete("cascade"))
    .addColumn("last_touch_at", "text")
    .addColumn("last_inbound_at", "text")
    .addColumn("last_outbound_at", "text")
    .addColumn("touch_count_30d", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("touch_count_90d", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("source_last_touch", "text", (col) => col.notNull().defaultTo("{}"))
    .addColumn("computed_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_entity_touch_stats_last_touch")
    .on("entity_touch_stats")
    .column("last_touch_at")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("entity_touch_stats").execute();
  await db.schema.alterTable("entity_contact_points").dropColumn("last_replied_at").execute();
}
