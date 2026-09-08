import type { Kysely, RawBuilder, Selectable } from "kysely";
import { sql } from "kysely";
import { idInList } from "../../connectors/id-in-list";
import type { DB, EntityTouchStatsTable } from "../schema";
import { whereLiveEntity } from "./entities";

export type EntityTouchStatsRow = Selectable<EntityTouchStatsTable>;

export type EntityListSortBy = "lastTouch" | "lastInbound" | "touches90d" | "hotness" | "name";

export type ListEntitiesCursor =
  | { sortBy: "lastTouch" | "lastInbound" | "name"; sortValue: string; entityId: string }
  | { sortBy: "touches90d" | "hotness"; sortValue: number; entityId: string };

export interface EntityTouchStatsListRow {
  id: string;
  name: string;
  sourceType: string;
  subtype: string | null;
  status: string;
  hotness: number;
  lastTouchAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  touchCount30d: number | null;
  touchCount90d: number | null;
  sourceLastTouch: string | null;
}

export interface ListEntityTouchStatsOptions {
  where?: {
    lastTouchBefore?: string;
    lastTouchAfter?: string;
    lastInboundBefore?: string;
    lastInboundAfter?: string;
    minTouches30d?: number;
    minTouches90d?: number;
    awaitingReply?: boolean;
    types?: readonly ("person" | "company" | "project")[];
    status?: "confirmed" | "proposed";
  };
  sortBy?: EntityListSortBy;
  limit?: number;
  cursor?: ListEntitiesCursor;
  visibility?: RawBuilder<boolean>;
}

export interface EntityTouchStatsListPage {
  rows: EntityTouchStatsListRow[];
  nextCursor: ListEntitiesCursor | null;
}

function coalescedTimestampColumn(sortBy: "lastTouch" | "lastInbound") {
  return sortBy === "lastTouch"
    ? sql<string>`COALESCE(entity_touch_stats.last_touch_at, '')`
    : sql<string>`COALESCE(entity_touch_stats.last_inbound_at, '')`;
}

function textSortColumn(sortBy: "lastTouch" | "lastInbound" | "name") {
  return sortBy === "name" ? sql<string>`entities.name` : coalescedTimestampColumn(sortBy);
}

function numericSortColumn(sortBy: "touches90d" | "hotness") {
  return sortBy === "hotness" ? sql<number>`entities.hotness` : sql<number>`entity_touch_stats.touch_count_90d`;
}

function cursorForRow(row: EntityTouchStatsListRow, sortBy: EntityListSortBy): ListEntitiesCursor {
  if (sortBy === "hotness") return { sortBy, sortValue: row.hotness, entityId: row.id };
  if (sortBy === "touches90d") return { sortBy, sortValue: row.touchCount90d ?? 0, entityId: row.id };
  if (sortBy === "lastTouch") return { sortBy, sortValue: row.lastTouchAt ?? "", entityId: row.id };
  if (sortBy === "lastInbound") return { sortBy, sortValue: row.lastInboundAt ?? "", entityId: row.id };
  return { sortBy, sortValue: row.name, entityId: row.id };
}

export function createEntityTouchStatsRepository(db: Kysely<DB>) {
  return {
    async getForEntity(entityId: string): Promise<EntityTouchStatsRow | null> {
      const row = await db
        .selectFrom("entity_touch_stats")
        .selectAll()
        .where("entity_id", "=", entityId)
        .executeTakeFirst();
      return row ?? null;
    },

    async list(options: ListEntityTouchStatsOptions = {}): Promise<EntityTouchStatsListPage> {
      const sortBy = options.sortBy ?? "lastTouch";
      const order = sortBy === "name" ? "asc" : "desc";
      const comparison = order === "desc" ? "<" : ">";
      const requestedLimit = options.limit ?? 100;
      const cursor = options.cursor;
      const rows = await db
        .selectFrom("entities")
        .leftJoin("entity_touch_stats", "entity_touch_stats.entity_id", "entities.id")
        .select([
          "entities.id as id",
          "entities.name as name",
          "entities.source_type as sourceType",
          "entities.subtype as subtype",
          "entities.status as status",
          "entities.hotness as hotness",
          "entity_touch_stats.last_touch_at as lastTouchAt",
          "entity_touch_stats.last_inbound_at as lastInboundAt",
          "entity_touch_stats.last_outbound_at as lastOutboundAt",
          "entity_touch_stats.touch_count_30d as touchCount30d",
          "entity_touch_stats.touch_count_90d as touchCount90d",
          "entity_touch_stats.source_last_touch as sourceLastTouch",
        ])
        .where(whereLiveEntity())
        .where("entities.status", "=", options.where?.status ?? "confirmed")
        .$if(Boolean(options.visibility), (qb) => qb.where(options.visibility as RawBuilder<boolean>))
        .$if(Boolean(options.where?.types?.length), (qb) =>
          qb.where(idInList(db, sql.ref("entities.source_type"), options.where?.types ?? [])),
        )
        .$if(Boolean(options.where?.lastTouchBefore), (qb) =>
          qb.where("entity_touch_stats.last_touch_at", "<", options.where?.lastTouchBefore ?? ""),
        )
        .$if(Boolean(options.where?.lastTouchAfter), (qb) =>
          qb.where("entity_touch_stats.last_touch_at", ">", options.where?.lastTouchAfter ?? ""),
        )
        .$if(Boolean(options.where?.lastInboundBefore), (qb) =>
          qb.where("entity_touch_stats.last_inbound_at", "<", options.where?.lastInboundBefore ?? ""),
        )
        .$if(Boolean(options.where?.lastInboundAfter), (qb) =>
          qb.where("entity_touch_stats.last_inbound_at", ">", options.where?.lastInboundAfter ?? ""),
        )
        .$if(options.where?.minTouches30d !== undefined, (qb) =>
          qb.where("entity_touch_stats.touch_count_30d", ">=", options.where?.minTouches30d ?? 0),
        )
        .$if(options.where?.minTouches90d !== undefined, (qb) =>
          qb.where("entity_touch_stats.touch_count_90d", ">=", options.where?.minTouches90d ?? 0),
        )
        .$if(options.where?.awaitingReply === true, (qb) =>
          qb
            .where("entity_touch_stats.last_inbound_at", "is not", null)
            .where(({ eb, or }) =>
              or([
                eb("entity_touch_stats.last_outbound_at", "is", null),
                eb("entity_touch_stats.last_inbound_at", ">", eb.ref("entity_touch_stats.last_outbound_at")),
              ]),
            ),
        )
        .$if(cursor !== undefined, (qb) =>
          qb.where(({ eb, or, and }) => {
            if (cursor === undefined) throw new Error("cursor predicate requires a cursor");
            switch (cursor.sortBy) {
              case "hotness":
              case "touches90d":
                return or([
                  eb(numericSortColumn(cursor.sortBy), comparison, cursor.sortValue),
                  and([
                    eb(numericSortColumn(cursor.sortBy), "=", cursor.sortValue),
                    eb("entities.id", comparison, cursor.entityId),
                  ]),
                ]);
              default:
                return or([
                  eb(textSortColumn(cursor.sortBy), comparison, cursor.sortValue),
                  and([
                    eb(textSortColumn(cursor.sortBy), "=", cursor.sortValue),
                    eb("entities.id", comparison, cursor.entityId),
                  ]),
                ]);
            }
          }),
        )
        .$if(sortBy === "lastTouch", (qb) => qb.orderBy(coalescedTimestampColumn("lastTouch"), order))
        .$if(sortBy === "lastInbound", (qb) => qb.orderBy(coalescedTimestampColumn("lastInbound"), order))
        .$if(sortBy === "touches90d", (qb) => qb.orderBy(numericSortColumn("touches90d"), order))
        .$if(sortBy === "hotness", (qb) => qb.orderBy(numericSortColumn("hotness"), order))
        .$if(sortBy === "name", (qb) => qb.orderBy(textSortColumn("name"), order))
        .orderBy("entities.id", order)
        .limit(requestedLimit + 1)
        .execute();
      const pageRows = rows.slice(0, requestedLimit);
      const lastRow = pageRows.at(-1);
      return {
        rows: pageRows,
        nextCursor: rows.length > requestedLimit && lastRow ? cursorForRow(lastRow, sortBy) : null,
      };
    },
  };
}
