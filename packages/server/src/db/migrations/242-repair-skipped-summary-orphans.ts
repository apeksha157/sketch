import { type Kysely, sql } from "kysely";

/**
 * Repairs files whose embedding was skipped for having no content but whose
 * summary was left at its `pending` default.
 *
 * Nothing could ever move these forward — every summary path in the enrichment
 * worker requires a finished embedding, and the manual rerun refuses to claim a
 * skipped file — yet backfill admission counted them as pipeline backpressure.
 * On one tenant 1,571 such rows (videos, JARs, Drive shortcuts) held Slack
 * history indexing shut indefinitely.
 *
 * The enrichment worker now sets both statuses together, so this only clears
 * the rows written before that fix.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE indexed_files
       SET summary_status = 'skipped',
           summary_attempts = 0,
           summary_next_retry_at = NULL
     WHERE embedding_status = 'skipped'
       AND summary_status = 'pending'
  `.execute(db);
}

/**
 * No-op by design: a repaired row is indistinguishable from one the worker
 * skipped naturally, so reverting would have to guess which rows to reopen.
 */
export async function down(): Promise<void> {}
