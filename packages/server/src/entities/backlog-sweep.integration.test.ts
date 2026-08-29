import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { recordAlias } from "../db/repositories/entity-alias-rows";
import { createResolutionDecisionRepository } from "../db/repositories/resolution-decisions";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import { runBacklogSweep } from "./backlog-sweep";
import { normalizeEntityMatchName } from "./name-keys";

const REVIEWER_ID = "backlog-reviewer";
const NOW = "2026-08-29T00:00:00.000Z";

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: REVIEWER_ID, name: "Backlog Reviewer", email: "backlog-reviewer@example.com" })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "backlog-config",
      connector_type: "gmail",
      auth_type: "system",
      credentials: "{}",
      created_by: REVIEWER_ID,
      scope_config: "{}",
      sync_status: "active",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "backlog-config",
      provider_file_id: `provider:${id}`,
      file_name: `${id}.txt`,
      content_category: "document",
      source: "gmail",
      synced_at: NOW,
    })
    .execute();
}

async function seedEntity(
  db: Kysely<DB>,
  input: {
    id: string;
    name: string;
    type?: string;
    metadata?: Record<string, unknown>;
    provenanceTier?: string;
    aliases?: string[];
  },
): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: input.type ?? "person",
      status: "active",
      subtype: "external",
      aliases: input.aliases ? JSON.stringify(input.aliases) : null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      provenance_tier: input.provenanceTier ?? "inferred",
      hotness: 0,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

async function seedReview(
  db: Kysely<DB>,
  input: { id: string; name: string; fileId: string; type?: string; proposedEmail?: string | null },
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
      proposed_email: input.proposedEmail ?? null,
      candidate_entity_id: null,
      candidate_score: null,
      candidate_reason: "exact-ambiguous",
      candidate_generated_at: NOW,
      status: "pending",
      triggered_by_user_id: REVIEWER_ID,
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

async function countRows(db: Kysely<DB>): Promise<Record<string, number>> {
  const [queue, decisions, entities, aliases] = await Promise.all([
    db
      .selectFrom("entity_review_queue")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("resolution_decisions")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("entities")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("entity_aliases")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow(),
  ]);
  return {
    entity_review_queue: Number(queue.count),
    resolution_decisions: Number(decisions.count),
    entities: Number(entities.count),
    entity_aliases: Number(aliases.count),
  };
}

async function reviewStatus(db: Kysely<DB>, id: string) {
  return db
    .selectFrom("entity_review_queue")
    .select(["status", "resolved_by", "resolved_entity_id"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

describe("backlog sweep", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("links unique multi-token exact rows and leaves multi-match and single-token exact rows pending", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    await Promise.all([seedFile(db, "happy-file"), seedFile(db, "multi-file"), seedFile(db, "single-file")]);
    await seedEntity(db, { id: "target-anaya", name: "Anaya Rao" });
    await seedEntity(db, { id: "target-sam-1", name: "Samir One", aliases: ["Samir"] });
    await seedEntity(db, { id: "target-sam-2", name: "Samir Two", aliases: ["Samir"] });
    await seedEntity(db, { id: "target-rahul", name: "Rahul" });
    await recordAlias(db, { entityId: "target-sam-1", alias: "Samir", provenance: "human_confirmed" });
    await recordAlias(db, { entityId: "target-sam-2", alias: "Samir", provenance: "human_confirmed" });
    await seedReview(db, { id: "review-anaya", name: "Anaya Rao", fileId: "happy-file" });
    await seedReview(db, { id: "review-samir", name: "Samir", fileId: "multi-file" });
    await seedReview(db, { id: "review-rahul", name: "Rahul", fileId: "single-file" });

    const result = await runBacklogSweep({ db }, { apply: true });

    expect(result).toMatchObject({
      scanned: 3,
      blockedByDistinct: 0,
      skippedSingleTokenExact: 1,
      skippedEmailConflict: 0,
      adjacencyContested: 0,
      adjacencyVetoed: 0,
      unmatched: 0,
      multiMatch: 1,
    });
    expect(result.linked).toEqual([{ reviewId: "review-anaya", targetEntityId: "target-anaya", rung: "exact" }]);
    await expect(reviewStatus(db, "review-anaya")).resolves.toEqual({
      status: "confirmed",
      resolved_by: MACHINE_PRINCIPAL_USER_ID,
      resolved_entity_id: "target-anaya",
    });
    await expect(reviewStatus(db, "review-samir")).resolves.toMatchObject({ status: "pending" });
    await expect(reviewStatus(db, "review-rahul")).resolves.toMatchObject({ status: "pending" });
    await expect(
      db.selectFrom("entities").select("provenance_tier").where("id", "=", "target-anaya").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ provenance_tier: "machine_confirmed" });
    await expect(
      db
        .selectFrom("resolution_decisions")
        .select(["normalized_mention_name", "target_entity_id", "decider", "decided_by", "verdict"])
        .where("normalized_mention_name", "=", "anaya rao")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      normalized_mention_name: "anaya rao",
      target_entity_id: "target-anaya",
      decider: "backlog_sweep",
      decided_by: MACHINE_PRINCIPAL_USER_ID,
      verdict: "link",
    });
  });

  it("honors active ledger links and distinct decisions before exact matching", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    await Promise.all([seedFile(db, "ledger-link-file"), seedFile(db, "distinct-file")]);
    await seedEntity(db, { id: "ledger-target", name: "Ledger Canonical" });
    await seedEntity(db, { id: "blocked-target", name: "Blocked Alias" });
    const ledger = createResolutionDecisionRepository(db);
    await ledger.recordLink({
      normalizedMentionName: normalizeEntityMatchName("person", "Old Nickname"),
      entityType: "person",
      targetEntityId: "ledger-target",
      targetName: "Ledger Canonical",
      decider: "human",
      decidedBy: REVIEWER_ID,
      source: "test",
      sourceId: "ledger-link",
    });
    await ledger.recordDistinct({
      normalizedMentionName: normalizeEntityMatchName("person", "Blocked Alias"),
      entityType: "person",
      targetEntityId: "blocked-target",
      targetName: "Blocked Alias",
      decider: "human",
      decidedBy: REVIEWER_ID,
      source: "test",
      sourceId: "distinct",
    });
    await seedReview(db, { id: "review-ledger", name: "Old Nickname", fileId: "ledger-link-file" });
    await seedReview(db, { id: "review-blocked", name: "Blocked Alias", fileId: "distinct-file" });

    const result = await runBacklogSweep({ db }, { apply: true });

    expect(result.linked).toEqual([{ reviewId: "review-ledger", targetEntityId: "ledger-target", rung: "ledger" }]);
    expect(result.blockedByDistinct).toBe(1);
    await expect(reviewStatus(db, "review-ledger")).resolves.toMatchObject({
      status: "confirmed",
      resolved_entity_id: "ledger-target",
    });
    await expect(reviewStatus(db, "review-blocked")).resolves.toMatchObject({ status: "pending" });
  });

  it("is idempotent after applying and dry-run reports links without writing", async () => {
    db = await createTestPgDb();
    await seedBase(db);
    await seedFile(db, "idempotent-file");
    await seedEntity(db, { id: "idempotent-target", name: "Ida Potent" });
    await seedReview(db, { id: "review-idempotent", name: "Ida Potent", fileId: "idempotent-file" });

    const applied = await runBacklogSweep({ db }, { apply: true });
    const beforeSecondRun = await countRows(db);
    const second = await runBacklogSweep({ db }, { apply: true });
    const afterSecondRun = await countRows(db);

    expect(applied.linked).toEqual([
      { reviewId: "review-idempotent", targetEntityId: "idempotent-target", rung: "exact" },
    ]);
    expect(second.linked).toEqual([]);
    expect(afterSecondRun).toEqual(beforeSecondRun);

    const freshDb = await createTestPgDb();
    try {
      await seedBase(freshDb);
      await seedFile(freshDb, "dry-file");
      await seedEntity(freshDb, { id: "dry-target", name: "Dry Runner" });
      await seedReview(freshDb, { id: "review-dry", name: "Dry Runner", fileId: "dry-file" });
      const beforeDryRun = await countRows(freshDb);
      const dryRun = await runBacklogSweep({ db: freshDb });
      const afterDryRun = await countRows(freshDb);

      expect(dryRun.linked).toEqual([{ reviewId: "review-dry", targetEntityId: "dry-target", rung: "exact" }]);
      expect(afterDryRun).toEqual(beforeDryRun);
      await expect(reviewStatus(freshDb, "review-dry")).resolves.toMatchObject({ status: "pending" });
    } finally {
      await freshDb.destroy();
    }
  });
});
