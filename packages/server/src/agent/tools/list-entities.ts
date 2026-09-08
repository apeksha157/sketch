import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { z } from "zod/v4";
import { resolveContentPrincipals } from "../../access/principals";
import { idInList } from "../../connectors/id-in-list";
import type { AccessPrincipal } from "../../connectors/types";
import type { FileViewer } from "../../db/repositories/connectors";
import { entityVisibilityPredicate, whereLiveEntity } from "../../db/repositories/entities";
import {
  type EntityTouchStatsListRow,
  type ListEntitiesCursor,
  createEntityTouchStatsRepository,
} from "../../db/repositories/entity-touch-stats";
import type { DB } from "../../db/schema";
import { contentPrincipalDeps, viewerForPrincipals } from "./entity-visibility";
import type { SketchMcpDeps, ToolResult } from "./types";

const entityTypeSchema = z.enum(["person", "company", "project"]);
const entityStatusSchema = z.enum(["confirmed", "proposed"]);
const listEntitiesSortBySchema = z.enum(["lastTouch", "lastInbound", "touches90d", "hotness", "name"]);

export const listEntitiesToolDescription = [
  "List entities as a segment query over CRM/entity activity.",
  "Admins with admin_can_read_all_files can filter by recent touch activity, awaiting replies, " +
    "touch counts, and hotness.",
  "Restricted viewers get only visible entities sorted by name, with aggregate activity and hotness hidden.",
].join("\n\n");

export const listEntitiesToolSchema = {
  type: z.array(entityTypeSchema).optional().describe("Filter by entity type: person, company, or project."),
  status: entityStatusSchema.optional().describe("Filter by entity status. Defaults to confirmed."),
  lastTouchAfter: z.string().optional().describe("Only entities last touched after this ISO timestamp."),
  lastTouchBefore: z.string().optional().describe("Only entities last touched before this ISO timestamp."),
  lastInboundAfter: z.string().optional().describe("Only entities with inbound activity after this ISO timestamp."),
  lastInboundBefore: z.string().optional().describe("Only entities with inbound activity before this ISO timestamp."),
  minTouches90d: z.number().int().min(0).optional().describe("Minimum touch count in the last 90 days."),
  minTouches30d: z.number().int().min(0).optional().describe("Minimum touch count in the last 30 days."),
  awaitingReply: z.boolean().optional().describe("Only entities whose latest inbound touch is after latest outbound."),
  sortBy: listEntitiesSortBySchema
    .optional()
    .describe("Sort key. Defaults to lastTouch for admins and name otherwise."),
  limit: z.number().int().min(1).max(100).optional().describe("Maximum entities to return. Default 30."),
  cursor: z.string().optional().describe("Opaque cursor from list_entities.nextCursor."),
};

export type ListEntitiesArgs = z.infer<z.ZodObject<typeof listEntitiesToolSchema>>;

interface CompanyForPerson {
  id: string;
  name: string;
}

function emptyPage(): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ entities: [], nextCursor: null }, null, 2) }] };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function decodeCursor(cursor: string | undefined): ListEntitiesCursor | undefined {
  if (!cursor) return undefined;
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<ListEntitiesCursor>;
  if (
    parsed.sortBy !== "lastTouch" &&
    parsed.sortBy !== "lastInbound" &&
    parsed.sortBy !== "touches90d" &&
    parsed.sortBy !== "hotness" &&
    parsed.sortBy !== "name"
  ) {
    throw new Error("invalid cursor");
  }
  if (typeof parsed.entityId !== "string") throw new Error("invalid cursor");
  if ((parsed.sortBy === "touches90d" || parsed.sortBy === "hotness") && typeof parsed.sortValue !== "number") {
    throw new Error("invalid cursor");
  }
  if (
    (parsed.sortBy === "lastTouch" || parsed.sortBy === "lastInbound" || parsed.sortBy === "name") &&
    typeof parsed.sortValue !== "string"
  ) {
    throw new Error("invalid cursor");
  }
  return parsed as ListEntitiesCursor;
}

function encodeCursor(cursor: ListEntitiesCursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null;
}

function hasAggregateFilter(args: ListEntitiesArgs): boolean {
  return (
    args.lastTouchAfter !== undefined ||
    args.lastTouchBefore !== undefined ||
    args.lastInboundAfter !== undefined ||
    args.lastInboundBefore !== undefined ||
    args.minTouches90d !== undefined ||
    args.minTouches30d !== undefined ||
    args.awaitingReply !== undefined
  );
}

function parseSourceLastTouch(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function lastMessageFrom(row: EntityTouchStatsListRow): "them" | "us" | null {
  if (!row.lastInboundAt && !row.lastOutboundAt) return null;
  if (row.lastInboundAt && (!row.lastOutboundAt || row.lastInboundAt > row.lastOutboundAt)) return "them";
  return "us";
}

async function companiesForPeople(
  db: Kysely<DB>,
  personIds: readonly string[],
  visibility?: ReturnType<typeof entityVisibilityPredicate>,
): Promise<Map<string, CompanyForPerson>> {
  if (personIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("entity_relationships")
    .innerJoin("entities as company", "company.id", "entity_relationships.target_entity_id")
    .select([
      "entity_relationships.source_entity_id as personId",
      "company.id as companyId",
      "company.name as companyName",
    ])
    .where(idInList(db, sql.ref("entity_relationships.source_entity_id"), personIds))
    .where("entity_relationships.relationship_type", "=", "works_at")
    .where("entity_relationships.valid_to", "is", null)
    .where("company.source_type", "=", "company")
    .where(whereLiveEntity("company"))
    .$if(Boolean(visibility), (qb) => qb.where(visibility as ReturnType<typeof entityVisibilityPredicate>))
    .orderBy("entity_relationships.source_entity_id", "asc")
    .orderBy("company.name", "asc")
    .execute();
  const result = new Map<string, CompanyForPerson>();
  for (const row of rows) {
    if (!result.has(row.personId)) result.set(row.personId, { id: row.companyId, name: row.companyName });
  }
  return result;
}

function serializeRow(row: EntityTouchStatsListRow, company: CompanyForPerson | null, includeAggregates: boolean) {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.sourceType,
    subtype: row.subtype,
    status: row.status,
    hotness: includeAggregates ? row.hotness : null,
    company,
    touchStats: includeAggregates
      ? {
          lastTouchAt: row.lastTouchAt,
          lastInboundAt: row.lastInboundAt,
          lastOutboundAt: row.lastOutboundAt,
          lastMessageFrom: lastMessageFrom(row),
          touchCount30d: row.touchCount30d ?? 0,
          touchCount90d: row.touchCount90d ?? 0,
          sourceLastTouch: parseSourceLastTouch(row.sourceLastTouch),
        }
      : null,
  };
}

export async function handleListEntities(args: ListEntitiesArgs, deps: SketchMcpDeps): Promise<ToolResult> {
  if (!deps.db) return { content: [{ type: "text", text: "Entity listing not available." }] };

  const principals = await resolveContentPrincipals(contentPrincipalDeps(deps));
  if (principals !== undefined && principals.length === 0) return emptyPage();

  const restricted = principals !== undefined;
  const sortBy = args.sortBy ?? (restricted ? "name" : "lastTouch");
  if (restricted && (sortBy !== "name" || hasAggregateFilter(args))) {
    return toolError("admin_can_read_all_files is required for aggregate entity filters and sorts.");
  }

  let cursor: ListEntitiesCursor | undefined;
  try {
    cursor = decodeCursor(args.cursor);
  } catch {
    return toolError("Invalid cursor.");
  }
  if (cursor && cursor.sortBy !== sortBy) return toolError("Cursor sortBy does not match the requested sortBy.");

  const slackEntitySyncEnabled = deps.slackEntitySyncEnabled ?? true;
  const viewer = viewerForPrincipals(principals, slackEntitySyncEnabled);
  const visibility = restricted ? entityVisibilityPredicate(viewer) : undefined;
  const page = await createEntityTouchStatsRepository(deps.db).list({
    sortBy,
    limit: args.limit ?? 30,
    cursor,
    visibility,
    where: {
      status: args.status ?? "confirmed",
      types: args.type,
      lastTouchAfter: args.lastTouchAfter,
      lastTouchBefore: args.lastTouchBefore,
      lastInboundAfter: args.lastInboundAfter,
      lastInboundBefore: args.lastInboundBefore,
      minTouches30d: args.minTouches30d,
      minTouches90d: args.minTouches90d,
      awaitingReply: args.awaitingReply,
    },
  });
  const companies = await companiesForPeople(
    deps.db,
    page.rows.filter((row) => row.sourceType === "person").map((row) => row.id),
    visibility ? entityVisibilityPredicate(viewer, "company") : undefined,
  );
  const response = {
    entities: page.rows.map((row) => serializeRow(row, companies.get(row.id) ?? null, !restricted)),
    nextCursor: encodeCursor(page.nextCursor),
  };
  return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
}

export function createListEntitiesTool(deps: SketchMcpDeps) {
  return tool("ListEntities", listEntitiesToolDescription, listEntitiesToolSchema, (args) =>
    handleListEntities(args, deps),
  );
}
