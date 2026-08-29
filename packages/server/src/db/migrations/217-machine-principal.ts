import { type Kysely, sql } from "kysely";

interface MachinePrincipalMigrationDb {
  users: {
    id: string;
    name: string;
    email: string | null;
    auth_role: string;
    type: string;
  };
}

const MACHINE_PRINCIPAL_USER_ID = "sketch-machine";

export async function up(rawDb: Kysely<unknown>): Promise<void> {
  const db = rawDb as Kysely<MachinePrincipalMigrationDb>;
  await db
    .insertInto("users")
    .values({
      id: MACHINE_PRINCIPAL_USER_ID,
      name: "Sketch Machine",
      email: null,
      auth_role: "member",
      type: "agent",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();

  await rawDb.schema
    .createTable("llm_usage_events")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("context", "text", (col) => col.notNull())
    .addColumn("indexed_file_id", "text", (col) => col.references("indexed_files.id").onDelete("set null"))
    .addColumn("model", "text", (col) => col.notNull())
    .addColumn("outcome", "text", (col) => col.notNull())
    .addColumn("prompt_tokens", "integer")
    .addColumn("completion_tokens", "integer")
    .addColumn("duration_ms", "integer", (col) => col.notNull())
    .addColumn("cost_usd", "real")
    .execute();

  await rawDb.schema
    .createIndex("idx_llm_usage_events_indexed_file_id")
    .on("llm_usage_events")
    .column("indexed_file_id")
    .execute();
  await rawDb.schema
    .createIndex("idx_llm_usage_events_created_at")
    .on("llm_usage_events")
    .column("created_at")
    .execute();
}

export async function down(rawDb: Kysely<unknown>): Promise<void> {
  const db = rawDb as Kysely<MachinePrincipalMigrationDb>;
  await rawDb.schema.dropTable("llm_usage_events").execute();
  await db.deleteFrom("users").where("id", "=", MACHINE_PRINCIPAL_USER_ID).execute();
}
