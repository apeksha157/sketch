import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const column of ["verification_json", "signing_secret_encrypted", "source_binding"]) {
    await db.schema.alterTable("webhook_endpoints").addColumn(column, "text").execute();
  }
}

/** Signed endpoints must never become unauthenticated endpoints after a downgrade. */
export async function down(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ count: string | number }>`
    SELECT COUNT(*) AS count FROM webhook_endpoints
    WHERE verification_json IS NOT NULL OR signing_secret_encrypted IS NOT NULL OR source_binding IS NOT NULL
  `.execute(db);
  if (Number(result.rows[0]?.count ?? 0) > 0) {
    throw new Error("Remove signed webhook automations and their remote registrations before downgrading.");
  }
  for (const column of ["source_binding", "signing_secret_encrypted", "verification_json"]) {
    await db.schema.alterTable("webhook_endpoints").dropColumn(column).execute();
  }
}
