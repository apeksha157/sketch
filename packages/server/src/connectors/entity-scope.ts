import type { Kysely, RawBuilder, SqlBool } from "kysely";
import { sql } from "kysely";
import type { DB } from "../db/schema";
import { idInList } from "./id-in-list";

export interface EntityScope {
  entityIds: string[];
  mode: "and" | "or";
}

/**
 * Render a file-correlated entity scope without materialising the matching file IDs.
 *
 * AND mode deliberately emits one EXISTS per deduplicated entity. PostgreSQL can plan
 * these as semi-joins, while a scalar COUNT(DISTINCT) subquery forces per-row evaluation.
 * The probes on indexed_file_id and entity_id are served by idx_entity_mentions_file
 * from migration 027 or the entity_id prefix of
 * uq_entity_mentions_entity_file_relation from migration 060.
 */
export function entityScopePredicateSql(fileId: RawBuilder<unknown>, scope: EntityScope): RawBuilder<SqlBool> {
  const entityIds = [...new Set(scope.entityIds)];
  if (entityIds.length === 0) return sql<SqlBool>`FALSE`;
  const entityFilter = sql`em.entity_id IN (${sql.join(
    entityIds.map((entityId) => sql`${entityId}`),
    sql`,`,
  )})`;

  if (scope.mode === "or" || entityIds.length === 1) {
    return sql<SqlBool>`EXISTS (
      SELECT 1
      FROM entity_mentions em
      WHERE em.indexed_file_id = ${fileId}
        AND ${entityFilter}
    )`;
  }

  return sql<SqlBool>`${sql.join(
    entityIds.map(
      (entityId) => sql`EXISTS (
        SELECT 1
        FROM entity_mentions em
        WHERE em.indexed_file_id = ${fileId}
          AND em.entity_id = ${entityId}
      )`,
    ),
    sql` AND `,
  )}`;
}

/** Save a paid query embedding call when stale or non-existent entity IDs have no linked files. */
export async function entityScopeHasFiles(db: Kysely<DB>, scope: EntityScope): Promise<boolean> {
  const row = await db
    .selectFrom("indexed_files")
    .select(sql<number>`1`.as("present"))
    .where(entityScopePredicateSql(sql.ref("indexed_files.id"), scope))
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** Find the bounded subset of candidate files linked to any matched entity. */
export async function findEntityLinkedFileIds(
  db: Kysely<DB>,
  candidateFileIds: string[],
  entityIds: string[],
): Promise<Set<string>> {
  const uniqueCandidateIds = [...new Set(candidateFileIds)];
  const uniqueEntityIds = [...new Set(entityIds)];
  if (uniqueCandidateIds.length === 0 || uniqueEntityIds.length === 0) return new Set();

  const rows = await db
    .selectFrom("entity_mentions")
    .select("indexed_file_id")
    .distinct()
    .where(idInList(db, sql.ref("entity_mentions.indexed_file_id"), uniqueCandidateIds))
    .where("entity_id", "in", uniqueEntityIds)
    .execute();
  return new Set(rows.map((row) => row.indexed_file_id));
}

/**
 * Materialise an entity scope only for SQLite's vector arm, which cannot accept SQL predicates.
 * This is intentionally unbounded and uses O(files in scope) memory; it remains solely for the
 * deprecated SQLite path.
 */
export async function resolveSqliteEntityScopeFileIds(db: Kysely<DB>, scope: EntityScope): Promise<Set<string>> {
  const rows = await db
    .selectFrom("indexed_files")
    .select("id")
    .where(entityScopePredicateSql(sql.ref("indexed_files.id"), scope))
    .execute();
  return new Set(rows.map((row) => row.id));
}
