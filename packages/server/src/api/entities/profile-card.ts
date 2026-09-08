import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import { type FileViewer, fileVisibilityPredicate } from "../../db/repositories/connectors";
import { type EntityCrmActivityBrief, createEntityRepository, whereLiveEntity } from "../../db/repositories/entities";
import { listPendingNameProposalsByEntity } from "../../db/repositories/entity-aliases";
import {
  type RelationListEntry,
  createEntityRelationshipsRepository,
} from "../../db/repositories/entity-relationships";
import { type EntityTouchStatsRow, createEntityTouchStatsRepository } from "../../db/repositories/entity-touch-stats";
import type { DB, EntitiesTable } from "../../db/schema";
import { type EntityProfileFacts, mapSourceTypeToEntityType } from "../../entities/profile-facts";

type EntityRow = Selectable<EntitiesTable>;
export type ContactPointRow = Awaited<
  ReturnType<ReturnType<typeof createEntityRepository>["getContactPointsForEntity"]>
>[number];

interface ActivityStats {
  fileCount: number;
  distinctDays: number;
  topCoAttendees: string[];
}

export interface EntityProfileCard {
  entity: {
    id: string;
    name: string;
    nameStatus: string;
    proposedName: string | null;
    sourceType: string;
    subtype: string | null;
    aliases: string[];
    contactPoints: ReturnType<typeof serializeContactPoint>[];
    metadata: Record<string, unknown> | null;
    status: string;
    hotness: number;
    shareWithEveryone: boolean;
    manualShares: Array<{ email: string; grantedAt: string }>;
    createdAt: string;
    updatedAt: string;
    profile: {
      entityType: string;
      mentionCount: number;
      sourceCounts: Record<string, number>;
      firstSeenAt: string | null;
      lastSeenAt: string | null;
      domainsForCompany: Array<{ domain: string; confidence: number; isPrimary: boolean }>;
      crmActivityBrief: EntityCrmActivityBrief | null;
      touchStats: EntityTouchStatsView | null;
      summary: { identity: string; activity: string };
    };
  };
  sourceRefs: Array<{
    id: string;
    source: string;
    sourceId: string;
    sourceUrl: string | null;
    lastSeenAt: string | null;
  }>;
}

export function serializeContactPoint(row: ContactPointRow) {
  return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    label: row.label,
    isPrimary: row.is_primary === 1,
    provenance: row.source === "manual" ? "declared" : "inferred",
    source: row.source,
    verifiedAt: row.verified_at,
  };
}

export interface EntityTouchStatsView {
  lastTouchAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  touchCount30d: number;
  touchCount90d: number;
  sourceLastTouch: Record<string, string>;
  computedAt: string;
}

function serializeTouchStats(row: EntityTouchStatsRow): EntityTouchStatsView {
  return {
    lastTouchAt: row.last_touch_at,
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at,
    touchCount30d: row.touch_count_30d,
    touchCount90d: row.touch_count_90d,
    sourceLastTouch: parseSourceLastTouch(row.source_last_touch),
    computedAt: row.computed_at,
  };
}

function parseSourceLastTouch(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export async function buildEntityProfileCard(
  db: Kysely<DB>,
  entity: EntityRow,
  viewer: FileViewer,
  opts: { includeCrmActivityBrief?: boolean; visibleRelationEntityIds?: ReadonlySet<string> } = {},
): Promise<EntityProfileCard> {
  const repo = createEntityRepository(db);
  const [sourceRefs, facts, manualShares, contactPoints, touchStats] = await Promise.all([
    db.selectFrom("entity_source_refs").selectAll().where("entity_id", "=", entity.id).execute(),
    loadEntityFactsForEntity(db, entity, viewer, {
      includeCrmActivityBrief: opts.includeCrmActivityBrief ?? true,
      visibleRelationEntityIds: opts.visibleRelationEntityIds,
    }),
    db
      .selectFrom("entity_share_emails")
      .select(["email", "granted_at"])
      .where("entity_id", "=", entity.id)
      .orderBy("granted_at", "desc")
      .execute(),
    repo.getContactPointsForEntity(entity.id),
    createEntityTouchStatsRepository(db).getForEntity(entity.id),
  ]);
  const activity = await loadActivityStats(db, entity.id, viewer);
  const summary = buildSummary(facts, activity);

  return {
    entity: {
      id: entity.id,
      name: entity.name,
      nameStatus: entity.name_status,
      proposedName: facts.proposedName,
      sourceType: entity.source_type,
      subtype: entity.subtype,
      aliases: entity.aliases ? (JSON.parse(entity.aliases) as string[]) : [],
      contactPoints: contactPoints.map(serializeContactPoint),
      metadata: facts.metadata,
      status: entity.status,
      hotness: entity.hotness,
      shareWithEveryone: entity.share_with_everyone === 1,
      manualShares: manualShares.map((s) => ({ email: s.email, grantedAt: s.granted_at })),
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
      profile: {
        entityType: facts.entityType,
        mentionCount: facts.mentionCount,
        sourceCounts: facts.sourceCounts,
        firstSeenAt: facts.firstSeenAt,
        lastSeenAt: facts.lastSeenAt,
        domainsForCompany: facts.domainsForCompany,
        crmActivityBrief: facts.crmActivityBrief,
        touchStats: touchStats ? serializeTouchStats(touchStats) : null,
        summary,
      },
    },
    sourceRefs: sourceRefs.map((r) => ({
      id: r.id,
      source: r.source,
      sourceId: r.source_id,
      sourceUrl: r.source_url,
      lastSeenAt: r.last_seen_at,
    })),
  };
}

async function loadEntityFactsForEntity(
  db: Kysely<DB>,
  entity: EntityRow,
  viewer: FileViewer,
  opts: { includeCrmActivityBrief: boolean; visibleRelationEntityIds?: ReadonlySet<string> },
): Promise<EntityProfileFacts> {
  const repo = createEntityRepository(db);
  const relRepo = createEntityRelationshipsRepository(db);
  const [aggregates, relations, proposals] = await Promise.all([
    repo.getEntityProfileAggregates(entity.id, viewer),
    relRepo.listRelationsForEntity(entity.id, { limit: 50 }),
    listPendingNameProposalsByEntity(db, [entity.id]),
  ]);
  const visibleIds = opts.visibleRelationEntityIds;
  const visibleOutgoing = visibleIds
    ? relations.outgoing.filter((relation) => visibleIds.has(relation.other.id))
    : relations.outgoing;
  const visibleIncoming = visibleIds
    ? relations.incoming.filter((relation) => visibleIds.has(relation.other.id))
    : relations.incoming;
  const parsedMetadata = entity.metadata ? (JSON.parse(entity.metadata) as Record<string, unknown>) : null;
  const topRelationships = [...visibleOutgoing, ...visibleIncoming].sort(relationCompare).slice(0, 10);
  return {
    entityId: entity.id,
    name: entity.name,
    nameStatus: entity.name_status,
    proposedName: proposals.get(entity.id) ?? null,
    sourceType: entity.source_type,
    entityType: mapSourceTypeToEntityType(entity.source_type),
    metadata: parsedMetadata,
    mentionCount: aggregates.mentionCount,
    sourceCounts: aggregates.sourceCounts,
    firstSeenAt: aggregates.firstSeenAt,
    lastSeenAt: aggregates.lastSeenAt,
    domainsForCompany: aggregates.domainsForCompany,
    crmActivityBrief: opts.includeCrmActivityBrief ? aggregates.crmActivityBrief : null,
    topRelationships,
    incomingCounts: countByType(visibleIncoming),
    outgoingCounts: countByType(visibleOutgoing),
  };
}

function countByType(rows: RelationListEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.relationshipType] = (out[r.relationshipType] ?? 0) + 1;
  }
  return out;
}

async function loadActivityStats(db: Kysely<DB>, entityId: string, viewer: FileViewer): Promise<ActivityStats> {
  let fileQuery = db
    .selectFrom("entity_mentions")
    .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
    .select([
      sql<number>`COUNT(DISTINCT entity_mentions.indexed_file_id)`.as("file_count"),
      sql<number>`COUNT(DISTINCT substr(
        COALESCE(indexed_files.source_updated_at, indexed_files.source_created_at, entity_mentions.mentioned_at),
        1,
        10
      ))`.as("distinct_days"),
    ])
    .where("entity_mentions.entity_id", "=", entityId);
  if (!viewer.isAdmin) {
    fileQuery = fileQuery.where(fileVisibilityPredicate(viewer));
  }
  const fileRow = await fileQuery.executeTakeFirst();

  let coAttendeeQuery = db
    .selectFrom("entity_mentions as em1")
    .innerJoin("indexed_files", "indexed_files.id", "em1.indexed_file_id")
    .innerJoin("entity_mentions as em2", (join) =>
      join.onRef("em2.indexed_file_id", "=", "em1.indexed_file_id").on(sql`em2.entity_id <> em1.entity_id`),
    )
    .innerJoin("entities as e2", "e2.id", "em2.entity_id")
    .select(["e2.id as id", "e2.name as name", sql<number>`COUNT(DISTINCT em1.indexed_file_id)`.as("files")])
    .where("em1.entity_id", "=", entityId)
    .where("e2.source_type", "=", "person")
    .where(whereLiveEntity("e2"))
    .groupBy(["e2.id", "e2.name"])
    .orderBy("files", "desc")
    .limit(3);
  if (!viewer.isAdmin) {
    coAttendeeQuery = coAttendeeQuery.where(fileVisibilityPredicate(viewer));
  }
  const coAttendeeRows = await coAttendeeQuery.execute();

  return {
    fileCount: Number(fileRow?.file_count ?? 0),
    distinctDays: Number(fileRow?.distinct_days ?? 0),
    topCoAttendees: coAttendeeRows.map((r) => r.name),
  };
}

function buildSummary(facts: EntityProfileFacts, activity: ActivityStats): { identity: string; activity: string } {
  const identity = buildIdentitySentence(facts);
  const activitySentence = buildActivitySentence(facts, activity);
  return { identity, activity: activitySentence };
}

function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function buildIdentitySentence(facts: EntityProfileFacts): string {
  const typeWord = formatEntityType(facts.entityType, facts.sourceType);
  const email = typeof facts.metadata?.email === "string" ? facts.metadata.email : null;
  const role = typeof facts.metadata?.role === "string" ? facts.metadata.role : null;
  const outgoing = facts.topRelationships.filter((r) => r.sourceEntityId === facts.entityId);
  const employers = uniqueNames(outgoing.filter((r) => r.relationshipType === "works_at").map((r) => r.other.name));
  const clients = uniqueNames(outgoing.filter((r) => r.relationshipType === "engaged_with").map((r) => r.other.name));

  const parts: string[] = [typeWord];

  if (facts.entityType === "person") {
    if (role) parts.push(role);
    if (employers.length > 0) parts.push(`works at ${joinList(employers)}`);
    if (email) parts.push(`(${email})`);
  } else if (facts.entityType === "company") {
    const primary = facts.domainsForCompany.find((d) => d.isPrimary)?.domain;
    const others = facts.domainsForCompany.filter((d) => !d.isPrimary).map((d) => d.domain);
    if (primary) parts.push(primary);
    if (others.length > 0) parts.push(`also: ${joinList(others.slice(0, 3))}`);
  }

  let sentence = parts.join(" · ");
  if (sentence.length > 0) sentence = `${sentence}.`;

  if (facts.entityType === "person" && clients.length > 0) {
    sentence = `${sentence} Engaged with ${joinList(clients.slice(0, 4))}.`;
  }

  return sentence;
}

function buildActivitySentence(facts: EntityProfileFacts, activity: ActivityStats): string {
  const pieces: string[] = [];
  if (activity.fileCount > 0) {
    const fileTerm = pluralize(activity.fileCount, "file");
    const mentionsTerm = pluralize(facts.mentionCount, "mention");
    if (activity.distinctDays > 0) {
      pieces.push(`Active in ${fileTerm} (${mentionsTerm}) across ${pluralize(activity.distinctDays, "day")}`);
    } else {
      pieces.push(`Active in ${fileTerm} (${mentionsTerm})`);
    }
  }
  if (facts.entityType === "person" && activity.topCoAttendees.length > 0) {
    pieces.push(`most-frequent collaborators: ${joinList(activity.topCoAttendees)}`);
  }
  if (pieces.length === 0) return "";
  return `${pieces.join(". ")}.`;
}

function formatEntityType(entityType: string, sourceType: string): string {
  switch (entityType) {
    case "person":
      return "Person";
    case "company":
      return "Company";
    case "product":
      return "Product";
    case "project":
      return "Project";
    case "team":
      return "Team";
    case "system":
      return capitalize(sourceType);
    default:
      return capitalize(sourceType);
  }
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

const CONFIDENCE_ORDER: Record<string, number> = { CONFIRMED: -1, AMBIGUOUS: 0, EXTRACTED: 1, INFERRED: 2 };

function relationCompare(a: RelationListEntry, b: RelationListEntry): number {
  const ac = CONFIDENCE_ORDER[a.confidence] ?? 3;
  const bc = CONFIDENCE_ORDER[b.confidence] ?? 3;
  if (ac !== bc) return ac - bc;
  if (a.evidenceCount !== b.evidenceCount) return b.evidenceCount - a.evidenceCount;
  if (a.confidenceScore !== b.confidenceScore) return b.confidenceScore - a.confidenceScore;
  const byName = a.other.name.localeCompare(b.other.name);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}
