import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import { createResolutionDecisionRepository } from "../db/repositories/resolution-decisions";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import { buildMaterializeDeps } from "./materialize-deps";
import { normalizeEntityMatchName } from "./name-keys";
import { proposeEntity } from "./propose";
import { strongestProvenanceTier, toProvenanceTier } from "./provenance";
import { recreateEntityGraph, resetDerivedEntityData } from "./recreate";
import { confirmReview, linkReviewRowToExistingEntity, rejectReview } from "./resolve";

describe("resolution decisions", () => {
  let db: Kysely<DB> | undefined;
  const now = "2026-08-29T00:00:00.000Z";

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  async function seedConnector(db: Kysely<DB>): Promise<void> {
    await db
      .insertInto("users")
      .values({ id: "reviewer", name: "Reviewer", email: "reviewer@example.com" })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: "resolution-config",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "reviewer",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  }

  async function seedFile(db: Kysely<DB>, id: string, providerFileId: string): Promise<void> {
    await db
      .insertInto("indexed_files")
      .values({
        id,
        connector_config_id: "resolution-config",
        provider_file_id: providerFileId,
        file_name: providerFileId,
        file_type: "meeting_transcript",
        content_category: "document",
        source: "fireflies",
        synced_at: now,
      })
      .execute();
  }

  async function seedAttendeeFact(db: Kysely<DB>, fileId: string, name: string, sourceId: string): Promise<void> {
    await createIndexedFileFactRepository(db).upsertFact({
      indexedFileId: fileId,
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: name,
      subjectEmail: null,
      subjectSource: "fireflies",
      subjectSourceId: sourceId,
    });
  }

  async function seedReview(
    db: Kysely<DB>,
    input: { id: string; proposedName: string; candidateEntityId: string | null; fileId: string },
  ): Promise<void> {
    await db
      .insertInto("entity_review_queue")
      .values({
        id: input.id,
        proposed_name: input.proposedName,
        normalized_name: normalizeEntityMatchName("person", input.proposedName),
        entity_type: "person",
        source: "fireflies",
        source_id: `source:${input.id}`,
        candidate_entity_id: input.candidateEntityId,
        candidate_score: input.candidateEntityId ? 0.9 : null,
        candidate_reason: input.candidateEntityId ? "prefix" : "birth-gated",
        candidate_generated_at: now,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 1,
        status: "pending",
        triggered_by_user_id: "reviewer",
      })
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: randomUUID(),
        review_id: input.id,
        indexed_file_id: input.fileId,
        source: "fireflies",
        seen_at: now,
      })
      .execute();
  }

  it("replays confirmed links through recreate and keeps refused pairings from auto-linking", async () => {
    db = await createTestPgDb();
    await seedConnector(db);
    await seedFile(db, "human-file", "human-provider");
    await seedFile(db, "machine-file", "machine-provider");
    await seedFile(db, "refused-file", "refused-provider");
    await seedAttendeeFact(db, "human-file", "Human Alias", "fact:human");
    await seedAttendeeFact(db, "machine-file", "Machine Alias", "fact:machine");
    await seedAttendeeFact(db, "refused-file", "Refused Alias", "fact:refused");

    const entityRepo = createEntityRepository(db);
    const humanTarget = await entityRepo.upsertPersonEntity({
      name: "Human Target",
      subtype: "external",
      source: "seed",
      sourceId: "human-target",
    });
    const machineTarget = await entityRepo.upsertPersonEntity({
      name: "Machine Target",
      subtype: "external",
      source: "seed",
      sourceId: "machine-target",
    });
    const refusedCandidate = await entityRepo.createEntity({
      name: "Refused Alias Candidate",
      sourceType: "person",
      subtype: "external",
      provenanceTier: "human_confirmed",
    });

    await seedReview(db, {
      id: "human-review",
      proposedName: "Human Alias",
      candidateEntityId: humanTarget.id,
      fileId: "human-file",
    });
    await seedReview(db, {
      id: "machine-review",
      proposedName: "Machine Alias",
      candidateEntityId: machineTarget.id,
      fileId: "machine-file",
    });
    await seedReview(db, {
      id: "refused-review",
      proposedName: "Refused Alias",
      candidateEntityId: refusedCandidate.id,
      fileId: "refused-file",
    });

    await confirmReview({ db, userId: "reviewer" }, "human-review", { candidateGeneratedAt: now });
    await linkReviewRowToExistingEntity(
      { db, userId: MACHINE_PRINCIPAL_USER_ID, machineActor: true },
      { reviewId: "machine-review", entityId: machineTarget.id },
    );
    await rejectReview({ db, userId: "reviewer" }, "refused-review", { candidateGeneratedAt: now });

    await recreateEntityGraph({
      db,
      logger: createTestLogger(),
      triggeredByUserId: "reviewer",
      skipEnrichment: true,
      llmPromotionThreshold: 1,
      materializeFactTypes: ["attendee"],
    });

    const tiers = await db
      .selectFrom("entities")
      .select(["id", "provenance_tier"])
      .where("id", "in", [humanTarget.id, machineTarget.id])
      .orderBy("id", "asc")
      .execute();
    expect(Object.fromEntries(tiers.map((row) => [row.id, row.provenance_tier]))).toEqual({
      [humanTarget.id]: "human_confirmed",
      [machineTarget.id]: "machine_confirmed",
    });
    const mentions = await db
      .selectFrom("entity_mentions")
      .select(["indexed_file_id", "entity_id"])
      .where("indexed_file_id", "in", ["human-file", "machine-file", "refused-file"])
      .orderBy("indexed_file_id", "asc")
      .execute();
    expect(mentions).toEqual([
      { indexed_file_id: "human-file", entity_id: humanTarget.id },
      { indexed_file_id: "machine-file", entity_id: machineTarget.id },
      expect.objectContaining({ indexed_file_id: "refused-file" }),
    ]);
    expect(mentions.find((row) => row.indexed_file_id === "refused-file")?.entity_id).not.toBe(refusedCandidate.id);
  }, 30000);

  it("heals a dead link target only for one descriptor match and supersedes stale rows on fresh confirm", async () => {
    db = await createTestPgDb();
    await seedConnector(db);
    await seedFile(db, "descriptor-file", "descriptor-provider");
    const entityRepo = createEntityRepository(db);
    const ledger = createResolutionDecisionRepository(db);
    const deadTarget = await entityRepo.createEntity({ name: "Canonical Target", sourceType: "person" });
    const liveTarget = await entityRepo.createEntity({ name: "Canonical Target", sourceType: "person" });
    await db.deleteFrom("entities").where("id", "=", deadTarget.id).execute();

    await ledger.recordLink({
      normalizedMentionName: normalizeEntityMatchName("person", "Ledger Alias"),
      entityType: "person",
      targetEntityId: deadTarget.id,
      targetName: deadTarget.name,
      decider: "human",
      decidedBy: "reviewer",
      source: "test",
      sourceId: "dead-link",
    });

    let deps = await buildMaterializeDeps(db);
    const healed = await proposeEntity(deps, {
      name: "Ledger Alias",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "descriptor-healed",
      evidence: [{ indexedFileId: "descriptor-file" }],
      triggeredByUserId: "reviewer",
    });
    expect(healed).toMatchObject({ kind: "linked", entity: { id: liveTarget.id } });
    await expect(
      db
        .selectFrom("resolution_decisions")
        .select(["target_entity_id", "status"])
        .where("source_id", "=", "dead-link")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ target_entity_id: liveTarget.id, status: "active" });

    const secondLiveTarget = await entityRepo.createEntity({ name: "Canonical Target", sourceType: "person" });
    await ledger.recordLink({
      normalizedMentionName: normalizeEntityMatchName("person", "Ledger Alias Two"),
      entityType: "person",
      targetEntityId: deadTarget.id,
      targetName: deadTarget.name,
      decider: "human",
      decidedBy: "reviewer",
      source: "test",
      sourceId: "stale-link",
    });
    deps = await buildMaterializeDeps(db);
    const staleFallthrough = await proposeEntity(deps, {
      name: "Ledger Alias Two",
      entityType: "person",
      subtype: "external",
      source: "fireflies",
      sourceId: "descriptor-stale",
      evidence: [{ indexedFileId: "descriptor-file" }],
      triggeredByUserId: "reviewer",
      queueInsteadOfCreate: true,
    });
    if (staleFallthrough.kind !== "queued") throw new Error(`expected queued, got ${staleFallthrough.kind}`);
    await expect(
      db
        .selectFrom("resolution_decisions")
        .select("status")
        .where("source_id", "=", "stale-link")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "stale" });

    const queued = await createEntityReviewRepo(db).getById(staleFallthrough.reviewId);
    if (!queued?.candidate_generated_at) throw new Error("missing queued candidate timestamp");
    await confirmReview({ db, userId: "reviewer" }, queued.id, {
      candidateGeneratedAt: queued.candidate_generated_at,
      mergeIntoEntityId: secondLiveTarget.id,
    });
    await expect(
      db
        .selectFrom("resolution_decisions")
        .select(["target_entity_id", "status"])
        .where("normalized_mention_name", "=", normalizeEntityMatchName("person", "Ledger Alias Two"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ target_entity_id: secondLiveTarget.id, status: "active" });
  }, 30000);

  it("keeps machine-confirmed tier semantics below human authority and through reset", async () => {
    db = await createTestPgDb();
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values([
        {
          id: "machine-survivor",
          name: "Machine Survivor",
          source_type: "person",
          status: "confirmed",
          provenance_tier: "machine_confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
        {
          id: "derived-loser",
          name: "Derived Loser",
          source_type: "person",
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    expect(toProvenanceTier("machine_confirmed")).toBe("machine_confirmed");
    expect(strongestProvenanceTier("human_confirmed", "machine_confirmed")).toBe("human_confirmed");
    expect(strongestProvenanceTier("inferred", "machine_confirmed")).toBe("machine_confirmed");

    await resetDerivedEntityData(db, createTestLogger());
    await expect(db.selectFrom("entities").select("id").orderBy("id", "asc").execute()).resolves.toEqual([
      { id: "machine-survivor" },
    ]);
  }, 30000);
});
