import { sql } from "kysely";
import { resolveContentPrincipals } from "../../access/principals";
import { idInList } from "../../connectors/id-in-list";
import type { AccessPrincipal } from "../../connectors/types";
import { fileVisibilityRuleSql } from "../../db/repositories/file-visibility-rule";
import type { SketchMcpDeps } from "./types";

export function contentPrincipalDeps(deps: SketchMcpDeps) {
  return { ...deps, adminBypass: { enabled: deps.adminReadAllEnabled === true } };
}

/**
 * Keep public entity rows only when at least one mentioning file is visible. For an
 * entity the caller cannot see, the correlated EXISTS scans that entity's mentions before
 * returning false, including the visibility rule's nested entity-share EXISTS. This residual
 * is O(mentions) in the database and occurs only for the negative case.
 */
export async function visibleEntityIdsForPublic<T extends { id: string }>(
  deps: SketchMcpDeps,
  rows: T[],
  principals?: AccessPrincipal[],
): Promise<Set<string>> {
  if (!deps.publicMcp?.filterEntityMetadata || !deps.db || rows.length === 0) {
    return new Set(rows.map((row) => row.id));
  }

  const userPrincipals = principals ?? (await resolveContentPrincipals(contentPrincipalDeps(deps)));
  if (userPrincipals === undefined) return new Set(rows.map((row) => row.id));
  if (userPrincipals.length === 0) return new Set();

  const visibleEntities = await deps.db
    .selectFrom("entities")
    .select("entities.id")
    .where(
      idInList(
        deps.db,
        sql.ref("entities.id"),
        rows.map((row) => row.id),
      ),
    )
    .where(
      sql<boolean>`EXISTS (
        SELECT 1
        FROM entity_mentions em
        INNER JOIN indexed_files f ON f.id = em.indexed_file_id
        WHERE em.entity_id = entities.id
          AND ${fileVisibilityRuleSql({
            principals: userPrincipals,
            slackEntitySyncEnabled: deps.slackEntitySyncEnabled ?? true,
            archived: "exclude",
            alias: "f",
          })}
      )`,
    )
    .execute();

  return new Set(visibleEntities.map((entity) => entity.id));
}

export async function filterEntityRowsForPublic<T extends { id: string }>(
  deps: SketchMcpDeps,
  rows: T[],
  principals?: AccessPrincipal[],
): Promise<T[]> {
  const visibleIds = await visibleEntityIdsForPublic(deps, rows, principals);
  return rows.filter((row) => visibleIds.has(row.id));
}
