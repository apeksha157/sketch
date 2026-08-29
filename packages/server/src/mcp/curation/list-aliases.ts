import type { ExpressionBuilder, Kysely } from "kysely";
import { z } from "zod/v4";
import { whereLiveEntity } from "../../db/repositories/entities";
import type { DB } from "../../db/schema";
import { clampLimit, jsonResult } from "./queries";

const aliasProvenances = ["legacy", "mint_model", "roster", "merge", "judge", "human_confirmed"] as const;

export const curationListAliasesSchema = {
  provenance: z.enum(aliasProvenances).optional().describe("Filter by alias provenance."),
  entityType: z.string().optional().describe("Filter by entities.source_type."),
  limit: z.number().optional().describe("Page size. Default 50, max 100."),
  offset: z.number().optional().describe("Offset. Default 0."),
};

export type CurationListAliasesArgs = z.infer<z.ZodObject<typeof curationListAliasesSchema>>;

export async function handleCurationListAliases(args: CurationListAliasesArgs, db: Kysely<DB>) {
  const limit = clampLimit(args.limit, 50, 100);
  const offset = Math.max(0, Math.trunc(args.offset ?? 0));
  const filters = (eb: ExpressionBuilder<DB, "entity_aliases" | "entities">) =>
    eb.and([
      whereLiveEntity(),
      ...(args.provenance ? [eb("entity_aliases.provenance", "=", args.provenance)] : []),
      ...(args.entityType ? [eb("entities.source_type", "=", args.entityType)] : []),
    ]);

  const totalRow = await db
    .selectFrom("entity_aliases")
    .innerJoin("entities", "entities.id", "entity_aliases.entity_id")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where(filters)
    .executeTakeFirst();
  const rows = await db
    .selectFrom("entity_aliases")
    .innerJoin("entities", "entities.id", "entity_aliases.entity_id")
    .select([
      "entity_aliases.entity_id as entityId",
      "entities.name as entityName",
      "entities.source_type as entityType",
      "entity_aliases.alias as alias",
      "entity_aliases.provenance as provenance",
    ])
    .where(filters)
    .orderBy("entities.name", "asc")
    .orderBy("entity_aliases.normalized_alias", "asc")
    .limit(limit)
    .offset(offset)
    .execute();

  return jsonResult({ total: Number(totalRow?.count ?? 0), rows, limit, offset });
}
