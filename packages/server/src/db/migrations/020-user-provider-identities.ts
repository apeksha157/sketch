/**
 * Per-user OAuth identity mapping.
 *
 * Links each Sketch user to their account in each provider (Google, ClickUp,
 * Notion, Linear) via OAuth. Stores the user's own access token so we can
 * verify what they can see.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("user_provider_identities")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id"))
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("provider_user_id", "text", (col) => col.notNull())
    .addColumn("provider_email", "text")
    .addColumn("access_token", "text")
    .addColumn("refresh_token", "text")
    .addColumn("token_expires_at", "text")
    .addColumn("connected_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await sql`CREATE UNIQUE INDEX idx_upi_user_provider ON user_provider_identities(user_id, provider)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("user_provider_identities").execute();
}
