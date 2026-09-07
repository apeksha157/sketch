/**
 * Entity-timeline: file mentions of a single entity, ordered newest-first,
 * one row per file (multiple mentions on the same file collapse). Caller
 * groups by month in TypeScript — we keep the query dialect-portable.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { idInList } from "../../connectors/id-in-list";
import type { AccessPrincipal } from "../../connectors/types";
import type { DB } from "../schema";
import { type FileViewer, viewerPrincipals } from "./connectors";
import { fileVisibilityRuleSql } from "./file-visibility-rule";

export interface TimelineItem {
  fileId: string;
  fileName: string;
  fileType: string | null;
  contentCategory: string;
  sourceType: string;
  occurredAt: string;
  mentionConfidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  mentionCount: number;
  relations: string[];
  contextSnippet: string | null;
  url: string | null;
  rollupGroupId: string | null;
  crmActivity: CrmTimelineActivity | null;
}

export interface TimelineGroup {
  month: string;
  items: TimelineItem[];
}

export interface TimelineCursor {
  occurredAt: string;
  fileId: string;
}

export type TimelinePageItem = TimelineItem & { viaEntityIds: string[] };

export interface CrmTimelineActivity {
  activityType: "task" | "call" | "event" | "meeting" | "note";
  hasBody: boolean;
}

const CONFIDENCE_ORDER: Record<string, number> = { EXTRACTED: 0, INFERRED: 1, AMBIGUOUS: 2 };
/**
 * Record-type files describe a person or company rather than something that
 * happened. They still feed the drawer header and search, but on the timeline
 * they would sit as a dated row at the source's last activity — a duplicate
 * of the newest exchange that moves on every sync.
 *
 * The exclusion predicate must allow NULL explicitly: `file_type` is nullable
 * and `NULL NOT IN (...)` is NULL on both dialects, so a bare NOT IN would
 * silently drop every untyped file.
 */
const RECORD_FILE_TYPES = ["linkedin_profile"];
const CRM_ACTIVITY_TYPES: Record<string, CrmTimelineActivity["activityType"]> = {
  crm_task: "task",
  crm_call: "call",
  crm_event: "event",
  crm_meeting: "meeting",
  crm_note: "note",
};

function normalizeConfidence(value: string): TimelineItem["mentionConfidence"] {
  return value === "EXTRACTED" || value === "INFERRED" || value === "AMBIGUOUS" ? value : "AMBIGUOUS";
}

function monthKey(iso: string): string {
  // Parse the ISO timestamp's date portion directly; avoids Date-object
  // timezone surprises across SQLite/Postgres returned strings.
  const match = iso.match(/^(\d{4})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function crmActivityFor(fileType: string | null, contentCategory: string): CrmTimelineActivity | null {
  if (!fileType) return null;
  const activityType = CRM_ACTIVITY_TYPES[fileType];
  if (!activityType) return null;
  return { activityType, hasBody: contentCategory === "document" };
}

export function createEntityTimelineRepository(db: Kysely<DB>) {
  async function listTimelinePage(opts: {
    entityIds: string[];
    limit: number;
    cursor?: TimelineCursor;
    after?: string;
    before?: string;
    sources?: string[];
    fileTypes?: string[];
    visibility?: { principals: AccessPrincipal[]; slackEntitySyncEnabled: boolean; archived?: "include" | "exclude" };
  }): Promise<{ items: TimelinePageItem[]; nextCursor: TimelineCursor | null }> {
    const entityIds = [...new Set(opts.entityIds)].filter(Boolean);
    if (entityIds.length === 0 || opts.limit <= 0) return { items: [], nextCursor: null };

    const occurredAtExpr = sql<string>`COALESCE(
      indexed_files.source_updated_at,
      indexed_files.source_created_at,
      MAX(entity_mentions.mentioned_at)
    )`;
    let groupedFilesQuery = db
      .selectFrom("entity_mentions")
      .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
      .select(["indexed_files.id as file_id", occurredAtExpr.as("occurred_at")])
      .where(idInList(db, sql.ref("entity_mentions.entity_id"), entityIds))
      .groupBy(["indexed_files.id", "indexed_files.source_updated_at", "indexed_files.source_created_at"]);

    if (opts.sources && opts.sources.length > 0) {
      groupedFilesQuery = groupedFilesQuery.where("indexed_files.source", "in", opts.sources);
    }
    if (opts.fileTypes && opts.fileTypes.length > 0) {
      groupedFilesQuery = groupedFilesQuery.where("indexed_files.file_type", "in", opts.fileTypes);
    } else {
      groupedFilesQuery = groupedFilesQuery.where((eb) =>
        eb.or([eb("indexed_files.file_type", "is", null), eb("indexed_files.file_type", "not in", RECORD_FILE_TYPES)]),
      );
    }
    if (opts.visibility) {
      groupedFilesQuery = groupedFilesQuery.where(
        fileVisibilityRuleSql({
          principals: opts.visibility.principals,
          slackEntitySyncEnabled: opts.visibility.slackEntitySyncEnabled,
          archived: opts.visibility.archived ?? "exclude",
          alias: "indexed_files",
        }),
      );
    }

    const groupedFiles = groupedFilesQuery.as("timeline_files");
    let pageQuery = db.selectFrom(groupedFiles).select(["file_id", "occurred_at"]);
    if (opts.after) pageQuery = pageQuery.where("occurred_at", ">=", opts.after);
    if (opts.before) pageQuery = pageQuery.where("occurred_at", "<", opts.before);
    if (opts.cursor) {
      pageQuery = pageQuery.where((eb) =>
        eb.or([
          eb("occurred_at", "<", opts.cursor?.occurredAt ?? ""),
          eb.and([
            eb("occurred_at", "=", opts.cursor?.occurredAt ?? ""),
            eb("file_id", "<", opts.cursor?.fileId ?? ""),
          ]),
        ]),
      );
    }

    const fileRows = await pageQuery
      .orderBy("occurred_at", "desc")
      .orderBy("file_id", "desc")
      .limit(opts.limit + 1)
      .execute();
    const pageFileRows = fileRows.slice(0, opts.limit);
    const fileIds = pageFileRows.map((row) => row.file_id);
    if (fileIds.length === 0) return { items: [], nextCursor: null };

    const mentionRows = await db
      .selectFrom("entity_mentions")
      .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
      .select([
        "indexed_files.id as file_id",
        "indexed_files.file_name",
        "indexed_files.file_type",
        "indexed_files.content_category",
        "indexed_files.source as file_source",
        "indexed_files.provider_url",
        "indexed_files.rollup_group_id",
        "entity_mentions.entity_id",
        "entity_mentions.confidence",
        "entity_mentions.relation",
        "entity_mentions.context_snippet",
      ])
      .where(idInList(db, sql.ref("indexed_files.id"), fileIds))
      .where(idInList(db, sql.ref("entity_mentions.entity_id"), entityIds))
      .execute();

    const occurredAtByFile = new Map(pageFileRows.map((row) => [row.file_id, row.occurred_at]));
    const byFile = new Map<string, TimelinePageItem>();
    for (const row of mentionRows) {
      const occurredAt = occurredAtByFile.get(row.file_id);
      if (!occurredAt) continue;
      const existing = byFile.get(row.file_id);
      if (existing) {
        existing.mentionCount += 1;
        addTimelineRelation(existing, row.relation);
        if (!existing.viaEntityIds.includes(row.entity_id)) existing.viaEntityIds.push(row.entity_id);
        const inboundRank = CONFIDENCE_ORDER[row.confidence] ?? 3;
        const existingRank = CONFIDENCE_ORDER[existing.mentionConfidence] ?? 3;
        if (inboundRank < existingRank) existing.mentionConfidence = normalizeConfidence(row.confidence);
        if (!existing.contextSnippet && row.context_snippet) existing.contextSnippet = row.context_snippet;
        continue;
      }
      byFile.set(row.file_id, {
        fileId: row.file_id,
        fileName: row.file_name,
        fileType: row.file_type,
        contentCategory: row.content_category,
        sourceType: row.file_source,
        occurredAt,
        mentionConfidence: normalizeConfidence(row.confidence),
        mentionCount: 1,
        relations: relationListFor(row.relation),
        contextSnippet: row.context_snippet ?? null,
        url: row.provider_url ?? null,
        rollupGroupId: row.rollup_group_id ?? null,
        crmActivity: crmActivityFor(row.file_type, row.content_category),
        viaEntityIds: [row.entity_id],
      });
    }

    const items = fileIds.flatMap((fileId) => {
      const item = byFile.get(fileId);
      if (!item) return [];
      item.viaEntityIds.sort();
      return [item];
    });
    const lastReturned = pageFileRows.at(-1);
    return {
      items,
      nextCursor:
        fileRows.length > opts.limit && lastReturned
          ? { occurredAt: lastReturned.occurred_at, fileId: lastReturned.file_id }
          : null,
    };
  }

  return {
    listTimelinePage,

    /**
     * List timeline rows for an entity, with file RBAC. Collapses per-file
     * mentions into one TimelineItem per file (mentionCount = count of
     * mentions on that file). Sorted newest-first. Keeps archived files
     * visible, as the web drawer always has; the public MCP page excludes them.
     */
    async listTimelineForEntity(
      entityId: string,
      opts: { limit: number; viewer: FileViewer },
    ): Promise<{ groups: TimelineGroup[]; truncated: boolean; totalCount: number }> {
      const { limit, viewer } = opts;
      const page = await listTimelinePage({
        entityIds: [entityId],
        limit,
        visibility: viewer.isAdmin
          ? undefined
          : {
              principals: viewerPrincipals(viewer),
              slackEntitySyncEnabled: viewer.slackEntitySyncEnabled ?? true,
              archived: "include",
            },
      });

      const groupsMap = new Map<string, TimelineItem[]>();
      for (const item of page.items) {
        const key = monthKey(item.occurredAt);
        const bucket = groupsMap.get(key);
        if (bucket) bucket.push(item);
        else groupsMap.set(key, [item]);
      }
      const groups: TimelineGroup[] = Array.from(groupsMap.entries())
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([month, items]) => ({ month, items }));

      return { groups, truncated: page.nextCursor !== null, totalCount: page.items.length };
    },
  };
}

function relationListFor(relation: string): string[] {
  return relation === "mentioned" ? ["mentioned"] : [relation];
}

function addTimelineRelation(item: TimelineItem, relation: string): void {
  if (item.relations.includes(relation)) return;
  if (relation === "mentioned") item.relations.push(relation);
  else {
    const insertionIndex = item.relations.includes("mentioned") ? item.relations.length - 1 : item.relations.length;
    item.relations.splice(insertionIndex, 0, relation);
  }
}
