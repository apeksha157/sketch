import { randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql } from "kysely";
import type { DB, ExtractionStagesTable } from "../schema";

export type ExtractionStage = Selectable<ExtractionStagesTable>;

export interface StageExtractionInput {
  indexedFileId: string;
  contentHash: string | null;
  extractorVersion: string;
  stagedJson: string;
  model?: string | null;
  rounds?: number | null;
  toolCalls?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
}

export function createExtractionStageRepository(db: Kysely<DB>) {
  return {
    async stageExtraction(input: StageExtractionInput): Promise<ExtractionStage> {
      const values = {
        id: randomUUID(),
        indexed_file_id: input.indexedFileId,
        content_hash: input.contentHash,
        extractor_version: input.extractorVersion,
        status: "staged",
        staged_json: input.stagedJson,
        model: input.model ?? null,
        rounds: input.rounds ?? null,
        tool_calls: input.toolCalls ?? null,
        input_tokens: input.inputTokens ?? null,
        output_tokens: input.outputTokens ?? null,
        cost_usd: input.costUsd ?? null,
        duration_ms: input.durationMs ?? null,
      };

      if (input.contentHash === null) {
        await db
          .deleteFrom("extraction_stages")
          .where("indexed_file_id", "=", input.indexedFileId)
          .where("extractor_version", "=", input.extractorVersion)
          .execute();
        await db.insertInto("extraction_stages").values(values).execute();
      } else {
        await db
          .insertInto("extraction_stages")
          .values(values)
          .onConflict((oc) =>
            oc
              .columns(["indexed_file_id", "content_hash", "extractor_version"])
              .where(sql<boolean>`content_hash IS NOT NULL`)
              .doUpdateSet({
                staged_json: sql`excluded.staged_json`,
                model: sql`excluded.model`,
                rounds: sql`excluded.rounds`,
                tool_calls: sql`excluded.tool_calls`,
                input_tokens: sql`excluded.input_tokens`,
                output_tokens: sql`excluded.output_tokens`,
                cost_usd: sql`excluded.cost_usd`,
                duration_ms: sql`excluded.duration_ms`,
                status: "staged",
                updated_at: sql`CURRENT_TIMESTAMP`,
              }),
          )
          .execute();
      }

      let query = db
        .selectFrom("extraction_stages")
        .selectAll()
        .where("indexed_file_id", "=", input.indexedFileId)
        .where("extractor_version", "=", input.extractorVersion);
      query =
        input.contentHash === null
          ? query.where("content_hash", "is", null)
          : query.where("content_hash", "=", input.contentHash);
      const stage = await query.executeTakeFirst();
      if (!stage) throw new Error("extraction stage was not persisted");
      return stage;
    },

    async getStage(
      indexedFileId: string,
      contentHash: string | null,
      extractorVersion: string,
    ): Promise<ExtractionStage | null> {
      let query = db
        .selectFrom("extraction_stages")
        .selectAll()
        .where("indexed_file_id", "=", indexedFileId)
        .where("extractor_version", "=", extractorVersion);
      query =
        contentHash === null ? query.where("content_hash", "is", null) : query.where("content_hash", "=", contentHash);
      return (await query.executeTakeFirst()) ?? null;
    },

    async listStagesForFile(indexedFileId: string): Promise<ExtractionStage[]> {
      return db
        .selectFrom("extraction_stages")
        .selectAll()
        .where("indexed_file_id", "=", indexedFileId)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();
    },
  };
}
