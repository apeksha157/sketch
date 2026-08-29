import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../schema";

export interface RecordLlmUsageInput {
  context: string;
  indexedFileId?: string | null;
  model: string;
  outcome: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  durationMs: number;
  costUsd?: number | null;
}

export function createLlmUsageRepository(db: Kysely<DB>) {
  return {
    async recordUsage(input: RecordLlmUsageInput): Promise<void> {
      await db
        .insertInto("llm_usage_events")
        .values({
          id: randomUUID(),
          context: input.context,
          indexed_file_id: input.indexedFileId ?? null,
          model: input.model,
          outcome: input.outcome,
          prompt_tokens: input.promptTokens ?? null,
          completion_tokens: input.completionTokens ?? null,
          duration_ms: input.durationMs,
          cost_usd: input.costUsd ?? null,
        })
        .execute();
    },
  };
}
