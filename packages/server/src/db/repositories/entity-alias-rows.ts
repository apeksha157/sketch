import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { normalizeName } from "../../entities/name-keys";
import type { DB, EntityAliasProvenance } from "../schema";

export type { EntityAliasProvenance };

const PROVENANCE_RANK: Record<EntityAliasProvenance, number> = {
  legacy: 0,
  mint_model: 1,
  roster: 2,
  merge: 3,
  judge: 4,
  human_confirmed: 5,
};

export function strongerAliasProvenance(
  left: EntityAliasProvenance,
  right: EntityAliasProvenance,
): EntityAliasProvenance {
  return PROVENANCE_RANK[left] >= PROVENANCE_RANK[right] ? left : right;
}

/**
 * Aliases taught by an adjudicated action (a merge, the judge, or a human
 * confirm) keep exact-match solo-link authority in proposeEntity. Weaker
 * tiers — legacy blob aliases, mint-model variations, roster imports — are
 * recall candidates only; they surface for review instead of auto-linking.
 */
export function isSoloLinkAliasProvenance(provenance: EntityAliasProvenance): boolean {
  return PROVENANCE_RANK[provenance] >= PROVENANCE_RANK.merge;
}

function provenanceRankSql(ref: string) {
  return sql<number>`CASE ${sql.ref(ref)}
    WHEN 'legacy' THEN 0
    WHEN 'mint_model' THEN 1
    WHEN 'roster' THEN 2
    WHEN 'merge' THEN 3
    WHEN 'judge' THEN 4
    WHEN 'human_confirmed' THEN 5
    ELSE -1
  END`;
}

export async function recordAlias(
  db: Kysely<DB>,
  input: {
    entityId: string;
    alias: string;
    provenance: EntityAliasProvenance;
    createdBy?: string | null;
  },
): Promise<void> {
  const normalizedAlias = normalizeName(input.alias);
  if (!normalizedAlias) return;
  const incomingRank = provenanceRankSql("excluded.provenance");
  const existingRank = provenanceRankSql("entity_aliases.provenance");
  await db
    .insertInto("entity_aliases")
    .values({
      id: randomUUID(),
      entity_id: input.entityId,
      alias: input.alias,
      normalized_alias: normalizedAlias,
      provenance: input.provenance,
      created_by: input.createdBy ?? null,
    })
    .onConflict((oc) =>
      oc.columns(["entity_id", "normalized_alias"]).doUpdateSet({
        alias: sql`CASE WHEN ${incomingRank} > ${existingRank} THEN excluded.alias ELSE entity_aliases.alias END`,
        provenance: sql`CASE WHEN ${incomingRank} > ${existingRank} THEN excluded.provenance ELSE entity_aliases.provenance END`,
        created_by: sql`CASE WHEN ${incomingRank} > ${existingRank} THEN excluded.created_by ELSE entity_aliases.created_by END`,
      }),
    )
    .execute();
}

export async function recordAliases(
  db: Kysely<DB>,
  entityId: string,
  aliases: string[],
  provenance: EntityAliasProvenance,
  createdBy?: string | null,
): Promise<void> {
  for (const alias of aliases) {
    await recordAlias(db, { entityId, alias, provenance, createdBy });
  }
}

export async function listAliasRows(db: Kysely<DB>, entityId: string) {
  return db
    .selectFrom("entity_aliases")
    .selectAll()
    .where("entity_id", "=", entityId)
    .orderBy("normalized_alias", "asc")
    .execute();
}

export async function deleteAliasRows(db: Kysely<DB>, entityId: string, aliases: string[]): Promise<void> {
  const normalizedAliases = [...new Set(aliases.map((alias) => normalizeName(alias)).filter(Boolean))];
  if (normalizedAliases.length === 0) return;
  await db
    .deleteFrom("entity_aliases")
    .where("entity_id", "=", entityId)
    .where("normalized_alias", "in", normalizedAliases)
    .execute();
}
