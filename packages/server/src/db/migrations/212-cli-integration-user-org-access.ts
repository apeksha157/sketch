import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM agent_environment_variable_shares
    WHERE target_type IN ('slack_channel', 'whatsapp_group')
      AND variable_id IN (
        SELECT credential_variable_id
        FROM cli_integration_connections
      )
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
