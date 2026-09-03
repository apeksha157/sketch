import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import {
  CONSOLIDATED_EXTRACTOR_VERSION,
  type ConsolidatedLoopAgenticGenerator,
  runConsolidatedLoopShadow,
} from "./consolidated-loop";
import type { GenerateMeta } from "./gemini-generate";
import type { AgenticOptions, AgenticToolStep } from "./openrouter-generate";
import type { FileContext } from "./smart-enrichment";

const NOW = "2026-08-29T00:00:00.000Z";

function meta(): GenerateMeta {
  return {
    outcome: "ok",
    rawText: "{}",
    durationMs: 19,
    model: "test/consolidated-loop",
    usage: { promptTokens: 123, completionTokens: 45 },
    costUsd: 0.002,
  };
}

function agenticGenerator(
  run: (opts: AgenticOptions) => Promise<{ value: unknown; toolSteps?: AgenticToolStep[] }>,
): ConsolidatedLoopAgenticGenerator {
  return {
    async generateAgenticJSON<T>(_prompt: string, opts: AgenticOptions) {
      const result = await run(opts);
      return {
        value: result.value as T,
        toolSteps: result.toolSteps ?? [],
        rounds: 1,
        meta: meta(),
      };
    },
  };
}

async function seedBase(db: Kysely<DB>, connectorId: string): Promise<void> {
  await db.insertInto("users").values({ id: "loop-user", name: "Loop User", email: "loop@example.com" }).execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: connectorId,
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "loop-user",
    })
    .execute();
}

async function seedFile(
  db: Kysely<DB>,
  connectorId: string,
  fileId: string,
  contentHash: string | null,
): Promise<FileContext> {
  const content = "Sarah Chen met Acme Corp to discuss Project Atlas.";
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: connectorId,
      provider_file_id: fileId,
      file_name: `${fileId}.txt`,
      file_type: "calendar_event",
      content_category: "document",
      content,
      summary: "Legacy summary stays here.",
      source: "google_drive",
      source_path: "Drive/loop.txt",
      content_hash: contentHash,
      summary_status: "done",
      synced_at: NOW,
      source_created_at: NOW,
      source_updated_at: NOW,
    })
    .execute();
  return {
    id: fileId,
    fileName: `${fileId}.txt`,
    content,
    contentCategory: "document",
    fileType: "calendar_event",
    source: "google_drive",
    sourcePath: "Drive/loop.txt",
    contentHash,
    connectorConfigId: connectorId,
    sourceCreatedAt: NOW,
    sourceUpdatedAt: NOW,
  };
}

async function seedEntity(db: Kysely<DB>, id: string, name: string, sourceType: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: sourceType,
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 1,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

async function tableCounts(db: Kysely<DB>): Promise<Record<string, number>> {
  const tables = [
    "entities",
    "entity_mentions",
    "indexed_file_facts",
    "graph_verdicts",
    "resolution_decisions",
    "entity_review_queue",
  ] as const;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = await db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirst();
    counts[table] = Number(row?.count ?? 0);
  }
  return counts;
}

async function stages(db: Kysely<DB>, fileId: string) {
  return db
    .selectFrom("extraction_stages")
    .selectAll()
    .where("indexed_file_id", "=", fileId)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();
}

describe("consolidated loop shadow", () => {
  let db: Kysely<DB>;
  let connectorId: string;

  beforeEach(async () => {
    db = await createTestPgDb();
    connectorId = `loop-connector-${randomUUID()}`;
    await seedBase(db, connectorId);
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("writes nothing but the stage", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const entityId = `entity-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    await seedEntity(db, entityId, "Sarah Chen", "person");
    const before = await tableCounts(db);
    const generator = agenticGenerator(async () => ({
      value: {
        mentions: [
          {
            mention: "Sarah Chen",
            type: "person",
            variations: ["Sarah"],
            resolution: { kind: "known", entityId },
          },
        ],
        relations: [
          {
            type: "leads",
            source: { name: "Sarah Chen", type: "person", variations: ["Sarah"] },
            target: { name: "Project Atlas", type: "project", variations: ["Atlas"] },
            confidence: 0.9,
            context: "Sarah Chen leads Project Atlas",
          },
        ],
        entityFacts: [{ entityId, facts: ["Sarah Chen leads Project Atlas"] }],
        summary: "Sarah Chen discussed Project Atlas. Acme Corp was part of the planning context.",
      },
    }));

    await runConsolidatedLoopShadow(
      {
        db,
        logger: createTestLogger(),
        agenticGenerator: generator,
        knownEntities: [{ entityId, name: "Sarah Chen", type: "person" }],
      },
      file,
    );

    const rows = await stages(db, fileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      indexed_file_id: fileId,
      content_hash: "hash-one",
      extractor_version: CONSOLIDATED_EXTRACTOR_VERSION,
      status: "staged",
    });
    const staged = JSON.parse(rows[0].staged_json);
    expect(staged.mentions).toHaveLength(1);
    expect(staged.relations).toHaveLength(1);
    expect(staged.entityFacts).toHaveLength(1);
    expect(staged.summary).toContain("Project Atlas");
    expect(await tableCounts(db)).toEqual(before);
    const fileAfter = await db
      .selectFrom("indexed_files")
      .select("summary")
      .where("id", "=", fileId)
      .executeTakeFirst();
    expect(fileAfter?.summary).toBe("Legacy summary stays here.");
  });

  it("re-stages idempotently and forks on content change", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    let version = 0;
    const generator = agenticGenerator(async () => {
      version += 1;
      return {
        value: {
          mentions: [],
          relations: [],
          entityFacts: [],
          summary: `Summary version ${version}.`,
        },
      };
    });

    await runConsolidatedLoopShadow({ db, logger: createTestLogger(), agenticGenerator: generator }, file);
    const first = await stages(db, fileId);
    expect(first).toHaveLength(1);
    await db
      .updateTable("extraction_stages")
      .set({ updated_at: "2000-01-01T00:00:00.000Z" })
      .where("id", "=", first[0].id)
      .execute();
    await runConsolidatedLoopShadow({ db, logger: createTestLogger(), agenticGenerator: generator }, file);
    const second = await stages(db, fileId);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].updated_at).not.toBe("2000-01-01T00:00:00.000Z");
    expect(JSON.parse(second[0].staged_json).summary).toBe("Summary version 2.");

    await runConsolidatedLoopShadow(
      { db, logger: createTestLogger(), agenticGenerator: generator },
      { ...file, contentHash: "hash-two" },
    );
    const forked = await stages(db, fileId);
    expect(forked).toHaveLength(2);
    expect(forked.map((row) => row.content_hash).sort()).toEqual(["hash-one", "hash-two"]);
  });

  it("guards unoffered entity links", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const offeredEntityId = `entity-${randomUUID()}`;
    const unofferedEntityId = `entity-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    await seedEntity(db, offeredEntityId, "Tool Target", "company");
    const generator = agenticGenerator(async (opts) => {
      const tool = opts.tools.find((candidate) => candidate.name === "lookup_candidates");
      if (!tool) throw new Error("lookup_candidates missing");
      const startedAt = Date.now();
      const result = await tool.run({ name: "Tool Target", entityType: "company" });
      const step: AgenticToolStep = {
        name: "lookup_candidates",
        args: { name: "Tool Target", entityType: "company" },
        result,
        durationMs: Date.now() - startedAt,
        cached: false,
      };
      await opts.onToolStep?.(step);
      return {
        toolSteps: [step],
        value: {
          mentions: [
            {
              mention: "Phantom Corp",
              type: "company",
              variations: [],
              resolution: { kind: "tool", entityId: unofferedEntityId },
            },
            {
              mention: "Tool Target",
              type: "company",
              variations: [],
              resolution: { kind: "tool", entityId: offeredEntityId },
            },
          ],
          relations: [],
          entityFacts: [
            { entityId: unofferedEntityId, facts: ["Phantom Corp owns the project"] },
            { entityId: offeredEntityId, facts: ["Tool Target was discussed"] },
          ],
          summary: "Tool Target was discussed. Phantom Corp remained unresolved.",
        },
      };
    });

    await runConsolidatedLoopShadow({ db, logger: createTestLogger(), agenticGenerator: generator }, file);

    const [row] = await stages(db, fileId);
    const staged = JSON.parse(row.staged_json);
    expect(staged.mentions[0].resolution).toEqual({
      kind: "hold",
      reason: "unoffered_target",
      candidates: [],
    });
    expect(staged.mentions[1].resolution).toEqual({ kind: "tool", entityId: offeredEntityId });
    expect(staged.entityFacts).toEqual([{ entityId: offeredEntityId, facts: ["Tool Target was discussed"] }]);
    expect(staged.meta.guard).toEqual({ demotedUnoffered: 1, droppedFacts: 1 });
  });
});
