import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE api_tokens
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE kind = 'pat'
      AND revoked_at IS NULL
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
