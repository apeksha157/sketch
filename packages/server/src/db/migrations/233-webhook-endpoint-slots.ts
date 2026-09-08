import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

/** SQLite requires rebuilding the inline unique constraint; back up children before dropping their parent. */
async function rebuildSqlite(db: Kysely<unknown>, multiple: boolean): Promise<void> {
  await sql`CREATE TABLE webhook_deliveries_slot_backup AS SELECT * FROM webhook_deliveries`.execute(db);
  await db.schema.dropTable("webhook_deliveries").execute();
  let table = db.schema
    .createTable("webhook_endpoints_slot_replacement")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("task_id", "text", (c) => c.notNull().references("scheduled_tasks.id").onDelete("cascade"))
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("generation", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_at", "text", (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("verification_json", "text")
    .addColumn("signing_secret_encrypted", "text")
    .addColumn("source_binding", "text");
  table = multiple
    ? table
        .addColumn("slot", "text", (c) => c.notNull().defaultTo("default"))
        .addUniqueConstraint("webhook_endpoints_task_slot", ["task_id", "slot"])
    : table.addUniqueConstraint("webhook_endpoints_task_id_key", ["task_id"]);
  await table.execute();
  await sql`INSERT INTO webhook_endpoints_slot_replacement (id, task_id, status, generation, created_at, updated_at, verification_json, signing_secret_encrypted, source_binding)
    SELECT id, task_id, status, generation, created_at, updated_at, verification_json, signing_secret_encrypted, source_binding FROM webhook_endpoints`.execute(
    db,
  );
  await db.schema.dropTable("webhook_endpoints").execute();
  await db.schema.alterTable("webhook_endpoints_slot_replacement").renameTo("webhook_endpoints").execute();
  await db.schema.createIndex("webhook_endpoints_status").on("webhook_endpoints").column("status").execute();
  await db.schema
    .createTable("webhook_deliveries")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("endpoint_id", "text", (c) => c.notNull().references("webhook_endpoints.id").onDelete("cascade"))
    .addColumn("task_id", "text", (c) => c.notNull().references("scheduled_tasks.id").onDelete("cascade"))
    .addColumn("event_id", "text", (c) => c.notNull())
    .addColumn("payload_hash", "text", (c) => c.notNull())
    .addColumn("trigger_data", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("run_id", "text")
    .addColumn("attempt_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("claimed_at", "text")
    .addColumn("created_at", "text", (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("completed_at", "text")
    .addColumn("error_message", "text")
    .addColumn("task_revision", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("endpoint_generation", "integer", (c) => c.notNull().defaultTo(1))
    .addUniqueConstraint("webhook_deliveries_endpoint_event", ["endpoint_id", "event_id"])
    .execute();
  await sql`INSERT INTO webhook_deliveries SELECT * FROM webhook_deliveries_slot_backup`.execute(db);
  await db.schema.dropTable("webhook_deliveries_slot_backup").execute();
  await db.schema
    .createIndex("webhook_deliveries_task_status")
    .on("webhook_deliveries")
    .columns(["task_id", "status"])
    .execute();
  await db.schema
    .createIndex("webhook_deliveries_endpoint_time")
    .on("webhook_deliveries")
    .columns(["endpoint_id", "created_at"])
    .execute();
  await db.schema
    .createIndex("webhook_deliveries_recovery")
    .on("webhook_deliveries")
    .columns(["status", "claimed_at"])
    .execute();
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!isPg(db)) return rebuildSqlite(db, true);
  await db.schema
    .alterTable("webhook_endpoints")
    .addColumn("slot", "text", (c) => c.notNull().defaultTo("default"))
    .execute();
  await db.schema.alterTable("webhook_endpoints").dropConstraint("webhook_endpoints_task_id_key").execute();
  await db.schema
    .alterTable("webhook_endpoints")
    .addUniqueConstraint("webhook_endpoints_task_slot", ["task_id", "slot"])
    .execute();
}

/** Older runtimes cannot inspect or clean up secondary subscriptions safely. */
export async function down(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{
    count: number | string;
  }>`SELECT COUNT(*) as count FROM webhook_endpoints WHERE slot <> 'default'`.execute(db);
  if (Number(result.rows[0]?.count ?? 0) > 0)
    throw new Error("Remove additional endpoint slots and their remote registrations before downgrading");
  if (!isPg(db)) return rebuildSqlite(db, false);
  await db.schema.alterTable("webhook_endpoints").dropConstraint("webhook_endpoints_task_slot").execute();
  await db.schema.alterTable("webhook_endpoints").dropColumn("slot").execute();
  await db.schema
    .alterTable("webhook_endpoints")
    .addUniqueConstraint("webhook_endpoints_task_id_key", ["task_id"])
    .execute();
}
