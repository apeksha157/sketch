import { type Kysely, sql } from "kysely";

/**
 * PR 3.1a — verdict lifecycle columns + widened active-uniqueness predicates.
 *
 * Adds the adjudicator's machine states (pending_corroboration, veto_window,
 * retired) to the active set of every partial unique index, introduces the
 * unordered merge-pair identity (merge_pair_key, app-computed, "|"-joined
 * sorted entity ids — never NUL: Postgres text cannot hold zero bytes), and
 * excludes merge_into from the subject+action pair index so competing merge
 * targets (A→B, A→C) can coexist while the same pair (A→B, B→A) cannot.
 *
 * Status literals are inlined rather than imported: migrations are frozen
 * history and must not drift when application constants change.
 */

const OLD_ACTIVE = `('awaiting_human', 'approved')`;
const NEW_ACTIVE = `('awaiting_human', 'approved', 'pending_corroboration', 'veto_window')`;

async function dropActiveIndexes(db: Kysely<unknown>) {
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_merge_pair`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_mention`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_container`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_pair`.execute(db);
}

async function createActiveIndexes(db: Kysely<unknown>, activeSet: string, excludeMergeFromPair: boolean) {
  const mergeExclusion = excludeMergeFromPair ? sql.raw(`AND action != 'merge_into'`) : sql.raw("");
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_pair
    ON graph_verdicts(subject_entity_id, action)
    WHERE status IN ${sql.raw(activeSet)} AND superseded_at IS NULL ${mergeExclusion}`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_container
    ON graph_verdicts(subject_container_id, action)
    WHERE status IN ${sql.raw(activeSet)}
      AND superseded_at IS NULL
      AND subject_container_id IS NOT NULL`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_mention
    ON graph_verdicts(subject_mention_name, subject_entity_type, action)
    WHERE status IN ${sql.raw(activeSet)}
      AND superseded_at IS NULL
      AND subject_mention_name IS NOT NULL`.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("graph_verdicts").addColumn("veto_until", "text").execute();
  await db.schema.alterTable("graph_verdicts").addColumn("corroboration_json", "text").execute();
  await db.schema.alterTable("graph_verdicts").addColumn("retired_reason", "text").execute();
  await db.schema
    .alterTable("graph_verdicts")
    .addColumn("dry_streak", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable("graph_verdicts").addColumn("merge_pair_key", "text").execute();

  await sql`UPDATE graph_verdicts
    SET merge_pair_key = CASE
      WHEN subject_entity_id < target_entity_id THEN subject_entity_id || '|' || target_entity_id
      ELSE target_entity_id || '|' || subject_entity_id
    END
    WHERE action = 'merge_into'
      AND subject_entity_id IS NOT NULL
      AND target_entity_id IS NOT NULL`.execute(db);

  /**
   * The old pair index keyed merges by (subject, action), so opposite
   * directions of one pair (A→B and B→A) could both be active. The pair-key
   * index would refuse to build over such rows; supersede all but the newest
   * per pair before creating it.
   */
  const now = new Date().toISOString();
  await sql`UPDATE graph_verdicts
    SET superseded_at = ${now}, updated_at = ${now}
    WHERE action = 'merge_into'
      AND superseded_at IS NULL
      AND status IN ${sql.raw(OLD_ACTIVE)}
      AND merge_pair_key IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM graph_verdicts newer
        WHERE newer.merge_pair_key = graph_verdicts.merge_pair_key
          AND newer.id != graph_verdicts.id
          AND newer.action = 'merge_into'
          AND newer.superseded_at IS NULL
          AND newer.status IN ${sql.raw(OLD_ACTIVE)}
          AND (newer.created_at > graph_verdicts.created_at
            OR (newer.created_at = graph_verdicts.created_at AND newer.id > graph_verdicts.id))
      )`.execute(db);

  await dropActiveIndexes(db);
  await createActiveIndexes(db, NEW_ACTIVE, true);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_merge_pair
    ON graph_verdicts(merge_pair_key)
    WHERE status IN ${sql.raw(NEW_ACTIVE)}
      AND superseded_at IS NULL
      AND action = 'merge_into'
      AND merge_pair_key IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const now = new Date().toISOString();
  await sql`UPDATE graph_verdicts
    SET status = 'awaiting_human', updated_at = ${now}
    WHERE status IN ('pending_corroboration', 'veto_window')`.execute(db);
  await sql`UPDATE graph_verdicts
    SET status = 'rejected', updated_at = ${now}
    WHERE status = 'retired'`.execute(db);

  await dropActiveIndexes(db);
  await createActiveIndexes(db, OLD_ACTIVE, false);

  await db.schema.alterTable("graph_verdicts").dropColumn("merge_pair_key").execute();
  await db.schema.alterTable("graph_verdicts").dropColumn("dry_streak").execute();
  await db.schema.alterTable("graph_verdicts").dropColumn("retired_reason").execute();
  await db.schema.alterTable("graph_verdicts").dropColumn("corroboration_json").execute();
  await db.schema.alterTable("graph_verdicts").dropColumn("veto_until").execute();
}
