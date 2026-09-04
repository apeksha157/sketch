import { type Kysely, sql } from "kysely";

/**
 * PR 3.1c — resolver pass run ledger.
 *
 * The weekly_mint_runs shape (migration 206): a UNIQUE run_key is what stops
 * two processes starting the same day's pass — the onConflict().doNothing()
 * claim happens before any work. lease_token + heartbeat_at only govern
 * takeover of a dead run. Counter columns are the headline digest; the full
 * per-step detail lands in summary_json and becomes the 3.1d digest row.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("resolver_runs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("run_key", "text", (col) => col.notNull())
    .addColumn("lease_token", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("heartbeat_at", "text")
    .addColumn("sweep_linked", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("drain_filed", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("aged_retired", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("approved_auto", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("applied", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("bounced_drift", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("summary_json", "text")
    .addColumn("error", "text")
    .addColumn("started_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("completed_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("resolver_runs_key_unique", ["run_key"])
    .execute();

  await sql`CREATE INDEX IF NOT EXISTS idx_resolver_runs_status_heartbeat
    ON resolver_runs(status, heartbeat_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("resolver_runs").ifExists().execute();
}
