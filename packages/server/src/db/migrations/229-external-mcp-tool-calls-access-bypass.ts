import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE external_mcp_tool_calls ADD COLUMN access_bypass text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE external_mcp_tool_calls DROP COLUMN access_bypass`.execute(db);
}
