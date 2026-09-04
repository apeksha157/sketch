import { type Kysely, sql } from "kysely";

const OPEN_SLICE_INDEX = "conversation_slices_one_open_per_conversation_uidx";
const OPEN_ENDED_AT_INDEX = "conversation_slices_open_ended_at_idx";
const PENDING_SINCE_INDEX = "conversation_slice_stream_cursors_pending_since_idx";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DROP INDEX IF EXISTS ${OPEN_SLICE_INDEX}`).execute(db);
  await sql
    .raw(`
      CREATE UNIQUE INDEX ${OPEN_SLICE_INDEX}
      ON conversation_slices(conversation_id, (COALESCE(provider_thread_id, '')))
      WHERE status = 'open'
    `)
    .execute(db);
  await sql
    .raw(`
      CREATE INDEX ${OPEN_ENDED_AT_INDEX}
      ON conversation_slices(ended_at, conversation_id)
      WHERE status = 'open'
    `)
    .execute(db);
  await db.schema.alterTable("conversation_slices").addColumn("legacy_unjudged_at", "text").execute();
  await db.schema.alterTable("conversation_slice_stream_cursors").addColumn("pending_since", "text").execute();
  await db.schema.alterTable("conversation_slice_stream_cursors").addColumn("llm_last_attempt_at", "text").execute();
  await sql
    .raw(`
      CREATE INDEX ${PENDING_SINCE_INDEX}
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
