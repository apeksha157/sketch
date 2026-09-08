import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import type { DB, EntityTouchStatsTable } from "../schema";

export type EntityTouchStatsRow = Selectable<EntityTouchStatsTable>;

export interface ListEntityTouchStatsOptions {
  where?: {
    lastTouchBefore?: string;
    lastTouchAfter?: string;
    minTouches90d?: number;
  };
  order?: "asc" | "desc";
  limit?: number;
  cursor?: {
    lastTouchAt: string | null;
    entityId: string;
  };
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

    async list(options: ListEntityTouchStatsOptions = {}): Promise<EntityTouchStatsRow[]> {
      const order = options.order ?? "desc";
      const cursorValue = options.cursor?.lastTouchAt ?? "";
      const comparison = order === "desc" ? "<" : ">";
      return db
        .selectFrom("entity_touch_stats")
        .selectAll()
        .$if(Boolean(options.where?.lastTouchBefore), (qb) =>
          qb.where("last_touch_at", "<", options.where?.lastTouchBefore ?? ""),
        )
        .$if(Boolean(options.where?.lastTouchAfter), (qb) =>
          qb.where("last_touch_at", ">", options.where?.lastTouchAfter ?? ""),
        )
        .$if(options.where?.minTouches90d !== undefined, (qb) =>
          qb.where("touch_count_90d", ">=", options.where?.minTouches90d ?? 0),
        )
        .$if(Boolean(options.cursor), (qb) =>
          qb.where(({ eb, or, and }) =>
            or([
              eb(sql<string>`COALESCE(last_touch_at, '')`, comparison, cursorValue),
              and([
                eb(sql<string>`COALESCE(last_touch_at, '')`, "=", cursorValue),
                eb("entity_id", comparison, options.cursor?.entityId ?? ""),
              ]),
            ]),
          ),
        )
        .orderBy(sql`COALESCE(last_touch_at, '')`, order)
        .orderBy("entity_id", order)
        .limit(options.limit ?? 100)
        .execute();
    },
  };
}
