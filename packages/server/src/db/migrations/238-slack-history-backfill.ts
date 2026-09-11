import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

const OPEN_SLICE_INDEX = "conversation_slices_one_open_per_conversation_uidx";

async function addTextColumnIfMissing(db: Kysely<unknown>, table: string, column: string): Promise<void> {
  if (isPg(db)) {
    await sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} TEXT`).execute(db);
    return;
  }
  const columns = await sql.raw<{ name: string }>(`PRAGMA table_info(${table})`).execute(db);
  if (columns.rows.some((row) => row.name === column)) return;
  await db.schema.alterTable(table).addColumn(column, "text").execute();
}

/**
 * The open-slice uniqueness key gains `origin` so a channel can hold one live
 * open slice and one history open slice at the same time. Both dialects accept
 * the same expression index, matching migration 230's spelling.
 */
async function recreateOpenSliceIndex(db: Kysely<unknown>, withOrigin: boolean): Promise<void> {
  await sql.raw(`DROP INDEX IF EXISTS ${OPEN_SLICE_INDEX}`).execute(db);
  const columns = withOrigin
    ? "conversation_id, (COALESCE(provider_thread_id, '')), origin"
    : "conversation_id, (COALESCE(provider_thread_id, ''))";
  await sql
    .raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${OPEN_SLICE_INDEX}
      ON conversation_slices(${columns})
      WHERE status = 'open'
    `)
    .execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("conversation_slices")
    .addColumn("origin", "text", (col) => col.notNull().defaultTo("live"))
    .execute();
  await recreateOpenSliceIndex(db, true);
  await addTextColumnIfMissing(db, "conversation_slice_stream_cursors", "last_effective_at");

  await db.schema
    .createTable("slack_backfill_ranges")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("channel_id", "text", (col) => col.notNull())
    .addColumn("conversation_id", "integer", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("range_key", "text", (col) => col.notNull())
    .addColumn("lower_ts", "text", (col) => col.notNull())
    .addColumn("upper_ts", "text", (col) => col.notNull())
    .addColumn("phase", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("history_cursor", "text")
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("next_retry_at", "text")
    .addColumn("last_error", "text")
    .addColumn("messages_fetched", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("graph_cursor_effective_at", "text")
    .addColumn("graph_cursor_id", "integer")
    .addColumn("graph_completed_at", "text")
    .addColumn("graph_halted_at", "text")
    .addColumn("graph_last_served_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("slack_backfill_ranges_channel_range_key_uidx", ["channel_id", "range_key"])
    .addCheckConstraint("slack_backfill_ranges_kind_check", sql`kind IN ('initial', 'gap', 'manual')`)
    .addCheckConstraint(
      "slack_backfill_ranges_phase_check",
      sql`phase IN ('pending', 'fetching_history', 'fetching_threads', 'fetched', 'complete', 'failed', 'exhausted')`,
    )
    .execute();
  await db.schema
    .createIndex("slack_backfill_ranges_work_idx")
    .on("slack_backfill_ranges")
    .columns(["phase", "next_retry_at", "created_at"])
    .execute();
  await db.schema
    .createIndex("slack_backfill_ranges_graph_idx")
    .on("slack_backfill_ranges")
    .columns(["phase", "graph_completed_at", "graph_halted_at"])
    .execute();

  await db.schema
    .createTable("slack_backfill_threads")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("range_id", "text", (col) => col.notNull())
    .addColumn("thread_ts", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("reply_cursor", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("slack_backfill_threads_range_thread_uidx", ["range_id", "thread_ts"])
    .addCheckConstraint("slack_backfill_threads_status_check", sql`status IN ('pending', 'done')`)
    .execute();
  await db.schema
    .createIndex("slack_backfill_threads_work_idx")
    .on("slack_backfill_threads")
    .columns(["range_id", "status"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("slack_backfill_threads").execute();
  await db.schema.dropTable("slack_backfill_ranges").execute();
  await sql`DELETE FROM conversation_slices WHERE origin = 'history'`.execute(db);
  await recreateOpenSliceIndex(db, false);
  await db.schema.alterTable("conversation_slices").dropColumn("origin").execute();
  await db.schema.alterTable("conversation_slice_stream_cursors").dropColumn("last_effective_at").execute();
}
