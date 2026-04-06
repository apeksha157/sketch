/**
 * Adds a description column to the users table.
 *
 * The description field lets admins and members document what each person does
 * (e.g. "Marketing Lead, handles competitive analysis"). This is used by the
 * agent's GetTeamDirectory tool to decide who to reach out to for a given task.
 * TEXT with no NOT NULL constraint so existing rows default to NULL without
 * requiring a backfill.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").addColumn("description", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").dropColumn("description").execute();
}
