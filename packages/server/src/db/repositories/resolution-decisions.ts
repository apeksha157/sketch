import { randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql } from "kysely";
import type { DB, ResolutionDecisionsTable } from "../schema";

export type ResolutionDecision = Selectable<ResolutionDecisionsTable>;
export type ResolutionDecisionDecider = "human" | "judge" | "adjacency";

export interface RecordResolutionDecisionInput {
  normalizedMentionName: string;
  entityType: string;
  scope?: string;
  targetEntityId: string | null;
  targetName?: string | null;
  targetEmail?: string | null;
  decider: ResolutionDecisionDecider;
  decidedBy: string;
  source: string;
  sourceId: string;
  evidenceFileIds?: string[];
  verdictRef?: string | null;
}

export interface ResolutionDecisionLookup {
  link: ResolutionDecision | null;
  distinct: ResolutionDecision[];
  dismiss: ResolutionDecision[];
}

function uniqueJson(values: string[] | undefined): string {
  return JSON.stringify([...new Set(values ?? [])]);
}

export function createResolutionDecisionRepository(db: Kysely<DB>) {
  return {
    async recordLink(input: RecordResolutionDecisionInput): Promise<ResolutionDecision> {
      const id = randomUUID();
      await db
        .insertInto("resolution_decisions")
        .values({
          id,
          normalized_mention_name: input.normalizedMentionName,
          entity_type: input.entityType,
          scope: input.scope ?? "global",
          verdict: "link",
          target_entity_id: input.targetEntityId,
          target_name: input.targetName ?? null,
          target_email: input.targetEmail ?? null,
          decider: input.decider,
          decided_by: input.decidedBy,
          source: input.source,
          source_id: input.sourceId,
          evidence_file_ids: uniqueJson(input.evidenceFileIds),
          verdict_ref: input.verdictRef ?? null,
          status: "active",
        })
        .onConflict((oc) =>
          /**
           * The conflict-target predicate must be an inline literal: SQLite
           * matches it structurally against the partial unique index and a
           * bind parameter never matches ("ON CONFLICT clause does not match
           * any PRIMARY KEY or UNIQUE constraint"). Postgres accepts either.
           */
          oc
            .columns(["normalized_mention_name", "entity_type", "scope"])
            .where(sql<boolean>`verdict = 'link'`)
            .doUpdateSet({
              target_entity_id: sql`excluded.target_entity_id`,
              target_name: sql`excluded.target_name`,
              target_email: sql`excluded.target_email`,
              decider: sql`excluded.decider`,
              decided_by: sql`excluded.decided_by`,
              source: sql`excluded.source`,
              source_id: sql`excluded.source_id`,
              evidence_file_ids: sql`excluded.evidence_file_ids`,
              verdict_ref: sql`excluded.verdict_ref`,
              status: "active",
              updated_at: sql`CURRENT_TIMESTAMP`,
            }),
        )
        .execute();

      return db
        .selectFrom("resolution_decisions")
        .selectAll()
        .where("normalized_mention_name", "=", input.normalizedMentionName)
        .where("entity_type", "=", input.entityType)
        .where("scope", "=", input.scope ?? "global")
        .where("verdict", "=", "link")
        .executeTakeFirstOrThrow();
    },

    async recordDistinct(input: RecordResolutionDecisionInput): Promise<boolean> {
      const result = await db
        .insertInto("resolution_decisions")
        .values({
          id: randomUUID(),
          normalized_mention_name: input.normalizedMentionName,
          entity_type: input.entityType,
          scope: input.scope ?? "global",
          verdict: "distinct",
          target_entity_id: input.targetEntityId,
          target_name: input.targetName ?? null,
          target_email: input.targetEmail ?? null,
          decider: input.decider,
          decided_by: input.decidedBy,
          source: input.source,
          source_id: input.sourceId,
          evidence_file_ids: uniqueJson(input.evidenceFileIds),
          verdict_ref: input.verdictRef ?? null,
          status: "active",
        })
        .onConflict((oc) =>
          oc
            .columns(["normalized_mention_name", "entity_type", "scope", "target_entity_id"])
            .where(sql<boolean>`verdict = 'distinct'`)
            .doNothing(),
        )
        .executeTakeFirst();
      return Number(result?.numInsertedOrUpdatedRows ?? 0) > 0;
    },

    async recordDismiss(input: Omit<RecordResolutionDecisionInput, "targetEntityId">): Promise<boolean> {
      const existing = await db
        .selectFrom("resolution_decisions")
        .select("id")
        .where("normalized_mention_name", "=", input.normalizedMentionName)
        .where("entity_type", "=", input.entityType)
        .where("scope", "=", input.scope ?? "global")
        .where("verdict", "=", "dismiss")
        .where("status", "=", "active")
        .executeTakeFirst();
      if (existing) return false;
      const result = await db
        .insertInto("resolution_decisions")
        .values({
          id: randomUUID(),
          normalized_mention_name: input.normalizedMentionName,
          entity_type: input.entityType,
          scope: input.scope ?? "global",
          verdict: "dismiss",
          target_entity_id: null,
          target_name: input.targetName ?? null,
          target_email: input.targetEmail ?? null,
          decider: input.decider,
          decided_by: input.decidedBy,
          source: input.source,
          source_id: input.sourceId,
          evidence_file_ids: uniqueJson(input.evidenceFileIds),
          verdict_ref: input.verdictRef ?? null,
          status: "active",
        })
        .executeTakeFirst();
      return Number(result?.numInsertedOrUpdatedRows ?? 0) > 0;
    },

    async findActiveForMention(
      normalizedName: string,
      entityType: string,
      scope = "global",
    ): Promise<ResolutionDecisionLookup> {
      const rows = await db
        .selectFrom("resolution_decisions")
        .selectAll()
        .where("normalized_mention_name", "=", normalizedName)
        .where("entity_type", "=", entityType)
        .where("scope", "=", scope)
        .where("status", "in", ["active", "stale"])
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();
      return {
        link: rows.find((row) => row.verdict === "link") ?? null,
        distinct: rows.filter((row) => row.verdict === "distinct" && row.status === "active"),
        dismiss: rows.filter((row) => row.verdict === "dismiss" && row.status === "active"),
      };
    },

    async markStale(id: string): Promise<void> {
      await db
        .updateTable("resolution_decisions")
        .set({ status: "stale", updated_at: sql`CURRENT_TIMESTAMP` })
        .where("id", "=", id)
        .execute();
    },

    async healTarget(id: string, newTargetEntityId: string): Promise<void> {
      await db
        .updateTable("resolution_decisions")
        .set({ target_entity_id: newTargetEntityId, status: "active", updated_at: sql`CURRENT_TIMESTAMP` })
        .where("id", "=", id)
        .execute();
    },
  };
}
