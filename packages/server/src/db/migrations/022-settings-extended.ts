/**
 * Extend settings with SMTP secure flag, Google OAuth, and Gemini API key columns.
 * SMTP host/port/user/password/from already exist from 007-settings-smtp.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE settings ADD COLUMN smtp_secure INTEGER DEFAULT 1`.execute(db);
  await sql`ALTER TABLE settings ADD COLUMN google_oauth_client_id TEXT`.execute(db);
  await sql`ALTER TABLE settings ADD COLUMN google_oauth_client_secret TEXT`.execute(db);
  await sql`ALTER TABLE settings ADD COLUMN gemini_api_key TEXT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
}
