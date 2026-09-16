import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestLogger, getSharedPgDb } from "../test-utils";
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
  run: (opts: AgenticOptions, prompt: string) => Promise<{ value: unknown; toolSteps?: AgenticToolStep[] }>,
): ConsolidatedLoopAgenticGenerator {
  return {
    async generateAgenticJSON<T>(prompt: string, opts: AgenticOptions) {
      const result = await run(opts, prompt);
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

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
    connectorId = `loop-connector-${randomUUID()}`;
    await seedBase(db, connectorId);
  }, 30000);

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("writes nothing but the stage", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const entityId = `entity-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    await seedEntity(db, entityId, "Sarah Chen", "person");
    const before = await tableCounts(db);
    const generator = agenticGenerator(async (_opts, prompt) => {
      expect(prompt).toContain(
        "When the document content refers to one of these entities, emit a mention for it using the known name and prefer it as a relationship endpoint.",
      );
      expect(prompt).toContain(
        "Known entries have no ids here; to resolve one you must still send it through match_mentions and copy the id from that result.",
      );
      expect(prompt).toContain('"kind": "hold", "reason"');
      return {
        value: {
          mentions: [
            {
              mention: "Sarah Chen",
              type: "person",
              variations: ["Sarah"],
              facts: ["Sarah Chen leads Project Atlas"],
              resolution: { kind: "new" },
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
          summary: "Sarah Chen discussed Project Atlas. Acme Corp was part of the planning context.",
        },
      };
    });

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

  it("lets the machine override new for a verbatim existing name and keeps merged mention facts", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const entityId = `entity-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    await seedEntity(db, entityId, "Acme Corp", "company");
    const generator = agenticGenerator(async () => ({
      value: {
        mentions: [
          {
            mention: "Acme Corp",
            type: "company",
            variations: ["Acme"],
            facts: ["Acme Corp joined the discussion"],
            resolution: { kind: "new" },
          },
          {
            mention: "ACME   CORP",
            type: "company",
            variations: ["ACME"],
            facts: ["Acme Corp owns the account"],
            resolution: { kind: "hold", reason: "key_collision", candidates: [] },
          },
        ],
        relations: [],
        summary: "Acme Corp joined the discussion and owns the account.",
      },
    }));

    await runConsolidatedLoopShadow({ db, logger: createTestLogger(), agenticGenerator: generator }, file);

    const [row] = await stages(db, fileId);
    const staged = JSON.parse(row.staged_json);
    expect(staged.mentions).toHaveLength(1);
    expect(staged.mentions[0]).toMatchObject({
      mention: "Acme Corp",
      variations: ["Acme", "ACME"],
      facts: ["Acme Corp joined the discussion", "Acme Corp owns the account"],
      resolution: { kind: "matched", entityId },
    });
    expect(staged.entityFacts).toEqual([
      { entityId, facts: ["Acme Corp joined the discussion", "Acme Corp owns the account"] },
    ]);
    expect(staged.meta.guard.overriddenByMatcher).toBe(1);
  });

  it("links a known product through the registry before a same-name tool collision", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const productId = `entity-${randomUUID()}`;
    const toolId = `entity-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    await seedEntity(db, productId, "Sketch", "product");
    await db.updateTable("entities").set({ provenance_tier: "declared" }).where("id", "=", productId).execute();
    await seedEntity(db, toolId, "Sketch", "tool");
    const generator = agenticGenerator(async (opts) => {
      const tool = opts.tools.find((candidate) => candidate.name === "match_mentions");
      if (!tool) throw new Error("match_mentions missing");
      const args = { mentions: [{ name: "Sketch", type: "product" }] };
      const result = await tool.run(args);
      expect(JSON.parse(result).results[0]).toMatchObject({
        status: "linked",
        entityId: productId,
        entityName: "Sketch",
        rung: "registry",
      });
      const step: AgenticToolStep = {
        name: "match_mentions",
        args,
        result,
        durationMs: 1,
        cached: false,
      };
      await opts.onToolStep?.(step);
      return {
        toolSteps: [step],
        value: {
          mentions: [
            {
              mention: "Sketch",
              type: "product",
              variations: [],
              facts: ["Sketch stores project context"],
              resolution: { kind: "matched", entityId: productId },
            },
          ],
          relations: [],
          summary: "Sketch stores project context.",
        },
      };
    });

    await runConsolidatedLoopShadow(
      {
        db,
        logger: createTestLogger(),
        agenticGenerator: generator,
        knownEntities: [{ entityId: productId, name: "Sketch", type: "product" }],
      },
      file,
    );

    const [row] = await stages(db, fileId);
    const staged = JSON.parse(row.staged_json);
    expect(staged.mentions[0].resolution).toEqual({ kind: "matched", entityId: productId });
    expect(staged.meta.guard).toMatchObject({ registryLinked: 1, suppressed: 0 });
  });

  it("ignores a review-only registry entry and leaves a product-tool collision suppressed", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const productId = `entity-${randomUUID()}`;
    const toolId = `entity-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    await seedEntity(db, productId, "Sketch", "product");
    await db.updateTable("entities").set({ provenance_tier: "declared" }).where("id", "=", productId).execute();
    await seedEntity(db, toolId, "Sketch", "tool");
    const generator = agenticGenerator(async (opts) => {
      const tool = opts.tools.find((candidate) => candidate.name === "match_mentions");
      if (!tool) throw new Error("match_mentions missing");
      const args = { mentions: [{ name: "Sketch", type: "product" }] };
      const result = await tool.run(args);
      expect(JSON.parse(result).results[0]).toMatchObject({
        status: "suppressed",
        reason: "third_party_vendor_collision",
      });
      const step: AgenticToolStep = {
        name: "match_mentions",
        args,
        result,
        durationMs: 1,
        cached: false,
      };
      await opts.onToolStep?.(step);
      return {
        toolSteps: [step],
        value: {
          mentions: [
            {
              mention: "Sketch",
              type: "product",
              variations: [],
              facts: [],
              resolution: { kind: "hold", reason: "suppressed", candidates: [] },
            },
          ],
          relations: [],
          summary: "Sketch is mentioned.",
        },
      };
    });

    await runConsolidatedLoopShadow(
      {
        db,
        logger: createTestLogger(),
        agenticGenerator: generator,
        knownEntities: [{ reviewId: `review-${randomUUID()}`, name: "Sketch", type: "product" }],
      },
      file,
    );

    const [row] = await stages(db, fileId);
    const staged = JSON.parse(row.staged_json);
    expect(staged.mentions).toEqual([]);
    expect(staged.meta.guard).toMatchObject({ registryLinked: 0, suppressed: 1 });
  });

  it("does not use the registry rung for a person with a live registry id", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const personId = `entity-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    await seedEntity(db, personId, "Himanshu Kalra", "person");
    const generator = agenticGenerator(async (opts) => {
      const tool = opts.tools.find((candidate) => candidate.name === "match_mentions");
      if (!tool) throw new Error("match_mentions missing");
      const args = { mentions: [{ name: "Himanshu Kalra", type: "person" }] };
      const result = await tool.run(args);
      const match = JSON.parse(result).results[0];
      expect(match).toMatchObject({ status: "linked", entityId: personId });
      expect(match.rung).not.toBe("registry");
      const step: AgenticToolStep = {
        name: "match_mentions",
        args,
        result,
        durationMs: 1,
        cached: false,
      };
      await opts.onToolStep?.(step);
      return {
        toolSteps: [step],
        value: {
          mentions: [
            {
              mention: "Himanshu Kalra",
              type: "person",
              variations: [],
              facts: [],
              resolution: { kind: "matched", entityId: personId },
            },
          ],
          relations: [],
          summary: "Himanshu Kalra is mentioned.",
        },
      };
    });

    await runConsolidatedLoopShadow(
      {
        db,
        logger: createTestLogger(),
        agenticGenerator: generator,
        knownEntities: [{ entityId: personId, name: "Himanshu Kalra", type: "person" }],
      },
      file,
    );

    const [row] = await stages(db, fileId);
    const staged = JSON.parse(row.staged_json);
    expect(staged.mentions[0].resolution).toEqual({ kind: "matched", entityId: personId });
    expect(staged.meta.guard.registryLinked).toBe(0);
  });

  it("holds a judged candidate that the matcher found but the tool did not offer", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    const candidateIds = Array.from({ length: 5 }, () => `entity-${randomUUID()}`);
    for (const entityId of candidateIds) await seedEntity(db, entityId, "Alex Smith", "person");
    let unofferedId = "";
    const generator = agenticGenerator(async (opts) => {
      const tool = opts.tools.find((candidate) => candidate.name === "match_mentions");
      if (!tool) throw new Error("match_mentions missing");
      const overflow = await tool.run({
        mentions: Array.from({ length: 7 }, () => ({ name: "Alex Smith", type: "person" })),
      });
      expect(JSON.parse(overflow)).toEqual({ error: "batch_too_large", maxMentions: 6, received: 7 });
      const args = {
        mentions: Array.from({ length: 6 }, () => ({ name: "Alex Smith", type: "person" })),
      };
      const result = await tool.run(args);
      expect(result.length).toBeLessThanOrEqual(1900);
      const parsed = JSON.parse(result);
      expect(parsed.results).toHaveLength(6);
      expect(parsed.results.every((item: { candidates: unknown[] }) => item.candidates.length <= 3)).toBe(true);
      expect(parsed.results.every((item: { candidatesTruncated: boolean }) => item.candidatesTruncated)).toBe(true);
      const returnedIds = new Set(
        parsed.results.flatMap((item: { candidates: Array<{ entityId: string }> }) =>
          item.candidates.map((candidate) => candidate.entityId),
        ),
      );
      unofferedId = candidateIds.find((entityId) => !returnedIds.has(entityId)) ?? "";
      if (!unofferedId) throw new Error("expected a matcher candidate outside the compact tool result");
      const step: AgenticToolStep = {
        name: "match_mentions",
        args,
        result,
        durationMs: 1,
        cached: false,
      };
      await opts.onToolStep?.(step);
      return {
        toolSteps: [step],
        value: {
          mentions: [
            {
              mention: "Alex Smith",
              type: "person",
              variations: [],
              facts: ["Alex Smith discussed Project Atlas"],
              resolution: { kind: "judged", entityId: unofferedId, reason: "remembered identity" },
            },
          ],
          relations: [],
          summary: "Alex Smith discussed Project Atlas.",
        },
      };
    });

    await runConsolidatedLoopShadow({ db, logger: createTestLogger(), agenticGenerator: generator }, file);

    const [row] = await stages(db, fileId);
    const staged = JSON.parse(row.staged_json);
    expect(staged.mentions[0].resolution).toMatchObject({
      kind: "hold",
      reason: "unoffered_target",
    });
    expect(
      staged.mentions[0].resolution.candidates.map((candidate: { entityId: string }) => candidate.entityId).sort(),
    ).toEqual(candidateIds.sort());
    expect(staged.entityFacts).toEqual([]);
    expect(staged.meta.guard).toMatchObject({ demotedUnoffered: 1, droppedFacts: 1 });
  });

  it("retains rejected candidate ids when every offered ambiguous candidate is rejected", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    const candidateIds = [`entity-${randomUUID()}`, `entity-${randomUUID()}`];
    for (const entityId of candidateIds) await seedEntity(db, entityId, "Alex Smith", "person");
    const generator = agenticGenerator(async (opts) => {
      const tool = opts.tools.find((candidate) => candidate.name === "match_mentions");
      if (!tool) throw new Error("match_mentions missing");
      const args = { mentions: [{ name: "Alex Smith", type: "person" }] };
      const result = await tool.run(args);
      const parsed = JSON.parse(result) as {
        results: Array<{ candidates: Array<{ entityId: string }> }>;
      };
      const rejectedCandidates = parsed.results[0].candidates.map((candidate) => candidate.entityId);
      const step: AgenticToolStep = {
        name: "match_mentions",
        args,
        result,
        durationMs: 1,
        cached: false,
      };
      await opts.onToolStep?.(step);
      return {
        toolSteps: [step],
        value: {
          mentions: [
            {
              mention: "Alex Smith",
              type: "person",
              variations: [],
              facts: [],
              resolution: { kind: "new", rejectedCandidates },
            },
          ],
          relations: [],
          summary: "Alex Smith is a distinct person.",
        },
      };
    });

    await runConsolidatedLoopShadow({ db, logger: createTestLogger(), agenticGenerator: generator }, file);

    const [row] = await stages(db, fileId);
    const staged = JSON.parse(row.staged_json);
    expect(staged.mentions[0].resolution.kind).toBe("new");
    expect([...staged.mentions[0].resolution.rejectedCandidates].sort()).toEqual([...candidateIds].sort());
    expect(staged.meta.guard.newOverCandidates).toBe(1);
  });

  it("records a capped diagnostic sample for a schema-invalid mention", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    const generator = agenticGenerator(async () => ({
      value: {
        mentions: [
          {
            mention: "Legacy Resolution",
            variations: [],
            facts: [],
            resolution: { kind: "known", entityId: "x" },
          },
        ],
        relations: [],
        summary: "The malformed mention is dropped.",
      },
    }));

    await runConsolidatedLoopShadow({ db, logger: createTestLogger(), agenticGenerator: generator }, file);

    const [row] = await stages(db, fileId);
    const staged = JSON.parse(row.staged_json);
    expect(staged.mentions).toEqual([]);
    expect(staged.meta.validation).toMatchObject({
      droppedMentions: 1,
      schemaInvalid: 1,
      droppedSamples: [{ mention: "Legacy Resolution", type: "?", reason: "type" }],
    });
  });

  it("keeps a valid mention when its model resolution is malformed", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const entityId = `entity-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    await seedEntity(db, entityId, "Sketch", "product");
    await db.updateTable("entities").set({ provenance_tier: "declared" }).where("id", "=", entityId).execute();
    const generator = agenticGenerator(async () => ({
      value: {
        mentions: [
          {
            mention: "Sketch",
            type: "product",
            variations: [],
            facts: ["Sketch stores project context"],
            resolution: { kind: "known" },
          },
        ],
        relations: [],
        summary: "Sketch stores project context.",
      },
    }));

    await runConsolidatedLoopShadow({ db, logger: createTestLogger(), agenticGenerator: generator }, file);

    const [row] = await stages(db, fileId);
    const staged = JSON.parse(row.staged_json);
    expect(staged.mentions[0]).toMatchObject({
      mention: "Sketch",
      facts: ["Sketch stores project context"],
      resolution: { kind: "matched", entityId },
    });
    expect(staged.meta.validation).toMatchObject({
      malformedResolution: 1,
      malformedSamples: [{ mention: "Sketch", type: "product", reason: "?" }],
      droppedMentions: 0,
      schemaInvalid: 0,
    });
    expect(staged.meta.guard.overriddenByMatcher).toBe(1);
  });

  it("fills a bare model hold with matcher candidates and preserves mention facts", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    const candidateIds = [`entity-${randomUUID()}`, `entity-${randomUUID()}`];
    for (const entityId of candidateIds) await seedEntity(db, entityId, "Himanshu Kalra", "person");
    const generator = agenticGenerator(async () => ({
      value: {
        mentions: [
          {
            mention: "Himanshu Kalra",
            type: "person",
            variations: [],
            facts: ["Himanshu Kalra asked for a review"],
            resolution: { kind: "hold" },
          },
        ],
        relations: [],
        summary: "Himanshu Kalra asked for a review.",
      },
    }));

    await runConsolidatedLoopShadow({ db, logger: createTestLogger(), agenticGenerator: generator }, file);

    const [row] = await stages(db, fileId);
    const staged = JSON.parse(row.staged_json);
    expect(staged.mentions[0].resolution).toMatchObject({ kind: "hold", reason: "model_hold" });
    expect(
      staged.mentions[0].resolution.candidates.map((candidate: { entityId: string }) => candidate.entityId).sort(),
    ).toEqual([...candidateIds].sort());
    expect(staged.mentions[0].facts).toEqual(["Himanshu Kalra asked for a review"]);
    expect(staged.meta.validation.schemaInvalid).toBe(0);
    expect(staged.meta.guard.droppedFacts).toBe(1);
  });

  it("reconciles exact, ambiguous, and pending mentions safely without a match tool call", async () => {
    const fileId = `loop-file-${randomUUID()}`;
    const file = await seedFile(db, connectorId, fileId, "hash-one");
    const exactId = `entity-${randomUUID()}`;
    const ambiguousIds = [`entity-${randomUUID()}`, `entity-${randomUUID()}`];
    await seedEntity(db, exactId, "Exact Corp", "company");
    for (const entityId of ambiguousIds) await seedEntity(db, entityId, "Jordan Lee", "person");
    const pendingId = `review-${randomUUID()}`;
    await db
      .insertInto("entity_review_queue")
      .values({
        id: pendingId,
        proposed_name: "Pending Project",
        normalized_name: "pending project",
        entity_type: "project",
        status: "pending",
        triggered_by_user_id: "loop-user",
      })
      .execute();
    const generator = agenticGenerator(async () => ({
      value: {
        mentions: [
          {
            mention: "Exact Corp",
            type: "company",
            variations: [],
            facts: ["Exact Corp attended"],
            resolution: { kind: "matched", entityId: exactId },
          },
          {
            mention: "Jordan Lee",
            type: "person",
            variations: [],
            facts: ["Jordan Lee led the call"],
            resolution: { kind: "judged", entityId: ambiguousIds[0], reason: "from memory" },
          },
          {
            mention: "Pending Project",
            type: "project",
            variations: [],
            facts: ["Pending Project was announced"],
            resolution: { kind: "new" },
          },
        ],
        relations: [],
        summary: "Exact Corp attended while Jordan Lee discussed Pending Project.",
      },
    }));

    await runConsolidatedLoopShadow({ db, logger: createTestLogger(), agenticGenerator: generator }, file);

    const [row] = await stages(db, fileId);
    const staged = JSON.parse(row.staged_json);
    expect(staged.mentions.map((mention: { resolution: unknown }) => mention.resolution)).toEqual([
      { kind: "matched", entityId: exactId },
      expect.objectContaining({ kind: "hold", reason: "unoffered_target" }),
      expect.objectContaining({ kind: "hold", reason: "pending_proposal" }),
    ]);
    expect(staged.meta.guard).toMatchObject({
      demotedUnoffered: 1,
      heldPending: 1,
      matchToolCalled: false,
      matchToolCalls: 0,
    });
    expect(staged.meta.toolSteps.filter((step: { name: string }) => step.name === "match_mentions")).toHaveLength(0);
  });
});
