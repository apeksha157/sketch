import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

const OPEN_SLICE_INDEX = "conversation_slices_one_open_per_conversation_uidx";
const OPEN_ENDED_AT_INDEX = "conversation_slices_open_ended_at_idx";
const PENDING_SINCE_INDEX = "conversation_slice_stream_cursors_pending_since_idx";

async function addTextColumnIfMissing(db: Kysely<unknown>, table: string, column: string): Promise<void> {
  if (isPg(db)) {
    await sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} TEXT`).execute(db);
    return;
  }
  const columns = await sql.raw<{ name: string }>(`PRAGMA table_info(${table})`).execute(db);
  if (columns.rows.some((row) => row.name === column)) return;
  await db.schema.alterTable(table).addColumn(column, "text").execute();
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DROP INDEX IF EXISTS ${OPEN_SLICE_INDEX}`).execute(db);
  await sql
    .raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${OPEN_SLICE_INDEX}
      ON conversation_slices(conversation_id, (COALESCE(provider_thread_id, '')))
      WHERE status = 'open'
    `)
    .execute(db);
  await sql
    .raw(`
      CREATE INDEX IF NOT EXISTS ${OPEN_ENDED_AT_INDEX}
      ON conversation_slices(ended_at, conversation_id)
      WHERE status = 'open'
    `)
    .execute(db);
  await addTextColumnIfMissing(db, "conversation_slices", "legacy_unjudged_at");
  await addTextColumnIfMissing(db, "conversation_slice_stream_cursors", "pending_since");
  await addTextColumnIfMissing(db, "conversation_slice_stream_cursors", "llm_last_attempt_at");
  await sql
    .raw(`
      CREATE INDEX IF NOT EXISTS ${PENDING_SINCE_INDEX}
      ON conversation_slice_stream_cursors(pending_since)
      WHERE pending_since IS NOT NULL
    `)
    .execute(db);
  await sql`
    UPDATE conversation_slice_stream_cursors
    SET pending_since = CURRENT_TIMESTAMP
    WHERE stream_key <> '::router'
  `.execute(db);
  await sql`
    UPDATE conversation_slices
    SET salience_verdict = 'kept', legacy_unjudged_at = CURRENT_TIMESTAMP
    WHERE salience_verdict IS NULL
      AND EXISTS (
        SELECT 1
        FROM conversations
        WHERE conversations.id = conversation_slices.conversation_id
          AND conversations.platform = 'slack'
          AND conversations.kind = 'channel'
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rollback = async (trx: Kysely<unknown>) => {
    await sql`
      UPDATE conversation_slices
      SET status = 'closed', flush_reason = 'gap'
      WHERE status = 'open'
        AND EXISTS (
          SELECT 1
          FROM conversations
          WHERE conversations.id = conversation_slices.conversation_id
            AND conversations.platform = 'slack'
            AND conversations.kind = 'channel'
        )
    `.execute(trx);
    await sql.raw(`DROP INDEX IF EXISTS ${OPEN_ENDED_AT_INDEX}`).execute(trx);
    await sql.raw(`DROP INDEX IF EXISTS ${PENDING_SINCE_INDEX}`).execute(trx);
    await sql.raw(`DROP INDEX IF EXISTS ${OPEN_SLICE_INDEX}`).execute(trx);
    await trx.schema.alterTable("conversation_slices").dropColumn("legacy_unjudged_at").execute();
    await trx.schema.alterTable("conversation_slice_stream_cursors").dropColumn("pending_since").execute();
    await trx.schema.alterTable("conversation_slice_stream_cursors").dropColumn("llm_last_attempt_at").execute();
    await sql
      .raw(`
        CREATE UNIQUE INDEX ${OPEN_SLICE_INDEX}
        ON conversation_slices(conversation_id)
        WHERE status = 'open'
      `)
      .execute(trx);
  };
  if (db.isTransaction) {
    await rollback(db);
    return;
  }
  await db.transaction().execute(rollback);
}
