import type { Kysely } from "kysely";
import { sql } from "kysely";
import { createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import { createEntityRelationshipsRepository } from "../db/repositories/entity-relationships";
import type { DB } from "../db/schema";
import {
  entityPayload,
  findEntitiesForCuration,
  mentionCounts,
  rawEntityEvidence,
  sharedEvidence,
} from "../mcp/curation/queries";

export const JUDGE_VIEW_BUDGET = 2000;

type Trimmable = { key: string; items: unknown[]; min: number };

function readPath(target: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    return current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)[part]
      : undefined;
  }, target);
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last) current[last] = value;
}

function cloneCore(core: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(core)) as Record<string, unknown>;
}

function markerFor(dropped: number): string {
  return `+${dropped} more`;
}

export function fitJudgeView(core: object, trimmable: Trimmable[]): string {
  const working = cloneCore(core);
  const limits = new Map(trimmable.map((entry) => [entry.key, entry.items.length]));
  for (const entry of trimmable) {
    writePath(working, entry.key, entry.items);
  }

  let serialized = JSON.stringify(working);
  while (serialized.length > JUDGE_VIEW_BUDGET) {
    const candidates = trimmable
      .map((entry) => ({ ...entry, current: limits.get(entry.key) ?? entry.items.length }))
      .filter((entry) => entry.current > entry.min)
      .sort((a, b) => b.current - a.current);
    const candidate = candidates[0];
    if (!candidate) break;
    const next = Math.max(candidate.min, Math.ceil(candidate.current / 2));
    limits.set(candidate.key, next);
    const dropped = candidate.items.length - next;
    writePath(working, candidate.key, [...candidate.items.slice(0, next), markerFor(dropped)]);
    serialized = JSON.stringify(working);
  }
  if (serialized.length <= JUDGE_VIEW_BUDGET) return serialized;
  return `${serialized.slice(0, JUDGE_VIEW_BUDGET - "…[truncated]".length)}…[truncated]`;
}

export async function entitySummaryView(db: Kysely<DB>, entityId: string): Promise<string> {
  const row = await db.selectFrom("entities").selectAll().where("id", "=", entityId).executeTakeFirst();
  if (!row) return JSON.stringify({ error: "entity_not_found" });

  const counts = await mentionCounts(db, [entityId]);
  const evidence = await rawEntityEvidence(db, entityId, 8);
  const stats = await db
    .selectFrom("entity_mentions")
    .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
    .select([
      sql<number>`COUNT(DISTINCT entity_mentions.indexed_file_id)`.as("distinct_file_count"),
      sql<string | null>`
        MAX(COALESCE(indexed_files.source_created_at, indexed_files.synced_at, entity_mentions.mentioned_at))
      `.as("last_activity"),
    ])
    .where("entity_mentions.entity_id", "=", entityId)
    .executeTakeFirst();
  const relations = await createEntityRelationshipsRepository(db).listRelationsForEntity(entityId, { limit: 50 });
  const relationRows = [...relations.outgoing, ...relations.incoming];
  const relationshipCountsByType = relationRows.reduce<Record<string, number>>((acc, relation) => {
    acc[relation.relationshipType] = (acc[relation.relationshipType] ?? 0) + 1;
    return acc;
  }, {});
  const topRelations = relationRows
    .map((relation) => ({
      id: relation.id,
      type: relation.relationshipType,
      other: relation.other.name,
      otherId: relation.other.id,
      evidenceCount: relation.evidenceCount,
    }))
    .sort((a, b) => b.evidenceCount - a.evidenceCount || a.other.localeCompare(b.other));
  const contactPointEmails = (await createEntityRepository(db).getContactPointsForEntity(entityId))
    .filter((point) => point.kind === "email")
    .map((point) => point.value)
    .sort((a, b) => a.localeCompare(b));
  const corporateDomains = (evidence.domains ?? [])
    .filter((domain) => domain.kind === "corporate")
    .map((domain) => domain.domain);
  const payload = entityPayload(row, counts.get(entityId) ?? 0, evidence.entity?.tombstone?.mergedInto ?? null);
  const core = {
    id: payload.id,
    name: payload.name,
    sourceType: payload.sourceType,
    subtype: payload.subtype,
    status: payload.status,
    provenanceTier: payload.provenanceTier,
    tombstone: payload.tombstone,
    mentionCount: counts.get(entityId) ?? 0,
    distinctFileCount: Number(stats?.distinct_file_count ?? 0),
    lastActivity: stats?.last_activity ?? null,
    aliases: payload.aliases,
    relationshipCountsByType,
    topRelations,
    contactPointEmails,
    corporateDomains,
  };
  return fitJudgeView(core, [
    { key: "aliases", items: payload.aliases, min: 4 },
    { key: "topRelations", items: topRelations, min: 3 },
    { key: "contactPointEmails", items: contactPointEmails, min: 2 },
  ]);
}

/**
 * One-edit and alias recall are inherited from the curation search tiers here;
 * this view does not add a second matcher with different semantics.
 */
export async function candidateLookupView(
  db: Kysely<DB>,
  input: { name: string; entityType: string },
): Promise<string> {
  const result = await findEntitiesForCuration(db, {
    queries: [input.name],
    types: [input.entityType],
    includeTombstones: true,
  });
  const rows = result.results.map((row) => ({
    id: row.id,
    name: row.name,
    aliases: row.aliases.slice(0, 3),
    provenanceTier: row.provenanceTier,
    mentionCount: row.mentionCount,
    tombstone: row.tombstone,
  }));
  return fitJudgeView({ total: result.total, rows }, [{ key: "rows", items: rows, min: 5 }]);
}

export async function pairwiseEvidenceView(db: Kysely<DB>, entityIds: string[]): Promise<string> {
  const ids = [...new Set(entityIds)].slice(0, 5);
  const evidence = await sharedEvidence(db, ids);
  return fitJudgeView(evidence, [{ key: "sharedFiles.files", items: evidence.sharedFiles.files, min: 3 }]);
}

export async function fileContextView(db: Kysely<DB>, fileId: string): Promise<string> {
  const file = await db
    .selectFrom("indexed_files")
    .select(["id", "file_name", "source", "content_category", "synced_at"])
    .where("id", "=", fileId)
    .executeTakeFirst();
  if (!file) return JSON.stringify({ error: "file_not_found" });
  const entities = await db
    .selectFrom("entity_mentions")
    .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
    .select(["entities.id", "entities.name", "entities.source_type"])
    .distinct()
    .where("entity_mentions.indexed_file_id", "=", fileId)
    .where(whereLiveEntity())
    .orderBy("entities.name", "asc")
    .execute();
  const mentionedEntities = entities.map((entity) => ({
    id: entity.id,
    name: entity.name,
    sourceType: entity.source_type,
  }));
  const core = {
    id: file.id,
    fileName: file.file_name,
    source: file.source,
    contentCategory: file.content_category,
    syncedAt: file.synced_at,
    totalMentionedEntities: mentionedEntities.length,
    mentionedEntities,
  };
  return fitJudgeView(core, [{ key: "mentionedEntities", items: mentionedEntities, min: 8 }]);
}
