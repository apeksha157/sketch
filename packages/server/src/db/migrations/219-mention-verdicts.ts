import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

const REBUILD_TABLE = "graph_verdicts_219_rebuild";
const COLUMNS_WITH_MENTION = [
  "id",
  "run_id",
  "action",
  "subject_entity_id",
  "subject_container_id",
  "subject_mention_name",
  "subject_name",
  "subject_entity_type",
  "target_entity_id",
  "resolved_target_entity_id",
  "target_name",
  "reason",
  "evidence_json",
  "evidence_fingerprint",
  "validation_status",
  "validation_reason",
  "would_change_json",
  "status",
  "superseded_at",
  "decided_at",
  "decided_by_user_id",
  "applied_ledger_ref",
  "created_at",
  "updated_at",
] as const;
const COLUMNS_WITHOUT_MENTION = COLUMNS_WITH_MENTION.filter((column) => column !== "subject_mention_name");

async function createGraphVerdictsTable(db: Kysely<unknown>, tableName: string, includeMentionSubject: boolean) {
  const table = db.schema
    .createTable(tableName)
    .addColumn("id", "text", (col) => col.notNull().primaryKey())
    .addColumn("run_id", "text", (col) => col.notNull().references("graph_verdict_runs.id").onDelete("cascade"))
    .addColumn("action", "text", (col) => col.notNull())
    .addColumn("subject_entity_id", "text")
    .addColumn("subject_container_id", "text", (col) => col.references("containers.id").onDelete("cascade"));
  const withMention = includeMentionSubject ? table.addColumn("subject_mention_name", "text") : table;
  await withMention
    .addColumn("subject_name", "text")
    .addColumn("subject_entity_type", "text")
    .addColumn("target_entity_id", "text")
    .addColumn("resolved_target_entity_id", "text")
    .addColumn("target_name", "text")
    .addColumn("reason", "text", (col) => col.notNull())
    .addColumn("evidence_json", "text", (col) => col.notNull())
    .addColumn("evidence_fingerprint", "text", (col) => col.notNull())
    .addColumn("validation_status", "text", (col) => col.notNull())
    .addColumn("validation_reason", "text")
    .addColumn("would_change_json", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("superseded_at", "text")
    .addColumn("decided_at", "text")
    .addColumn("decided_by_user_id", "text")
    .addColumn("applied_ledger_ref", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
}

async function createIndexes(db: Kysely<unknown>, includeMentionSubject: boolean) {
  await sql`CREATE INDEX IF NOT EXISTS idx_graph_verdicts_subject_status
    ON graph_verdicts(subject_entity_id, status)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_graph_verdicts_run_id
    ON graph_verdicts(run_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_graph_verdicts_status_created
    ON graph_verdicts(status, created_at)`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_pair
    ON graph_verdicts(subject_entity_id, action)
    WHERE status IN ('awaiting_human', 'approved') AND superseded_at IS NULL`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_container
    ON graph_verdicts(subject_container_id, action)
    WHERE status IN ('awaiting_human', 'approved')
      AND superseded_at IS NULL
      AND subject_container_id IS NOT NULL`.execute(db);
  if (includeMentionSubject) {
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_mention
      ON graph_verdicts(subject_mention_name, subject_entity_type, action)
      WHERE status IN ('awaiting_human', 'approved')
        AND superseded_at IS NULL
        AND subject_mention_name IS NOT NULL`.execute(db);
  }
}

async function dropIndexes(db: Kysely<unknown>) {
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_mention`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_container`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_pair`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_status_created`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_run_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_subject_status`.execute(db);
}

async function rebuildSqlite(db: Kysely<unknown>, includeMentionSubject: boolean) {
  const foreignKeys = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db);
  const wasEnabled = foreignKeys.rows[0]?.foreign_keys === 1;
  if (wasEnabled) await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await sql`DROP TABLE IF EXISTS graph_verdicts_219_rebuild`.execute(db);
    await dropIndexes(db);
    await createGraphVerdictsTable(db, REBUILD_TABLE, includeMentionSubject);
    const targetColumns = includeMentionSubject ? COLUMNS_WITH_MENTION : COLUMNS_WITHOUT_MENTION;
    const sourceColumns = includeMentionSubject
      ? COLUMNS_WITH_MENTION.map((column) => (column === "subject_mention_name" ? "NULL" : column))
      : COLUMNS_WITHOUT_MENTION;
    const sourceFilter = includeMentionSubject ? sql`` : sql`WHERE subject_mention_name IS NULL`;
    await sql`INSERT INTO graph_verdicts_219_rebuild (${sql.raw(targetColumns.join(", "))})
      SELECT ${sql.raw(sourceColumns.join(", "))}
      FROM graph_verdicts
      ${sourceFilter}`.execute(db);
    await sql`DROP TABLE graph_verdicts`.execute(db);
    await sql`ALTER TABLE graph_verdicts_219_rebuild RENAME TO graph_verdicts`.execute(db);
    await createIndexes(db, includeMentionSubject);
  } finally {
    if (wasEnabled) await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await db.schema.alterTable("graph_verdicts").addColumn("subject_mention_name", "text").execute();
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_mention
      ON graph_verdicts(subject_mention_name, subject_entity_type, action)
      WHERE status IN ('awaiting_human', 'approved')
        AND superseded_at IS NULL
        AND subject_mention_name IS NOT NULL`.execute(db);
    return;
  }

  await rebuildSqlite(db, true);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_mention`.execute(db);
    await sql`DELETE FROM graph_verdicts WHERE subject_mention_name IS NOT NULL`.execute(db);
    await db.schema.alterTable("graph_verdicts").dropColumn("subject_mention_name").execute();
    return;
  }

  await rebuildSqlite(db, false);
}
