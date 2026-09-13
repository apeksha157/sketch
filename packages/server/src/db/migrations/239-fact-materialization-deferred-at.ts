import { type Kysely, sql } from "kysely";

const OPEN_UNSWEPT_INDEX = "idx_indexed_file_facts_open_unswept";

/**
 * Records when a sweep parked a fact, so backfill admission pressure can count
 * only the open facts no sweep has seen yet.
 *
 * Materialization legitimately parks facts forever — an entity collision waits
 * on human review, and an LLM mention below the promotion threshold waits on a
 * second sighting. Neither increments the attempt counter, so both sat in the
 * open-fact count permanently and pinned history backfill shut on any tenant
 * that had accumulated them.
 *
 * The sweep itself must never filter on this column: it re-evaluates parked
 * facts every pass, which is the only way a below-threshold mention is ever
 * promoted. The index below therefore serves the admission count alone and
 * carries no paging columns; the sweep keeps using
 * idx_indexed_file_facts_open_materializable from migration 142.
 *
 * The literal 5 mirrors MAX_MATERIALIZATION_ATTEMPTS (materialize-replay.ts) at
 * migration time and stays frozen even if that constant changes, exactly as in
 * migration 142; a future cap change needs a new migration that rebuilds both.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("indexed_file_facts").addColumn("materialization_deferred_at", "text").execute();

  await db.schema
    .createIndex(OPEN_UNSWEPT_INDEX)
    .on("indexed_file_facts")
    .columns(["id"])
    .where(sql.ref("deleted_at"), "is", null)
    .where(sql.ref("materialized_at"), "is", null)
    .where(sql.ref("materialization_attempts"), "<", 5)
    .where(sql.ref("materialization_deferred_at"), "is", null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex(OPEN_UNSWEPT_INDEX).ifExists().execute();
  await db.schema.alterTable("indexed_file_facts").dropColumn("materialization_deferred_at").execute();
}
