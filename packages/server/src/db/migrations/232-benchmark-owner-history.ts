import { type Kysely, sql } from "kysely";
import { createBenchmarkHistoryTables } from "./231-benchmarks";

/** Rebuild both related tables inside the migration transaction on SQLite and Postgres. */
async function rebuildHistory<Database>(db: Kysely<Database>, retainDeletedOwners: boolean): Promise<void> {
  if (!db.isTransaction) return db.transaction().execute((trx) => rebuildHistory<Database>(trx, retainDeletedOwners));
  await sql`CREATE TABLE benchmark_enrollments_backup AS SELECT * FROM benchmark_enrollments`.execute(db);
  await sql`CREATE TABLE benchmark_runs_backup AS SELECT * FROM benchmark_runs`.execute(db);
  await db.schema.dropTable("benchmark_runs").execute();
  await db.schema.dropTable("benchmark_enrollments").execute();
  await createBenchmarkHistoryTables<Database>(db, retainDeletedOwners);
  await sql`INSERT INTO benchmark_enrollments SELECT * FROM benchmark_enrollments_backup`.execute(db);
  await sql`INSERT INTO benchmark_runs SELECT * FROM benchmark_runs_backup`.execute(db);
  await db.schema.dropTable("benchmark_runs_backup").execute();
  await db.schema.dropTable("benchmark_enrollments_backup").execute();
}

export async function up<Database>(db: Kysely<Database>): Promise<void> {
  await rebuildHistory<Database>(db, true);
}

export async function down<Database>(db: Kysely<Database>): Promise<void> {
  const deleted = await sql`SELECT id FROM benchmark_enrollments WHERE user_id IS NULL LIMIT 1`.execute(db);
  if (deleted.rows.length)
    throw new Error("Cannot restore required benchmark owners while deleted-owner audit history exists.");
  await rebuildHistory<Database>(db, false);
}
