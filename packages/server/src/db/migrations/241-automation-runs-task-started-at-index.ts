import { type Kysely, sql } from "kysely";

const TASK_STARTED_INDEX = "idx_automation_runs_task_started";

/**
 * Serves "newest run per task" lookups, which every automation list, workflow
 * list and workflow detail request performs for all of the tenant's tasks.
 *
 * `automation_runs` only carried a `task_id` index, so the grouped aggregate
 * behind those summaries read each task's whole run history (and, before the
 * query was rewritten, read it once per row). Run history has no retention cap
 * — a single recurring automation reached 22k rows here — so the index keeps
 * the summary cost flat as that history grows instead of tracking it.
 *
 * Existing indexes: automation_runs_pkey (id), idx_automation_runs_status
 * (status), idx_automation_runs_task_id (task_id). This one supersedes the
 * single-column `task_id` index for ordering/range work without replacing it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS ${sql.id(TASK_STARTED_INDEX)} ON automation_runs (task_id, started_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS ${sql.id(TASK_STARTED_INDEX)}`.execute(db);
}
