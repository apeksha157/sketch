import { type Kysely, sql } from "kysely";

export async function up<Database>(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("benchmark_environment")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("user_id", "text", (c) => c.references("users.id").onDelete("set null"))
    .addColumn("revision", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("bindings_json", "text", (c) => c.notNull().defaultTo("{}"))
    .execute();
  await db.schema
    .createTable("benchmark_cases")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("revision", "integer", (c) => c.notNull())
    .addColumn("document_json", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("benchmark_designs")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("revision", "integer", (c) => c.notNull())
    .addColumn("document_json", "text", (c) => c.notNull())
    .addColumn("lease_id", "text")
    .addColumn("lease_expires_at", "text")
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("benchmark_contexts")
    .addColumn("conversation_id", "text", (c) => c.primaryKey())
    .addColumn("run_id", "text", (c) => c.notNull().references("benchmark_runs.id").onDelete("cascade"))
    .addColumn("task_id", "text")
    .addColumn("binding_json", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("benchmark_contexts_task").on("benchmark_contexts").column("task_id").execute();
  await db.schema.createIndex("benchmark_runs_created").on("benchmark_runs").columns(["created_at", "id"]).execute();
  await sql`INSERT INTO benchmark_environment (id, revision, bindings_json) VALUES ('shared', 0, '{}')`.execute(db);
}

export async function down<Database>(db: Kysely<Database>): Promise<void> {
  await db.schema.dropIndex("benchmark_runs_created").execute();
  await db.schema.dropTable("benchmark_contexts").execute();
  await db.schema.dropTable("benchmark_designs").execute();
  await db.schema.dropTable("benchmark_cases").execute();
  await db.schema.dropTable("benchmark_environment").execute();
}
