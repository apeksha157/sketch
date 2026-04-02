/**
 * Creates the outreach_messages table for tracking agent-initiated outreach between users.
 *
 * Stores the full lifecycle of a DM-based outreach: who asked (requester_user_id), who was asked
 * (recipient_user_id), the question and optional task context, the eventual response, and delivery
 * coordinates for both sides (so we know where to send the DM and where to relay the answer back).
 *
 * Two indexes support the two main read patterns: pending outreach TO a user (checked before every
 * agent run to inject pending questions into context) and outreach FROM a user (shown to the
 * requester while awaiting responses).
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("outreach_messages")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("requester_user_id", "text", (col) => col.notNull().references("users.id"))
    .addColumn("recipient_user_id", "text", (col) => col.notNull().references("users.id"))
    .addColumn("message", "text", (col) => col.notNull())
    .addColumn("task_context", "text")
    .addColumn("response", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("platform", "text", (col) => col.notNull())
    .addColumn("channel_id", "text")
    .addColumn("message_ref", "text")
    .addColumn("requester_platform", "text", (col) => col.notNull())
    .addColumn("requester_channel", "text", (col) => col.notNull())
    .addColumn("requester_thread_ts", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("responded_at", "text")
    .execute();

  await sql`CREATE INDEX idx_outreach_recipient_status ON outreach_messages(recipient_user_id, status)`.execute(db);
  await sql`CREATE INDEX idx_outreach_requester_status ON outreach_messages(requester_user_id, status)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("outreach_messages").execute();
}
