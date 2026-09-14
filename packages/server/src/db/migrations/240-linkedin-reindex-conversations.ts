import { type Kysely, sql } from "kysely";

/**
 * The reindex queue. A conversation that only ever had legacy segment files has
 * no `conversation_messages` rows at all, so moving it onto the chunk engine
 * costs two Aimfox calls under a 60 rpm pacer — minutes of API time per hundred
 * threads. That work therefore lives in a durable, resumable queue rather than
 * in a request handler or a single sync run.
 *
 * `run_id` is part of the unique key so a later run can re-queue a conversation
 * an earlier one gave up on, while one run can never enqueue it twice.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("linkedin_reindex_conversations")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("run_id", "text", (col) => col.notNull())
    .addColumn("connector_config_id", "text", (col) => col.notNull())
    .addColumn("account_id", "text", (col) => col.notNull())
    .addColumn("conversation_urn", "text", (col) => col.notNull())
    .addColumn("lead_id", "text")
    .addColumn("lead_name", "text")
    .addColumn("owner_name", "text")
    .addColumn("phase", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("next_retry_at", "text")
    .addColumn("last_error", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("linkedin_reindex_conversations_run_conversation_uidx", [
      "connector_config_id",
      "account_id",
      "conversation_urn",
      "run_id",
    ])
    .addCheckConstraint(
      "linkedin_reindex_conversations_phase_check",
      sql`phase IN ('pending', 'fetched', 'complete', 'failed', 'exhausted')`,
    )
    .execute();
  await db.schema
    .createIndex("linkedin_reindex_conversations_work_idx")
    .on("linkedin_reindex_conversations")
    .columns(["phase", "next_retry_at", "created_at"])
    .execute();
  await db.schema
    .createIndex("linkedin_reindex_conversations_connector_idx")
    .on("linkedin_reindex_conversations")
    .columns(["connector_config_id", "phase"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("linkedin_reindex_conversations").execute();
}
