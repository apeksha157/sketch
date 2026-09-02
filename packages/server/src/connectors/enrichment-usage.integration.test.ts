import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import { MAX_ENRICHMENT_STAGE_ATTEMPTS, runEnrichment } from "./enrichment";
import type { GeminiGenerator, GenerateMeta, GenerateOptions } from "./gemini-generate";

async function seedConnector(db: Kysely<DB>, connectorId: string): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: "enrichment-user", name: "Enrichment User", email: "enrichment-user@example.com" })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: connectorId,
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "enrichment-user",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}

async function seedFile(
  db: Kysely<DB>,
  input: {
    connectorId: string;
    fileId: string;
    content: string;
    embeddingStatus?: string;
    embeddingAttempts?: number;
    embeddingNextRetryAt?: string | null;
    summaryStatus?: string;
  },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: input.fileId,
      connector_config_id: input.connectorId,
      provider_file_id: input.fileId,
      file_name: `${input.fileId}.txt`,
      file_type: "calendar_event",
      content_category: "document",
      source: "google_drive",
      source_path: "Drive",
      content: input.content,
      content_hash: `hash-${input.fileId}`,
      embedding_status: input.embeddingStatus ?? "pending",
      embedding_attempts: input.embeddingAttempts ?? 0,
      embedding_next_retry_at: input.embeddingNextRetryAt ?? null,
      summary_status: input.summaryStatus ?? "pending",
      synced_at: "2026-08-29T00:00:00.000Z",
    })
    .execute();
}

function metaFor(label: string | undefined): GenerateMeta {
  return {
    outcome: "ok",
    rawText: "{}",
    durationMs: 17,
    model: `test-model:${label ?? "unknown"}`,
    usage: { promptTokens: 101, completionTokens: 11 },
    costUsd: 0.001,
  };
}

function telemetryGenerator(): GeminiGenerator {
  return {
    generate: async (_prompt: string, opts?: GenerateOptions) => {
      opts?.onMeta?.({ ...metaFor(opts.label), rawText: "Known Product summary." });
      return "Known Product summary.";
    },
    generateJSON: async <T>(_prompt: string, opts?: Omit<GenerateOptions, "responseMimeType">) => {
      opts?.onMeta?.(metaFor(opts?.label));
      if (opts?.label?.startsWith("extractEntities")) {
        return {
          mentions: [{ mention: "Known Product", type: "product", variations: [], confidence: 0.95 }],
          relations: [],
        } as T;
      }
      if (opts?.label?.startsWith("dedupAdjudicate")) {
        return [{ mention: "M1", matchesKnown: "K1" }] as T;
      }
      return {} as T;
    },
  };
}

describe("runEnrichment retry cap and LLM usage telemetry", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("does not select failed files at the terminal embedding attempt cap", async () => {
    const connectorId = `conn-${randomUUID()}`;
    const cappedFileId = `capped-${randomUUID()}`;
    const retryableFileId = `retryable-${randomUUID()}`;
    await seedConnector(db, connectorId);
    await seedFile(db, {
      connectorId,
      fileId: cappedFileId,
      content: "Capped failed document content.",
      embeddingStatus: "failed",
      embeddingAttempts: MAX_ENRICHMENT_STAGE_ATTEMPTS,
      embeddingNextRetryAt: "2026-01-01T00:00:00.000Z",
    });
    await seedFile(db, {
      connectorId,
      fileId: retryableFileId,
      content: "Retryable failed document content.",
      embeddingStatus: "failed",
      embeddingAttempts: MAX_ENRICHMENT_STAGE_ATTEMPTS - 1,
      embeddingNextRetryAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await runEnrichment({ db, logger: createTestLogger(), embeddingProvider: null });

    expect(result.filesProcessed).toBe(1);
    await expect(
      db
        .selectFrom("indexed_files")
        .select(["id", "embedding_status"])
        .where("id", "in", [cappedFileId, retryableFileId])
        .orderBy("id", "asc")
        .execute(),
    ).resolves.toEqual([
      { id: cappedFileId, embedding_status: "failed" },
      { id: retryableFileId, embedding_status: "done" },
    ]);
  }, 30000);

  it("records one usage row per smart-enrichment LLM call and ignores telemetry write failures", async () => {
    const connectorId = `conn-${randomUUID()}`;
    const fileId = `telemetry-${randomUUID()}`;
    const missingTableFileId = `telemetry-missing-${randomUUID()}`;
    await seedConnector(db, connectorId);
    await createEntityRepository(db).upsertEntity({
      name: "Known Product",
      sourceType: "product",
      status: "confirmed",
      provenanceTier: "declared",
    });
    await seedFile(db, {
      connectorId,
      fileId,
      content: Array.from({ length: 20 }, () => "Known Product roadmap review.").join(" "),
    });

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: telemetryGenerator(),
      fileIds: [fileId],
    });

    await vi.waitFor(async () => {
      const rows = await db.selectFrom("llm_usage_events").selectAll().where("indexed_file_id", "=", fileId).execute();
      expect(rows).toHaveLength(4);
    });
    const contexts = await db
      .selectFrom("llm_usage_events")
      .select(["context", "indexed_file_id", "prompt_tokens", "completion_tokens", "cost_usd"])
      .where("indexed_file_id", "=", fileId)
      .orderBy("context", "asc")
      .execute();
    expect(contexts).toEqual([
      {
        context: "enrichment:dedupAdjudicate",
        indexed_file_id: fileId,
        prompt_tokens: 101,
        completion_tokens: 11,
        cost_usd: 0.001,
      },
      {
        context: "enrichment:extractEntities",
        indexed_file_id: fileId,
        prompt_tokens: 101,
        completion_tokens: 11,
        cost_usd: 0.001,
      },
      {
        context: "enrichment:extractEntityFacts",
        indexed_file_id: fileId,
        prompt_tokens: 101,
        completion_tokens: 11,
        cost_usd: 0.001,
      },
      {
        context: "enrichment:generateSummary",
        indexed_file_id: fileId,
        prompt_tokens: 101,
        completion_tokens: 11,
        cost_usd: 0.001,
      },
    ]);

    await seedFile(db, {
      connectorId,
      fileId: missingTableFileId,
      content: Array.from({ length: 20 }, () => "Known Product renewal review.").join(" "),
    });
    await db.schema.dropTable("llm_usage_events").execute();

    await expect(
      runEnrichment({
        db,
        logger: createTestLogger(),
        embeddingProvider: null,
        generator: telemetryGenerator(),
        fileIds: [missingTableFileId],
      }),
    ).resolves.toMatchObject({ filesProcessed: 1, filesFailed: 0 });
  }, 30000);
});
