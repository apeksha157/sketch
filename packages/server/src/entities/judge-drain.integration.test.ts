import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import type { AgenticOptions, AgenticOutcome } from "../connectors/openrouter-generate";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/machine-principal";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import { runJudgeDrain } from "./judge-drain";
import { normalizeEntityMatchName } from "./name-keys";

const USER_ID = "judge-drain-reviewer";
const NOW = "2026-08-29T00:00:00.000Z";

type StubVerdict = Record<string, unknown>;

function stubGenerator(verdicts: StubVerdict[]) {
  let index = 0;
  return async function generateAgenticJSON<T>(_prompt: string, opts: AgenticOptions): Promise<AgenticOutcome<T>> {
    opts.onMeta?.({
      outcome: "ok",
      rawText: JSON.stringify(verdicts[index] ?? { verdict: "hold", reason: "stub exhausted" }),
      durationMs: 10,
      model: opts.model ?? "test/judge",
      usage: { promptTokens: 100 + index, completionTokens: 10 + index },
      costUsd: 0.001 + index / 1000,
    });
    const value = (verdicts[index] ?? { verdict: "hold", reason: "stub exhausted" }) as T;
    index += 1;
    return {
      value,
      toolSteps: [],
      rounds: 1,
      meta: { outcome: "ok", rawText: JSON.stringify(value), durationMs: 10, model: opts.model ?? "test/judge" },
    };
  };
}

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: USER_ID, name: "Judge Drain Reviewer", email: "judge-drain@example.com" })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "judge-drain-config",
      connector_type: "gmail",
      auth_type: "system",
      credentials: "{}",
      created_by: USER_ID,
      scope_config: "{}",
      sync_status: "active",
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string, content = "Judge drain evidence."): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "judge-drain-config",
      provider_file_id: `provider:${id}`,
      file_name: `${id}.txt`,
      file_type: "text",
      content_category: "document",
      content,
      source: "gmail",
      synced_at: NOW,
    })
    .execute();
}

async function seedEntity(
  db: Kysely<DB>,
  input: { id: string; name: string; type?: string; provenanceTier?: string },
): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: input.type ?? "person",
      subtype: "external",
      aliases: null,
      metadata: null,
      status: "active",
      hotness: 0,
      provenance_tier: input.provenanceTier ?? "inferred",
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

async function seedReview(
  db: Kysely<DB>,
  input: { id: string; name: string; fileId: string; type?: string; firstSeenAt?: string },
): Promise<void> {
  const entityType = input.type ?? "person";
  await db
    .insertInto("entity_review_queue")
    .values({
      id: input.id,
      proposed_name: input.name,
      normalized_name: normalizeEntityMatchName(entityType, input.name),
      entity_type: entityType,
      source: "gmail",
      source_id: `source:${input.id}`,
      proposed_email: null,
      candidate_entity_id: null,
      candidate_score: null,
      candidate_reason: "judge-drain-test",
      candidate_generated_at: NOW,
      first_seen_at: input.firstSeenAt ?? NOW,
      last_seen_at: input.firstSeenAt ?? NOW,
      occurrence_count: 1,
      status: "pending",
      triggered_by_user_id: USER_ID,
    })
    .execute();
  await db
    .insertInto("entity_review_evidence")
    .values({
      id: randomUUID(),
      review_id: input.id,
      indexed_file_id: input.fileId,
      source: "gmail",
      seen_at: NOW,
    })
    .execute();
}

async function seedSingleTokenDocketRow(db: Kysely<DB>, input: { rowId: string; entityId: string; name: string }) {
  await seedFile(db, `${input.rowId}-file`, `${input.name} appears in a message.`);
  await seedEntity(db, { id: input.entityId, name: input.name });
  await seedReview(db, { id: input.rowId, name: input.name, fileId: `${input.rowId}-file` });
}

async function countTable(db: Kysely<DB>, table: keyof DB): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function mutationCounts(db: Kysely<DB>): Promise<Record<string, number>> {
  return {
    graph_verdicts: await countTable(db, "graph_verdicts"),
    resolution_decisions: await countTable(db, "resolution_decisions"),
    entity_review_queue: await countTable(db, "entity_review_queue"),
    entities: await countTable(db, "entities"),
    entity_aliases: await countTable(db, "entity_aliases"),
  };
}

describe("judge drain", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("links offered targets, demotes unoffered targets, and skips duplicate proposals on rerun", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    await seedSingleTokenDocketRow(db, { rowId: "review-a", entityId: "entity-alice", name: "Alice" });
    await seedSingleTokenDocketRow(db, { rowId: "review-b", entityId: "entity-bob", name: "Bob" });

    const first = await runJudgeDrain(
      {
        db,
        model: "test/judge",
        generateAgenticJSON: stubGenerator([
          { verdict: "link", entityId: "entity-alice", reason: "offered target" },
          { verdict: "link", entityId: "fabricated-id", reason: "bad target" },
        ]),
      },
      { propose: true },
    );

    expect(first.counts).toMatchObject({ link: 1, hold: 1 });
    expect(first.guard.demotedUnoffered).toBe(1);
    expect(first.verdicts.find((row) => row.rowId === "review-b")).toMatchObject({
      verdict: "hold",
      reason: "unoffered_target",
    });
    const rows = await db
      .selectFrom("graph_verdicts")
      .innerJoin("graph_verdict_runs", "graph_verdict_runs.id", "graph_verdicts.run_id")
      .select([
        "graph_verdicts.action",
        "graph_verdicts.subject_mention_name",
        "graph_verdicts.subject_entity_type",
        "graph_verdicts.target_entity_id",
        "graph_verdicts.status",
        "graph_verdict_runs.proposed_by_user_id",
      ])
      .execute();
    expect(rows).toEqual([
      {
        action: "link_to",
        subject_mention_name: normalizeEntityMatchName("person", "Alice"),
        subject_entity_type: "person",
        target_entity_id: "entity-alice",
        status: "awaiting_human",
        proposed_by_user_id: MACHINE_PRINCIPAL_USER_ID,
      },
    ]);

    const second = await runJudgeDrain(
      {
        db,
        model: "test/judge",
        generateAgenticJSON: stubGenerator([
          { verdict: "link", entityId: "entity-alice", reason: "offered target" },
          { verdict: "link", entityId: "fabricated-id", reason: "bad target" },
        ]),
      },
      { propose: true },
    );
    expect(second.proposed).toMatchObject({ filed: 0, alreadyProposed: 1 });
    expect(await countTable(db, "graph_verdicts")).toBe(1);
  });

  it("reports contaminated candidate pairs and files merge proposals without resolving the row", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    await seedFile(db, "akansha-file", "Akansha is the same person as Akanksha in this thread.");
    await seedFile(db, "akanksha-file", "Akanksha appears without independent identity evidence.");
    await seedEntity(db, { id: "entity-akansha", name: "Akansha" });
    await seedEntity(db, { id: "entity-akanksha", name: "Akanksha" });
    await seedReview(db, {
      id: "review-akansha",
      name: "Akansha",
      fileId: "akansha-file",
      firstSeenAt: "2026-08-29T00:00:00.000Z",
    });
    await seedReview(db, {
      id: "review-akanksha",
      name: "Akanksha",
      fileId: "akanksha-file",
      firstSeenAt: "2026-08-29T00:01:00.000Z",
    });

    const report = await runJudgeDrain(
      {
        db,
        model: "test/judge",
        generateAgenticJSON: stubGenerator([
          {
            verdict: "merge",
            mergePair: ["entity-akansha", "entity-akanksha"],
            reason: "one edit apart and same evidence cluster",
          },
          { verdict: "link", entityId: "entity-akansha", reason: "model claims link despite contamination" },
        ]),
      },
      { propose: true },
    );

    expect(report.verdicts.every((row) => row.contaminated.length > 0)).toBe(true);
    expect(report.counts).toMatchObject({ merge: 1, link: 1 });
    await expect(
      db
        .selectFrom("graph_verdicts")
        .select(["action", "subject_entity_id", "subject_mention_name", "target_entity_id", "status"])
        .orderBy("action", "asc")
        .execute(),
    ).resolves.toEqual([
      {
        action: "link_to",
        subject_entity_id: null,
        subject_mention_name: normalizeEntityMatchName("person", "Akanksha"),
        target_entity_id: "entity-akansha",
        status: "awaiting_human",
      },
      {
        action: "merge_into",
        subject_entity_id: "entity-akansha",
        subject_mention_name: null,
        target_entity_id: "entity-akanksha",
        status: "awaiting_human",
      },
    ]);
    await expect(
      db
        .selectFrom("entity_review_queue")
        .select(["id", "status", "resolved_entity_id"])
        .where("id", "in", ["review-akansha", "review-akanksha"])
        .orderBy("id", "asc")
        .execute(),
    ).resolves.toEqual([
      { id: "review-akanksha", status: "pending", resolved_entity_id: null },
      { id: "review-akansha", status: "pending", resolved_entity_id: null },
    ]);
  });

  it("keeps report-only runs read-only apart from usage telemetry", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    await seedSingleTokenDocketRow(db, { rowId: "review-link", entityId: "entity-link", name: "Linkable" });
    await seedSingleTokenDocketRow(db, { rowId: "review-dismiss", entityId: "entity-dismiss", name: "Dismissable" });
    await seedSingleTokenDocketRow(db, { rowId: "review-hold", entityId: "entity-hold", name: "Holdable" });
    await seedFile(db, "merge-file", "Marina and Marinaa look duplicated.");
    await seedEntity(db, { id: "entity-marina", name: "Marina" });
    await seedEntity(db, { id: "entity-marinaa", name: "Marinaa" });
    await seedReview(db, { id: "review-merge", name: "Marina", fileId: "merge-file" });
    const before = await mutationCounts(db);

    const report = await runJudgeDrain(
      {
        db,
        model: "test/judge",
        generateAgenticJSON: stubGenerator([
          { verdict: "dismiss", reason: "not an entity" },
          { verdict: "hold", reason: "insufficient evidence" },
          { verdict: "link", entityId: "entity-link", reason: "offered target" },
          { verdict: "merge", mergePair: ["entity-marina", "entity-marinaa"], reason: "one edit apart" },
        ]),
      },
      { propose: false },
    );

    expect(report.counts).toMatchObject({ link: 1, dismiss: 1, merge: 1, hold: 1 });
    expect(await mutationCounts(db)).toEqual(before);
    expect(await countTable(db, "llm_usage_events")).toBe(4);
  });
});
