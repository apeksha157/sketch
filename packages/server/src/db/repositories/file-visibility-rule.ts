import type { RawBuilder } from "kysely";
import { sql } from "kysely";
import type { AccessPrincipal } from "../../connectors/types";

export interface VisibilityRuleInput {
  principals: AccessPrincipal[];
  slackEntitySyncEnabled: boolean;
  archived: "exclude" | "include";
  alias?: string;
}

export interface EntityShareGrant {
  entity_id: string;
  grant_kind: "org_wide" | "email";
}

const VALID_ALIAS = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function fileAlias(input: VisibilityRuleInput): RawBuilder<unknown> {
  const alias = input.alias ?? "indexed_files";
  if (!VALID_ALIAS.test(alias)) {
    throw new Error(`fileVisibilityPredicate: invalid table alias "${alias}"`);
  }
  return sql.raw(alias);
}

function emailSql(principals: AccessPrincipal[]): RawBuilder<unknown> | null {
  const emails = principals.filter((principal) => principal.type === "email").map((principal) => principal.value);
  return emails.length > 0
    ? sql.join(
        emails.map((email) => sql`${email}`),
        sql`,`,
      )
    : null;
}

function accessDoor(input: VisibilityRuleInput, alias: RawBuilder<unknown>): RawBuilder<boolean> {
  return input.slackEntitySyncEnabled
    ? sql<boolean>`(${alias}.source IS NULL OR ${alias}.source NOT IN ('slack', 'whatsapp'))`
    : sql<boolean>`1 = 1`;
}

export function accessPrincipalPredicateSql(alias: string, principals: AccessPrincipal[]): RawBuilder<boolean> {
  if (principals.length === 0) return sql<boolean>`0 = 1`;
  const column = sql.raw(alias);
  return sql<boolean>`(${sql.join(
    principals.map(
      (principal) =>
        sql`${column}.principal_type = ${principal.type} AND ${column}.principal_value = ${principal.value}`,
    ),
    sql` OR `,
  )})`;
}

export function unrestrictedDoorSql(input: VisibilityRuleInput): RawBuilder<boolean> {
  const alias = fileAlias(input);
  return sql<boolean>`(${accessDoor(input, alias)}
    AND ${alias}.access_scope_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM file_access fa WHERE fa.indexed_file_id = ${alias}.id))`;
}

export function scopeMembershipDoorSql(input: VisibilityRuleInput): RawBuilder<boolean> {
  const alias = fileAlias(input);
  return sql<boolean>`EXISTS (SELECT 1 FROM access_scope_members asm
    WHERE asm.access_scope_id = ${alias}.access_scope_id
      AND ${alias}.access_scope_id <> ''
      AND ${accessPrincipalPredicateSql("asm", input.principals)})`;
}

export function perFileAccessDoorSql(input: VisibilityRuleInput): RawBuilder<boolean> {
  const alias = fileAlias(input);
  return sql<boolean>`(${accessDoor(input, alias)} AND EXISTS (SELECT 1 FROM file_access fa
    WHERE fa.indexed_file_id = ${alias}.id
      AND ${accessPrincipalPredicateSql("fa", input.principals)}))`;
}

export function manualShareDoorSql(input: VisibilityRuleInput): RawBuilder<boolean> {
  const alias = fileAlias(input);
  const emails = emailSql(input.principals);
  return emails
    ? sql<boolean>`EXISTS (SELECT 1 FROM file_share_emails fse
        WHERE fse.indexed_file_id = ${alias}.id
          AND fse.email IN (${emails}))`
    : sql<boolean>`0 = 1`;
}

export function fileOrgWideDoorSql(input: VisibilityRuleInput): RawBuilder<boolean> {
  const alias = fileAlias(input);
  return sql<boolean>`${alias}.share_with_everyone = 1`;
}

export function entityShareDoorSql(input: VisibilityRuleInput): RawBuilder<boolean> {
  const alias = fileAlias(input);
  const emails = emailSql(input.principals);
  return sql<boolean>`EXISTS (
    SELECT 1 FROM entity_mentions em_shared
    WHERE em_shared.indexed_file_id = ${alias}.id
      AND em_shared.entity_id IN (
        SELECT ent_shared.id
        FROM entities ent_shared
        WHERE ent_shared.deleted_at IS NULL
          AND ent_shared.merged_into_entity_id IS NULL
          AND (
            ent_shared.share_with_everyone = 1
            OR ${
              emails
                ? sql`EXISTS (
                  SELECT 1 FROM entity_share_emails ese
                  WHERE ese.entity_id = ent_shared.id AND ese.email IN (${emails})
                )`
                : sql`0 = 1`
            }
          )
      )
  )`;
}

export function entityShareGrantsSql(fileId: string): RawBuilder<EntityShareGrant> {
  return sql<EntityShareGrant>`WITH shared_entities AS (
    SELECT DISTINCT ent_grant.id AS entity_id, ent_grant.share_with_everyone, ese_grant.email
    FROM entity_mentions em_grant
    INNER JOIN entities ent_grant ON ent_grant.id = em_grant.entity_id
    LEFT JOIN entity_share_emails ese_grant ON ese_grant.entity_id = ent_grant.id
    WHERE em_grant.indexed_file_id = ${fileId}
      AND ent_grant.deleted_at IS NULL
      AND ent_grant.merged_into_entity_id IS NULL
      AND (ent_grant.share_with_everyone = 1 OR ese_grant.email IS NOT NULL)
  )
  SELECT DISTINCT entity_id, 'org_wide' AS grant_kind
  FROM shared_entities
  WHERE share_with_everyone = 1
  UNION
  SELECT DISTINCT entity_id, 'email' AS grant_kind
  FROM shared_entities
  WHERE email IS NOT NULL`;
}

export function fileVisibilityRuleSql(input: VisibilityRuleInput): RawBuilder<boolean> {
  const alias = fileAlias(input);
  const doors = sql<boolean>`(
    ${unrestrictedDoorSql(input)}
    OR ${scopeMembershipDoorSql(input)}
    OR ${perFileAccessDoorSql(input)}
    OR ${manualShareDoorSql(input)}
    OR ${fileOrgWideDoorSql(input)}
    OR ${entityShareDoorSql(input)}
  )`;
  return input.archived === "exclude" ? sql<boolean>`(${alias}.is_archived = 0 AND ${doors})` : doors;
}

/**
 * The same six visibility doors as `fileVisibilityRuleSql`, rendered as set-producing
 * branches so restricted searches can materialise visible IDs before entering FTS or KNN.
 * Each branch is capped independently, and branches that can repeat one file use DISTINCT
 * before their cap. That makes the JS-deduped result exact for visible-set selection:
 * either every branch completed, or one branch supplied `cap + 1` distinct IDs and forces
 * the inline-rule regime on its own. Keep this equivalent with `fileVisibilityRuleSql`;
 * the Postgres integration test pins the contract.
 */
export function visibleFileIdsSql(
  input: Omit<VisibilityRuleInput, "alias">,
  limit: number,
): RawBuilder<{ id: string }> {
  const archived = input.archived === "exclude" ? sql`AND f.is_archived = 0` : sql``;
  const emails = emailSql(input.principals);
  const branches: RawBuilder<{ id: string }>[] = [
    sql<{ id: string }>`SELECT id FROM (
      SELECT f.id FROM indexed_files f
      WHERE 1 = 1
        ${archived}
        AND ${accessDoor(input, sql.raw("f"))}
        AND f.access_scope_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM file_access fa WHERE fa.indexed_file_id = f.id)
      LIMIT ${limit}
    ) branch_unrestricted`,
    sql<{ id: string }>`SELECT id FROM (
      SELECT f.id FROM indexed_files f
      WHERE 1 = 1
        ${archived}
        AND f.access_scope_id <> ''
        AND f.access_scope_id IN (
          SELECT asm.access_scope_id
          FROM access_scope_members asm
          WHERE ${accessPrincipalPredicateSql("asm", input.principals)}
        )
      LIMIT ${limit}
    ) branch_scope_membership`,
    sql<{ id: string }>`SELECT id FROM (
      SELECT DISTINCT fa.indexed_file_id AS id FROM file_access fa
      INNER JOIN indexed_files f ON f.id = fa.indexed_file_id
      WHERE 1 = 1
        ${archived}
        AND ${accessDoor(input, sql.raw("f"))}
        AND ${accessPrincipalPredicateSql("fa", input.principals)}
      LIMIT ${limit}
    ) branch_per_file_access`,
  ];

  if (emails) {
    branches.push(sql<{ id: string }>`SELECT id FROM (
      SELECT DISTINCT fse.indexed_file_id AS id FROM file_share_emails fse
      INNER JOIN indexed_files f ON f.id = fse.indexed_file_id
      WHERE 1 = 1
        ${archived}
        AND fse.email IN (${emails})
      LIMIT ${limit}
    ) branch_manual_share`);
  }

  branches.push(
    sql<{ id: string }>`SELECT id FROM (
      SELECT f.id FROM indexed_files f
      WHERE 1 = 1
        ${archived}
        AND f.share_with_everyone = 1
      LIMIT ${limit}
    ) branch_file_org_wide`,
    sql<{ id: string }>`SELECT id FROM (
      SELECT DISTINCT em.indexed_file_id AS id FROM entity_mentions em
      INNER JOIN indexed_files f ON f.id = em.indexed_file_id
      WHERE 1 = 1
        ${archived}
        AND em.entity_id IN (
          SELECT e.id
          FROM entities e
          WHERE e.deleted_at IS NULL
            AND e.merged_into_entity_id IS NULL
            AND (
              e.share_with_everyone = 1
              OR ${
                emails
                  ? sql`EXISTS (
                    SELECT 1 FROM entity_share_emails ese
                    WHERE ese.entity_id = e.id AND ese.email IN (${emails})
                  )`
                  : sql`0 = 1`
              }
            )
        )
      LIMIT ${limit}
    ) branch_entity_share`,
  );

  return sql<{ id: string }>`SELECT id FROM (${sql.join(branches, sql` UNION ALL `)}) visible_files`;
}
