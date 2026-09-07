import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("benchmark_enrollments")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
    .addColumn("account_id", "text", (c) => c.notNull())
    .addColumn("config_json", "text", (c) => c.notNull())
    .addColumn("active_run_id", "text")
    .addColumn("created_at", "text", (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("benchmark_enrollment_owner_account", ["user_id", "account_id"])
    .execute();
  await db.schema
    .createTable("benchmark_setup_links")
    .addColumn("token_hash", "text", (c) => c.primaryKey())
    .addColumn("expires_at", "text", (c) => c.notNull())
    .addColumn("used_at", "text")
    .execute();
  await db.schema
    .createTable("benchmark_runs")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("enrollment_id", "text", (c) => c.notNull().references("benchmark_enrollments.id"))
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("document_json", "text", (c) => c.notNull())
    .addColumn("worker_id", "text")
    .addColumn("cancel_requested", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("heartbeat_at", "text")
    .addColumn("created_at", "text", (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("benchmark_runs_enrollment_created")
    .on("benchmark_runs")
    .columns(["enrollment_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("benchmark_runs").execute();
  await db.schema.dropTable("benchmark_setup_links").execute();
  await db.schema.dropTable("benchmark_enrollments").execute();
}
