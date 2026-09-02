import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("resolution_decisions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("normalized_mention_name", "text", (col) => col.notNull())
    .addColumn("entity_type", "text", (col) => col.notNull())
    .addColumn("scope", "text", (col) => col.notNull().defaultTo("global"))
    .addColumn("verdict", "text", (col) => col.notNull())
    .addColumn("target_entity_id", "text")
    .addColumn("target_name", "text")
    .addColumn("target_email", "text")
    .addColumn("decider", "text", (col) => col.notNull())
    .addColumn("decided_by", "text", (col) => col.notNull())
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("source_id", "text", (col) => col.notNull())
    .addColumn("evidence_file_ids", "text", (col) => col.notNull().defaultTo("[]"))
    .addColumn("verdict_ref", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  /**
   * Two disjoint partial unique indexes instead of one full unique constraint:
   * a full unique spanning verdict+target would also match link-row upserts,
   * and Postgres raises on any violated non-arbiter unique even when the
   * ON CONFLICT arbiter matches the same row. Partial predicates use inline
   * literals because parameters are not allowed in index DDL.
   */
  await db.schema
    .createIndex("idx_resolution_decisions_link_unique")
    .on("resolution_decisions")
    .columns(["normalized_mention_name", "entity_type", "scope"])
    .unique()
    .where(sql<boolean>`verdict = 'link'`)
    .execute();

  await db.schema
    .createIndex("idx_resolution_decisions_distinct_unique")
    .on("resolution_decisions")
    .columns(["normalized_mention_name", "entity_type", "scope", "target_entity_id"])
    .unique()
    .where(sql<boolean>`verdict = 'distinct'`)
    .execute();

  await db.schema
    .createIndex("idx_resolution_decisions_target_entity_id")
    .on("resolution_decisions")
    .column("target_entity_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("resolution_decisions").execute();
}
