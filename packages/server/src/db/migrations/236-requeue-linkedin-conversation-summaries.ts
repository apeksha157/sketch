import { type Kysely, sql } from "kysely";

/**
 * LinkedIn conversation segments used to fall under the 100-word summary floor and were marked
 * skipped; the floor is now 1 for that file type, but the enrichment queue never re-selects a
 * skipped row, so the existing rows are put back to pending here.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE indexed_files
    SET summary_status = 'pending', summary_attempts = 0, summary_next_retry_at = NULL
    WHERE file_type = 'linkedin_conversation' AND summary_status = 'skipped' AND is_archived = 0
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
