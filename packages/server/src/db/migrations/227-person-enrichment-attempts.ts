import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("person_enrichment_attempts")
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("linkedin_url", "text", (col) => col.notNull())
    .addColumn("entity_id", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_attempt_at", "text")
    .addColumn("next_eligible_at", "text")
    .addColumn("provider_version", "text", (col) => col.notNull())
    .addColumn("emails_found", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("phones_found", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("outcome", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("pk_person_enrichment_attempts", ["provider", "linkedin_url"])
    .execute();

  await db.schema
    .createIndex("idx_person_enrichment_attempts_entity_id")
    .on("person_enrichment_attempts")
    .column("entity_id")
    .execute();

  await db.schema
    .createTable("enrichment_daily_usage")
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("day", "text", (col) => col.notNull())
    .addColumn("calls", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("pk_enrichment_daily_usage", ["provider", "day"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("enrichment_daily_usage").execute();
  await db.schema.dropTable("person_enrichment_attempts").execute();
}
