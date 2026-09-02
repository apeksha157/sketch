import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import { confirmReview, linkReviewRowToExistingEntity } from "./resolve";

describe("entity resolve typed file access", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("writes typed file access rows on Postgres", async () => {
    db = await createTestPgDb();
    const entityRepo = createEntityRepository(db);
    const reviewRepo = createEntityReviewRepo(db);
    await db
      .insertInto("connector_configs")
      .values({
        id: "resolve-pg-config",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "resolve-user",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "resolve-pg-file",
        connector_config_id: "resolve-pg-config",
        provider_file_id: "resolve-pg-provider-file",
        file_name: "Transcript",
        file_type: "meeting_transcript",
        content_category: "document",
        source: "fireflies",
        synced_at: new Date().toISOString(),
      })
      .execute();

    const target = await entityRepo.upsertPersonEntity({
      name: "Resolve Target",
      email: "resolve@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "resolve-target",
    });
    const queued = await reviewRepo.upsertSeedReviewRow({
      proposedName: "Resolve Target Alias",
      normalizedName: "resolve target alias",
      entityType: "person",
      seedSource: "fireflies",
      seedSourceId: "resolve-proposal",
      candidateEntityId: target.id,
      triggeredByUserId: "resolve-user",
    });
    await reviewRepo.upsertEvidence({ reviewId: queued.row.id, indexedFileId: "resolve-pg-file", source: "fireflies" });
    const row = await reviewRepo.getById(queued.row.id);
    if (!row?.candidate_generated_at) throw new Error("missing candidate timestamp");

    await confirmReview({ db, userId: "resolve-user" }, queued.row.id, {
      candidateGeneratedAt: row.candidate_generated_at,
    });

    await expect(db.selectFrom("file_access").select(["principal_type", "principal_value"]).execute()).resolves.toEqual(
      [{ principal_type: "email", principal_value: "resolve@example.com" }],
    );
  }, 30000);

  it("links an existing entity through the safe core without human-only side effects", async () => {
    db = await createTestPgDb();
    const entityRepo = createEntityRepository(db);
    const reviewRepo = createEntityReviewRepo(db);
    const now = "2026-08-29T00:00:00.000Z";
    await db
      .insertInto("users")
      .values({ id: "human-reviewer", name: "Human Reviewer", email: "human-reviewer@example.com" })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: "resolve-safe-core-config",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "human-reviewer",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values([
        {
          id: "resolve-safe-human-file",
          connector_config_id: "resolve-safe-core-config",
          provider_file_id: "resolve-safe-human-provider",
          file_name: "Human Transcript",
          file_type: "meeting_transcript",
          content_category: "document",
          source: "fireflies",
          synced_at: now,
        },
        {
          id: "resolve-safe-machine-file",
          connector_config_id: "resolve-safe-core-config",
          provider_file_id: "resolve-safe-machine-provider",
          file_name: "Machine Transcript",
          file_type: "meeting_transcript",
          content_category: "document",
          source: "fireflies",
          synced_at: now,
        },
      ])
      .execute();

    const humanTarget = await entityRepo.upsertPersonEntity({
      name: "Asha Rao",
      email: "asha.human@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "asha-human",
    });
    const machineTarget = await entityRepo.upsertPersonEntity({
      name: "Bina Iyer",
      email: "bina.machine@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "bina-machine",
    });
    const humanReviewId = randomUUID();
    const machineReviewId = randomUUID();
    await db
      .insertInto("entity_review_queue")
      .values([
        {
          id: humanReviewId,
          proposed_name: "Asha R.",
          normalized_name: "asha r.",
          entity_type: "person",
          source: "fireflies",
          source_id: "safe-core-human",
          candidate_entity_id: humanTarget.id,
          candidate_score: 0.9,
          candidate_reason: "match",
          candidate_generated_at: now,
          first_seen_at: now,
          last_seen_at: now,
          occurrence_count: 1,
          status: "pending",
          triggered_by_user_id: "human-reviewer",
        },
        {
          id: machineReviewId,
          proposed_name: "Bina I.",
          normalized_name: "bina i.",
          entity_type: "person",
          source: "fireflies",
          source_id: "safe-core-machine",
          candidate_entity_id: machineTarget.id,
          candidate_score: 0.9,
          candidate_reason: "match",
          candidate_generated_at: now,
          first_seen_at: now,
          last_seen_at: now,
          occurrence_count: 1,
          status: "pending",
          triggered_by_user_id: "human-reviewer",
        },
      ])
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values([
        {
          id: randomUUID(),
          review_id: humanReviewId,
          indexed_file_id: "resolve-safe-human-file",
          source: "fireflies",
          seen_at: now,
        },
        {
          id: randomUUID(),
          review_id: machineReviewId,
          indexed_file_id: "resolve-safe-machine-file",
          source: "fireflies",
          seen_at: now,
        },
      ])
      .execute();
    await db
      .insertInto("entity_candidates")
      .values({
        id: "resolve-safe-domain-candidate",
        name: "Example",
        type: "company",
        variations: "[]",
        first_seen_file_id: "resolve-safe-machine-file",
        seen_file_ids: JSON.stringify(["resolve-safe-machine-file"]),
        seen_count: 1,
        promoted_entity_id: null,
        created_at: now,
        updated_at: now,
        domain: "example.com",
        proposed_company_name: "Example",
        first_observed_by_user_id: "human-reviewer",
        observed_person_entity_ids: "[]",
        evidence_file_ids: JSON.stringify(["resolve-safe-machine-file"]),
      })
      .execute();
    await db
      .insertInto("entity_review_domain_candidates")
      .values({ review_id: machineReviewId, domain_candidate_id: "resolve-safe-domain-candidate" })
      .execute();

    const machineAliasRowsBefore = await db
      .selectFrom("entity_aliases")
      .selectAll()
      .where("entity_id", "=", machineTarget.id)
      .orderBy("normalized_alias")
      .execute();
    const machineBlobBefore = await db
      .selectFrom("entities")
      .select("aliases")
      .where("id", "=", machineTarget.id)
      .executeTakeFirstOrThrow();

    const human = await confirmReview({ db, userId: "human-reviewer" }, humanReviewId, { candidateGeneratedAt: now });
    const machine = await linkReviewRowToExistingEntity(
      { db, userId: MACHINE_PRINCIPAL_USER_ID, machineActor: true },
      { reviewId: machineReviewId, entityId: machineTarget.id },
    );

    expect(human.row.status).toBe("confirmed");
    expect(machine.row.status).toBe("confirmed");
    expect(machine.row.resolved_by).toBe(MACHINE_PRINCIPAL_USER_ID);
    expect(machine.row.resolved_entity_id).toBe(machineTarget.id);
    const mentions = await db
      .selectFrom("entity_mentions")
      .select(["confidence", "source", "relation"])
      .where("entity_id", "in", [humanTarget.id, machineTarget.id])
      .execute();
    expect(mentions).toHaveLength(2);
    expect(mentions).toEqual(
      expect.arrayContaining([
        { confidence: "EXTRACTED", source: "fireflies", relation: "attended" },
        { confidence: "EXTRACTED", source: "fireflies", relation: "attended" },
      ]),
    );
    const access = await db
      .selectFrom("file_access")
      .select(["indexed_file_id", "principal_type"])
      .where("indexed_file_id", "in", ["resolve-safe-human-file", "resolve-safe-machine-file"])
      .execute();
    expect(access).toEqual(
      expect.arrayContaining([
        { indexed_file_id: "resolve-safe-human-file", principal_type: "email" },
        { indexed_file_id: "resolve-safe-machine-file", principal_type: "email" },
      ]),
    );
    const sourceRefs = await db
      .selectFrom("entity_source_refs")
      .select(["entity_id", "source"])
      .where("entity_id", "in", [humanTarget.id, machineTarget.id])
      .where("source", "=", "fireflies")
      .execute();
    expect(sourceRefs).toEqual(
      expect.arrayContaining([
        { entity_id: humanTarget.id, source: "fireflies" },
        { entity_id: machineTarget.id, source: "fireflies" },
      ]),
    );
    await expect(
      db
        .selectFrom("entity_aliases")
        .selectAll()
        .where("entity_id", "=", machineTarget.id)
        .orderBy("normalized_alias")
        .execute(),
    ).resolves.toEqual(machineAliasRowsBefore);
    const machineEntity = await db
      .selectFrom("entities")
      .select("aliases")
      .where("id", "=", machineTarget.id)
      .executeTakeFirstOrThrow();
    expect(machineEntity.aliases).toEqual(machineBlobBefore.aliases);
    await expect(db.selectFrom("entity_alias_rejections").selectAll().execute()).resolves.toEqual([]);
    await expect(
      db
        .selectFrom("entity_candidates")
        .select("promoted_entity_id")
        .where("id", "=", "resolve-safe-domain-candidate")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ promoted_entity_id: null });
  }, 30000);
});
