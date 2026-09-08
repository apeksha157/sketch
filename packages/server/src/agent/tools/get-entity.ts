import type { Kysely } from "kysely";
import { sql } from "kysely";
import { z } from "zod/v4";
import { resolveContentPrincipals } from "../../access/principals";
import { buildEntityProfileCard } from "../../api/entities/profile-card";
import { idInList } from "../../connectors/id-in-list";
import { SEARCHABLE_SOURCES } from "../../connectors/search";
import type { AccessPrincipal } from "../../connectors/types";
import type { FileViewer } from "../../db/repositories/connectors";
import { createEntityRepository } from "../../db/repositories/entities";
import {
  type RelationListEntry,
  createEntityRelationshipsRepository,
} from "../../db/repositories/entity-relationships";
import {
  type TimelineCursor,
  type TimelinePageItem,
  createEntityTimelineRepository,
} from "../../db/repositories/entity-timeline";
import type { DB } from "../../db/schema";
import { contentPrincipalDeps, viewerForPrincipals, visibleEntityIdsForPublic } from "./entity-visibility";
import type { SketchMcpDeps, ToolResult } from "./types";

const entitySectionSchema = z.enum(["identity", "relations", "timeline"]);

export const getEntityToolDescription = [
  "Get one entity as structured JSON: identity/profile card, visible relations, and a paged chronological timeline.",
  "Prefer this over sketch_get_entity_context when you need file IDs, relation IDs, company/person rollups, " +
    "or content inline with timeline items.",
].join("\n\n");

export const getEntityToolSchema = {
  entityId: z.string().describe("Entity ID from sketch_search_entities."),
  sections: z
    .array(entitySectionSchema)
    .optional()
    .describe("Sections to include. Defaults to identity, relations, timeline."),
  relationsLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max relation entries per direction. Default 20."),
  timeline: z
    .object({
      limit: z.number().int().min(1).max(100).optional().describe("Max timeline items. Default 30."),
      cursor: z.string().optional().describe("Opaque cursor from timeline.nextCursor."),
      after: z.string().optional().describe("Only timeline items with occurredAt >= this ISO timestamp."),
      before: z.string().optional().describe("Only timeline items with occurredAt < this ISO timestamp."),
      sources: z.array(z.enum(SEARCHABLE_SOURCES)).optional().describe("Only these indexed sources."),
      fileTypes: z.array(z.string()).optional().describe("Only these indexed_files.file_type values."),
      includePeople: z
        .boolean()
        .optional()
        .describe("For company entities, fold current incoming works_at people into the timeline."),
      includeContent: z.boolean().optional().describe("Inline indexed file content on timeline items."),
      maxCharsPerItem: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe("Max inlined content characters per timeline item. Default 1500; only used with includeContent."),
    })
    .optional(),
};

export type GetEntityArgs = z.infer<z.ZodObject<typeof getEntityToolSchema>>;

type RelationDirection = "outgoing" | "incoming";

interface PublicRelationEntry {
  type: string;
  direction: RelationDirection;
  other: { id: string; name: string; sourceType: string };
  confidence: string;
  confidenceScore: number;
  evidenceCount: number;
  validTo: string | null;
}

function requestedSections(sections: GetEntityArgs["sections"]): Set<"identity" | "relations" | "timeline"> {
  return new Set(sections ?? ["identity", "relations", "timeline"]);
}

function decodeCursor(cursor: string | undefined): TimelineCursor | undefined {
  if (!cursor) return undefined;
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<TimelineCursor>;
  if (typeof parsed.occurredAt !== "string" || typeof parsed.fileId !== "string") {
    throw new Error("invalid cursor");
  }
  return { occurredAt: parsed.occurredAt, fileId: parsed.fileId };
}

function encodeCursor(cursor: TimelineCursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null;
}

function notFound(entityId: string): ToolResult {
  return { content: [{ type: "text", text: `Entity ${entityId} not found.` }] };
}

function serializeEntity(card: Awaited<ReturnType<typeof buildEntityProfileCard>>, includeCrmActivityBrief: boolean) {
  return {
    id: card.entity.id,
    name: card.entity.name,
    sourceType: card.entity.sourceType,
    subtype: card.entity.subtype,
    status: card.entity.status,
    aliases: card.entity.aliases,
    contactPoints: card.entity.contactPoints.map((point) => ({
      kind: point.kind,
      value: point.value,
      isPrimary: point.isPrimary,
      provenance: point.provenance,
      source: point.source,
    })),
    sourceRefs: card.sourceRefs.map((ref) => ({
      source: ref.source,
      sourceId: ref.sourceId,
      sourceUrl: ref.sourceUrl,
    })),
    profile: {
      mentionCount: card.entity.profile.mentionCount,
      sourceCounts: card.entity.profile.sourceCounts,
      firstSeenAt: card.entity.profile.firstSeenAt,
      lastSeenAt: card.entity.profile.lastSeenAt,
      domains: card.entity.profile.domainsForCompany.map((domain) => ({
        domain: domain.domain,
        isPrimary: domain.isPrimary,
      })),
      ...(includeCrmActivityBrief ? { crmActivityBrief: card.entity.profile.crmActivityBrief } : {}),
      summary: card.entity.profile.summary,
    },
  };
}

function serializeRelation(relation: RelationListEntry, direction: RelationDirection): PublicRelationEntry {
  return {
    type: relation.relationshipType,
    direction,
    other: {
      id: relation.other.id,
      name: relation.other.name,
      sourceType: relation.other.sourceType,
    },
    confidence: relation.confidence,
    confidenceScore: relation.confidenceScore,
    evidenceCount: relation.evidenceCount,
    validTo: relation.validTo,
  };
}

function capRelationsForOutput(
  relations: { outgoing: RelationListEntry[]; incoming: RelationListEntry[]; truncated: boolean },
  limit: number,
) {
  return {
    outgoing: relations.outgoing.slice(0, limit),
    incoming: relations.incoming.slice(0, limit),
    truncated: relations.truncated || relations.outgoing.length > limit || relations.incoming.length > limit,
  };
}

async function filterRelationsForPublic(
  deps: SketchMcpDeps,
  relations: { outgoing: RelationListEntry[]; incoming: RelationListEntry[]; truncated: boolean },
  principals: AccessPrincipal[] | undefined,
): Promise<{ outgoing: PublicRelationEntry[]; incoming: PublicRelationEntry[]; truncated: boolean }> {
  if (!deps.publicMcp?.filterEntityMetadata) {
    return {
      outgoing: relations.outgoing.map((relation) => serializeRelation(relation, "outgoing")),
      incoming: relations.incoming.map((relation) => serializeRelation(relation, "incoming")),
      truncated: relations.truncated,
    };
  }
  const visibleIds = await visibleEntityIdsForPublic(
    deps,
    [...relations.outgoing, ...relations.incoming].map((relation) => ({ id: relation.other.id })),
    principals,
  );
  return {
    outgoing: relations.outgoing
      .filter((relation) => visibleIds.has(relation.other.id))
      .map((relation) => serializeRelation(relation, "outgoing")),
    incoming: relations.incoming
      .filter((relation) => visibleIds.has(relation.other.id))
      .map((relation) => serializeRelation(relation, "incoming")),
    truncated: relations.truncated,
  };
}

function serializeTimelineItem(item: TimelinePageItem) {
  return {
    fileId: item.fileId,
    fileName: item.fileName,
    fileType: item.fileType,
    contentCategory: item.contentCategory,
    sourceType: item.sourceType,
    occurredAt: item.occurredAt,
    mentionConfidence: item.mentionConfidence,
    mentionCount: item.mentionCount,
    relations: item.relations,
    contextSnippet: item.contextSnippet,
    url: item.url,
    rollupGroupId: item.rollupGroupId,
    crmActivity: item.crmActivity,
    viaEntityIds: item.viaEntityIds,
  };
}

async function loadTimelineContent(
  db: Kysely<DB>,
  items: ReturnType<typeof serializeTimelineItem>[],
  opts: { maxCharsPerItem: number; maxTotalChars: number },
): Promise<{ contentTruncated: boolean }> {
  const fileIds = items.map((item) => item.fileId);
  if (fileIds.length === 0) return { contentTruncated: false };
  const rows = await db
    .selectFrom("indexed_files")
    .select(["id", "content", "summary"])
    .where(idInList(db, sql.ref("indexed_files.id"), fileIds))
    .execute();
  const contentByFile = new Map(rows.map((row) => [row.id, row.content ?? row.summary ?? ""]));
  let used = 0;
  let contentTruncated = false;

  for (const item of items) {
    if (used >= opts.maxTotalChars) {
      contentTruncated = true;
      continue;
    }
    const content = contentByFile.get(item.fileId) ?? "";
    const perItemCut = content.slice(0, opts.maxCharsPerItem);
    const available = opts.maxTotalChars - used;
    const output = perItemCut.slice(0, available);
    used += output.length;
    Object.assign(item, {
      content: output,
      contentTruncated: content.length > output.length,
    });
    if (content.length > output.length) contentTruncated = true;
  }

  return { contentTruncated };
}

export async function handleGetEntity(args: GetEntityArgs, deps: SketchMcpDeps): Promise<ToolResult> {
  if (!deps.db) {
    return { content: [{ type: "text", text: "Entity lookup not available." }] };
  }

  const sections = requestedSections(args.sections);
  const principals = await resolveContentPrincipals(contentPrincipalDeps(deps));
  if (principals !== undefined && principals.length === 0) return notFound(args.entityId);

  const visibleTopLevelIds = await visibleEntityIdsForPublic(deps, [{ id: args.entityId }], principals);
  if (!visibleTopLevelIds.has(args.entityId)) return notFound(args.entityId);

  const slackEntitySyncEnabled = deps.slackEntitySyncEnabled ?? true;
  const viewer = viewerForPrincipals(principals, slackEntitySyncEnabled);
  const entityRepo = createEntityRepository(deps.db);
  const entity = await entityRepo.getEntity(args.entityId, viewer);
  if (!entity) return notFound(args.entityId);

  const timelineArgs = args.timeline ?? {};
  const relationsLimit = args.relationsLimit ?? 20;
  const needsRelationsForPeople =
    sections.has("timeline") && timelineArgs.includePeople === true && entity.source_type === "company";
  const needsRelationsForProfile =
    sections.has("identity") && principals !== undefined && deps.publicMcp?.filterEntityMetadata === true;
  const relationRepo = createEntityRelationshipsRepository(deps.db);
  const relationRows =
    sections.has("relations") || needsRelationsForPeople || needsRelationsForProfile
      ? await relationRepo.listRelationsForEntity(entity.id, {
          limit: needsRelationsForPeople || needsRelationsForProfile ? Math.max(relationsLimit, 50) : relationsLimit,
        })
      : null;
  const visibleProfileRelationIds =
    needsRelationsForProfile && relationRows
      ? await visibleEntityIdsForPublic(
          deps,
          [...relationRows.outgoing, ...relationRows.incoming].map((relation) => ({ id: relation.other.id })),
          principals,
        )
      : undefined;

  const response: Record<string, unknown> = {};
  if (sections.has("identity")) {
    const card = await buildEntityProfileCard(deps.db, entity, viewer, {
      includeCrmActivityBrief: principals === undefined,
      visibleRelationEntityIds: visibleProfileRelationIds,
    });
    response.entity = serializeEntity(card, principals === undefined);
  }

  if (sections.has("relations") && relationRows) {
    response.relations = await filterRelationsForPublic(
      deps,
      capRelationsForOutput(relationRows, relationsLimit),
      principals,
    );
  }

  if (sections.has("timeline")) {
    let entityIds = [entity.id];
    if (needsRelationsForPeople && relationRows) {
      const visiblePeople = await visibleEntityIdsForPublic(
        deps,
        relationRows.incoming
          .filter((relation) => relation.relationshipType === "works_at" && relation.validTo === null)
          .map((relation) => ({ id: relation.other.id })),
        principals,
      );
      entityIds = [
        entity.id,
        ...relationRows.incoming
          .filter(
            (relation) =>
              relation.relationshipType === "works_at" &&
              relation.validTo === null &&
              visiblePeople.has(relation.other.id),
          )
          .slice(0, 50)
          .map((relation) => relation.other.id),
      ];
    }

    let cursor: TimelineCursor | undefined;
    try {
      cursor = decodeCursor(timelineArgs.cursor);
    } catch {
      return { content: [{ type: "text", text: "Invalid timeline cursor." }], isError: true };
    }

    const page = await createEntityTimelineRepository(deps.db).listTimelinePage({
      entityIds,
      limit: timelineArgs.limit ?? 30,
      cursor,
      after: timelineArgs.after,
      before: timelineArgs.before,
      sources: timelineArgs.sources,
      fileTypes: timelineArgs.fileTypes,
      visibility: principals === undefined ? undefined : { principals, slackEntitySyncEnabled },
    });
    const items = page.items.map(serializeTimelineItem);
    const timeline: Record<string, unknown> = {
      items,
      nextCursor: encodeCursor(page.nextCursor),
      entityIds,
    };
    if (timelineArgs.includeContent === true) {
      const contentResult = await loadTimelineContent(deps.db, items, {
        maxCharsPerItem: timelineArgs.maxCharsPerItem ?? 1500,
        maxTotalChars: deps.publicMcp?.maxFileContentChars ?? 50_000,
      });
      if (contentResult.contentTruncated) timeline.contentTruncated = true;
    }
    response.timeline = timeline;
  }

  return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
}
