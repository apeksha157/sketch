/**
 * Adds type, role, and reports_to columns to the users table.
 *
 * type: discriminates between human and agent team members. DEFAULT 'human' ensures
 * all existing rows get the correct type without a backfill. Agents are directory
 * entries with no email/Slack/WhatsApp — excluded from auth flows by checking type.
 *
 * role: short title ("VP Marketing", "Research Assistant"). Separate from description
 * so org chart cards can display a subtitle distinct from the longer description text.
 *
 * reports_to: self-referencing FK for the org chart hierarchy. ON DELETE SET NULL
 * means deleting a manager unsets their reports' reference rather than cascading.
 * SQLite does not enforce FK constraints on ALTER TABLE ADD COLUMN, and requires
 * PRAGMA foreign_keys = ON (not set by Kysely by default) for ON DELETE behavior.
 * The constraint is preserved for Postgres compatibility and as schema documentation.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("users")
    .addColumn("type", "text", (col) => col.notNull().defaultTo("human"))
    .execute();
  await db.schema.alterTable("users").addColumn("role", "text").execute();
  await db.schema
    .alterTable("users")
    .addColumn("reports_to", "text", (col) => col.references("users.id"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").dropColumn("reports_to").execute();
  await db.schema.alterTable("users").dropColumn("role").execute();
  await db.schema.alterTable("users").dropColumn("type").execute();
}
