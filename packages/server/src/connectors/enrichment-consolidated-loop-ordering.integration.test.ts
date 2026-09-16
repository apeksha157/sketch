import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import type { ConsolidatedLoopAgenticGenerator } from "./consolidated-loop";
import { runEnrichment } from "./enrichment";
import type { GeminiGenerator, GenerateMeta, GenerateOptions } from "./gemini-generate";

const NOW = "2026-09-15T00:00:00.000Z";

function generateMeta(label: string | undefined): GenerateMeta {
  return {
    outcome: "ok",
    rawText: "{}",
    durationMs: 5,
    model: `test:${label ?? "unknown"}`,
    usage: { promptTokens: 10, completionTokens: 5 },
    costUsd: 0.001,
  };
}

function legacyGenerator(): GeminiGenerator {
  return {
    generate: async () => "Known Product roadmap summary.",
    generateJSON: async <T>(_prompt: string, options?: Omit<GenerateOptions, "responseMimeType">) => {
      if (options?.label?.startsWith("extractEntities")) {
        return {
          mentions: [{ mention: "Known Product", type: "product", variations: [], confidence: 0.95 }],
          relations: [],
        } as T;
      }
      if (options?.label?.startsWith("dedupAdjudicate")) {
        return [{ mention: "M1", matchesKnown: "K1" }] as T;
      }
      return {} as T;
    },
  };
}

async function seedFile(
  db: Kysely<DB>,
  options: { embeddingStatus?: "pending" | "done" } = {},
): Promise<{ fileId: string; entityId: string }> {
  const userId = `user-${randomUUID()}`;
  const connectorId = `connector-${randomUUID()}`;
  const fileId = `file-${randomUUID()}`;
  await db
    .insertInto("users")
    .values({ id: userId, name: "Loop User", email: `${userId}@example.com` })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: connectorId,
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: userId,
    })
    .execute();
  const entity = await createEntityRepository(db).upsertEntity({
    name: "Known Product",
    sourceType: "product",
    status: "confirmed",
    provenanceTier: "declared",
  });
  const content = Array.from({ length: 20 }, () => "Known Product roadmap review.").join(" ");
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: connectorId,
      provider_file_id: fileId,
      file_name: `${fileId}.txt`,
      file_type: "calendar_event",
      content_category: "document",
      source: "google_drive",
      source_path: "Drive/loop.txt",
      content,
      content_hash: `hash-${fileId}`,
      embedding_status: options.embeddingStatus ?? "pending",
      summary_status: "pending",
      synced_at: NOW,
      source_created_at: NOW,
      source_updated_at: NOW,
    })
    .execute();
  return { fileId, entityId: entity.id };
}

function inspectingShadowGenerator(
  db: Kysely<DB>,
  fileId: string,
  entityId: string,
  observations: Array<{ mentions: number; facts: number }>,
): ConsolidatedLoopAgenticGenerator {
  return {
    async generateAgenticJSON<T>() {
      const mentionRow = await db
        .selectFrom("entity_mentions")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("indexed_file_id", "=", fileId)
        .executeTakeFirstOrThrow();
      const factRow = await db
        .selectFrom("indexed_file_facts")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("indexed_file_id", "=", fileId)
        .where("deleted_at", "is", null)
        .executeTakeFirstOrThrow();
      observations.push({ mentions: Number(mentionRow.count), facts: Number(factRow.count) });
      return {
        value: {
          mentions: [
            {
              mention: "Known Product",
              type: "product",
              variations: [],
              facts: [],
              resolution: { kind: "matched", entityId },
            },
          ],
          relations: [],
          summary: "Known Product roadmap summary.",
        } as T,
        toolSteps: [],
        rounds: 1,
        meta: generateMeta("consolidatedLoop"),
      };
    },
  };
}

async function assertLegacyAndStage(db: Kysely<DB>, fileId: string): Promise<void> {
  const stages = await db.selectFrom("extraction_stages").select("id").where("indexed_file_id", "=", fileId).execute();
  const facts = await db
    .selectFrom("indexed_file_facts")
    .select("id")
    .where("indexed_file_id", "=", fileId)
    .where("fact_type", "=", "llm_extracted")
    .where("deleted_at", "is", null)
    .execute();
  expect(stages).toHaveLength(1);
  expect(facts.length).toBeGreaterThan(0);
}

describe("consolidated loop shadow ordering", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("runs the main-path shadow before this file has legacy graph rows", async () => {
    const { fileId, entityId } = await seedFile(db);
    const observations: Array<{ mentions: number; facts: number }> = [];

    const result = await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: legacyGenerator(),
      consolidatedLoopMode: "shadow",
      consolidatedLoopAgenticGenerator: inspectingShadowGenerator(db, fileId, entityId, observations),
      fileIds: [fileId],
    });

    expect(result).toMatchObject({ filesProcessed: 1, filesFailed: 0, errors: [] });
    expect(observations).toEqual([{ mentions: 0, facts: 0 }]);
    await assertLegacyAndStage(db, fileId);
  });

  it("runs the summary-only shadow before this file has legacy graph rows", async () => {
    const { fileId, entityId } = await seedFile(db, { embeddingStatus: "done" });
    const observations: Array<{ mentions: number; facts: number }> = [];

    const result = await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: legacyGenerator(),
      consolidatedLoopMode: "shadow",
      consolidatedLoopAgenticGenerator: inspectingShadowGenerator(db, fileId, entityId, observations),
      fileIds: [fileId],
    });

    expect(result).toMatchObject({ filesProcessed: 1, filesFailed: 0, errors: [] });
    expect(observations).toEqual([{ mentions: 0, facts: 0 }]);
    await assertLegacyAndStage(db, fileId);
  });

  it("keeps the legacy chain successful when the shadow generator throws", async () => {
    const { fileId } = await seedFile(db);
    const throwingGenerator: ConsolidatedLoopAgenticGenerator = {
      async generateAgenticJSON(): Promise<never> {
        throw new Error("shadow unavailable");
      },
    };

    const result = await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: legacyGenerator(),
      consolidatedLoopMode: "shadow",
      consolidatedLoopAgenticGenerator: throwingGenerator,
      fileIds: [fileId],
    });

    expect(result).toMatchObject({ filesProcessed: 1, filesFailed: 0, errors: [] });
    const facts = await db
      .selectFrom("indexed_file_facts")
      .select("id")
      .where("indexed_file_id", "=", fileId)
      .where("fact_type", "=", "llm_extracted")
      .where("deleted_at", "is", null)
      .execute();
    expect(facts.length).toBeGreaterThan(0);
  });

  it("keeps other tenants off by default without invoking the shadow generator", async () => {
    const { fileId } = await seedFile(db);
    let calls = 0;
    const shadowGenerator: ConsolidatedLoopAgenticGenerator = {
      async generateAgenticJSON<T>() {
        calls += 1;
        return {
          value: {
            mentions: [],
            relations: [],
            summary: "Unused shadow summary.",
          } as T,
          toolSteps: [],
          rounds: 1,
          meta: generateMeta("unusedShadow"),
        };
      },
    };

    const result = await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator: legacyGenerator(),
      consolidatedLoopAgenticGenerator: shadowGenerator,
      fileIds: [fileId],
    });

    expect(result).toMatchObject({ filesProcessed: 1, filesFailed: 0, errors: [] });
    expect(calls).toBe(0);
    const stages = await db
      .selectFrom("extraction_stages")
      .select("id")
      .where("indexed_file_id", "=", fileId)
      .execute();
    expect(stages).toHaveLength(0);
  });
});
