import { type Kysely, sql } from "kysely";

/**
 * Membership suppressions are connection-scoped, not stored inside
 * connector_configs.scope_config. That follows the migration-168 WhatsApp
 * groupJids authority precedent: operational inclusion/exclusion state belongs
 * in authoritative tables, while scope_config stays connector configuration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("membership_suppressions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("connector_config_id", "text", (col) =>
      col.notNull().references("connector_configs.id").onDelete("cascade"),
    )
    .addColumn("suppressed_email", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_membership_suppressions_unique")
    .on("membership_suppressions")
    .columns(["connector_config_id", "suppressed_email"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("membership_suppressions").execute();
}
