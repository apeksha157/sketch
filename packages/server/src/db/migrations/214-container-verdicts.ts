import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

const TABLE = "graph_verdicts";
const REBUILD_TABLE = "graph_verdicts_213_rebuild";
const COLUMNS_WITH_CONTAINER = [
  "id",
  "run_id",
  "action",
  "subject_entity_id",
  "subject_container_id",
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
const COLUMNS_WITHOUT_CONTAINER = COLUMNS_WITH_CONTAINER.filter((column) => column !== "subject_container_id");

async function createGraphVerdictsTable(
  db: Kysely<unknown>,
  tableName: string,
  subjectEntityRequired: boolean,
  includeContainerSubject: boolean,
): Promise<void> {
  const table = db.schema
    .createTable(tableName)
    .addColumn("id", "text", (col) => col.notNull().primaryKey())
    .addColumn("run_id", "text", (col) => col.notNull().references("graph_verdict_runs.id").onDelete("cascade"))
    .addColumn("action", "text", (col) => col.notNull());
  const withSubject = subjectEntityRequired
    ? table.addColumn("subject_entity_id", "text", (col) => col.notNull())
    : table.addColumn("subject_entity_id", "text");
  const withContainer = includeContainerSubject
    ? withSubject.addColumn("subject_container_id", "text", (col) =>
        col.references("containers.id").onDelete("cascade"),
      )
    : withSubject;
  await withContainer
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

async function createIndexes(db: Kysely<unknown>, includeContainerSubject: boolean): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS idx_graph_verdicts_subject_status
    ON graph_verdicts(subject_entity_id, status)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_graph_verdicts_run_id
    ON graph_verdicts(run_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_graph_verdicts_status_created
    ON graph_verdicts(status, created_at)`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_pair
    ON graph_verdicts(subject_entity_id, action)
    WHERE status IN ('awaiting_human', 'approved') AND superseded_at IS NULL`.execute(db);
  if (includeContainerSubject) {
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_container
      ON graph_verdicts(subject_container_id, action)
      WHERE status IN ('awaiting_human', 'approved')
        AND superseded_at IS NULL
        AND subject_container_id IS NOT NULL`.execute(db);
  }
}

async function dropIndexes(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_container`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_pair`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_status_created`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_run_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_graph_verdicts_subject_status`.execute(db);
}

async function rebuildSqlite(
  db: Kysely<unknown>,
  subjectEntityRequired: boolean,
  includeContainerSubject: boolean,
): Promise<void> {
  const foreignKeys = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db);
  const wasEnabled = foreignKeys.rows[0]?.foreign_keys === 1;
  if (wasEnabled) await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await sql`DROP TABLE IF EXISTS graph_verdicts_213_rebuild`.execute(db);
    await dropIndexes(db);
    await createGraphVerdictsTable(db, REBUILD_TABLE, subjectEntityRequired, includeContainerSubject);
    const targetColumns = includeContainerSubject ? COLUMNS_WITH_CONTAINER : COLUMNS_WITHOUT_CONTAINER;
    const sourceColumns = includeContainerSubject
      ? COLUMNS_WITH_CONTAINER.map((column) => (column === "subject_container_id" ? "NULL" : column))
      : COLUMNS_WITHOUT_CONTAINER;
    const sourceFilter = subjectEntityRequired ? sql`WHERE subject_entity_id IS NOT NULL` : sql``;
    await sql`INSERT INTO graph_verdicts_213_rebuild (${sql.raw(targetColumns.join(", "))})
      SELECT ${sql.raw(sourceColumns.join(", "))}
      FROM graph_verdicts
      ${sourceFilter}`.execute(db);
    await sql`DROP TABLE graph_verdicts`.execute(db);
    await sql`ALTER TABLE graph_verdicts_213_rebuild RENAME TO graph_verdicts`.execute(db);
    await createIndexes(db, includeContainerSubject);
  } finally {
    if (wasEnabled) await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await db.schema
      .alterTable("graph_verdicts")
      .addColumn("subject_container_id", "text", (col) => col.references("containers.id").onDelete("cascade"))
      .execute();
    await sql`ALTER TABLE graph_verdicts ALTER COLUMN subject_entity_id DROP NOT NULL`.execute(db);
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_verdicts_active_container
      ON graph_verdicts(subject_container_id, action)
      WHERE status IN ('awaiting_human', 'approved')
        AND superseded_at IS NULL
        AND subject_container_id IS NOT NULL`.execute(db);
    return;
  }

  await rebuildSqlite(db, false, true);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`DROP INDEX IF EXISTS idx_graph_verdicts_active_container`.execute(db);
    await sql`DELETE FROM graph_verdicts WHERE subject_entity_id IS NULL`.execute(db);
    await sql`ALTER TABLE graph_verdicts ALTER COLUMN subject_entity_id SET NOT NULL`.execute(db);
    await db.schema.alterTable("graph_verdicts").dropColumn("subject_container_id").execute();
    return;
  }

  await sql`UPDATE containers
    SET verdict_id = NULL
    WHERE verdict_id IN (SELECT id FROM graph_verdicts WHERE subject_entity_id IS NULL)`.execute(db);
  await rebuildSqlite(db, true, false);
}
