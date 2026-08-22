import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGraphVerdictRepository } from "../db/repositories/graph-verdicts";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { applyGraphVerdict, revertGraphVerdict } from "./verdict-apply";
import { containerVerdictFingerprint, fingerprintFor } from "./verdict-fingerprint";

const USER_ID = "verdict-apply-user";

async function seedUser(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: USER_ID, name: "Verdict Apply User" }).execute();
}

async function seedEntity(db: Kysely<DB>, id: string, name: string, sourceType = "project"): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: sourceType,
      subtype: null,
      aliases: "[]",
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    })
    .execute();
}

async function seedConnector(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: "clickup",
      auth_type: "api_key",
      credentials: "{}",
      created_by: USER_ID,
    })
    .execute();
}

async function seedSourceRef(db: Kysely<DB>, id: string, entityId: string, sourceId: string): Promise<void> {
  await db
    .insertInto("entity_source_refs")
    .values({
      id,
      entity_id: entityId,
      source: "clickup",
      source_id: sourceId,
      source_url: null,
      last_seen_at: "2026-08-22T00:00:00.000Z",
    })
    .execute();
}

async function seedContainer(
  db: Kysely<DB>,
  id: string,
  input?: { externalId?: string; name?: string; classifiedEntityId?: string | null },
): Promise<void> {
  await db
    .insertInto("containers")
    .values({
      id,
      connector_config_id: "verdict-connector",
      connector_type: "clickup",
      external_id: input?.externalId ?? id,
      level_key: "folder",
      name: input?.name ?? id,
      path_ids: JSON.stringify(["workspace"]),
      path_names: JSON.stringify(["Workspace"]),
      classified_entity_id: input?.classifiedEntityId ?? null,
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    })
    .execute();
}

async function seedRelationship(db: Kysely<DB>, id: string, sourceId: string, targetId: string): Promise<void> {
  await db
    .insertInto("entity_relationships")
    .values({
      id,
      source_entity_id: sourceId,
      target_entity_id: targetId,
      relationship_type: "related_to",
      confidence: "high",
      confidence_score: 1,
      source: "llm_extraction",
    })
    .execute();
}

async function storeContainerVerdict(
  db: Kysely<DB>,
  input: {
    containerId: string;
    subjectEntityId?: string | null;
    classification: "team" | "project" | "time_box" | "account" | "ignore";
    entityStatus?: "active" | "historical";
  },
): Promise<string> {
  const repo = createGraphVerdictRepository(db);
  const run = await repo.createRun({
    source: "test",
    proposedByUserId: USER_ID,
    tokenId: null,
    note: null,
    verdictsProposed: 1,
  });
  const container = await db
    .selectFrom("containers")
    .selectAll()
    .where("id", "=", input.containerId)
    .executeTakeFirstOrThrow();
  const stored = await repo.storeVerdicts([
    {
      runId: run.id,
      action: "classify_container",
      subjectEntityId: input.subjectEntityId ?? null,
      subjectContainerId: input.containerId,
      subjectName: container.name,
      subjectEntityType: "container_classification",
      targetEntityId: null,
      resolvedTargetEntityId: null,
      targetName: null,
      reason: `Classify ${container.name}.`,
      evidenceJson: JSON.stringify({
        classification: input.classification,
        entityStatus: input.entityStatus ?? "active",
        evidence: { source: "test" },
      }),
      evidenceFingerprint: containerVerdictFingerprint({ action: "classify_container", container }),
      validationStatus: "ok",
      validationReason: null,
      wouldChangeJson: JSON.stringify({ containers: 1 }),
      status: "awaiting_human",
    },
  ]);
  return stored.ids[0] ?? "";
}

describe("graph verdict apply", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("applies and reverts an archive verdict when only llm_extraction relationships reference the entity", async () => {
    await seedEntity(db, "archive-subject", "Archive Subject");
    await seedEntity(db, "archive-anchor", "Archive Anchor");
    await seedRelationship(db, "rel-outgoing-machine", "archive-subject", "archive-anchor");
    await seedRelationship(db, "rel-incoming-machine", "archive-anchor", "archive-subject");
    const subject = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", "archive-subject")
      .executeTakeFirstOrThrow();
    const repo = createGraphVerdictRepository(db);
    const run = await repo.createRun({
      source: "test",
      proposedByUserId: USER_ID,
      tokenId: null,
      note: null,
      verdictsProposed: 1,
    });
    const stored = await repo.storeVerdicts([
      {
        runId: run.id,
        action: "archive",
        subjectEntityId: subject.id,
        subjectName: subject.name,
        subjectEntityType: subject.source_type,
        targetEntityId: null,
        resolvedTargetEntityId: null,
        targetName: null,
        reason: "Archive extraction-only project.",
        evidenceJson: JSON.stringify({ fileIds: [], reviewIds: [], notes: ["machine edges do not vouch"] }),
        evidenceFingerprint: fingerprintFor({
          action: "archive",
          subject,
          target: null,
          evidence: { fileIds: [], reviewIds: [], notes: ["machine edges do not vouch"] },
        }),
        validationStatus: "ok",
        validationReason: null,
        wouldChangeJson: JSON.stringify({ entities: 1 }),
        status: "awaiting_human",
      },
    ]);
    const verdictId = stored.ids[0] ?? "";
    const approved = await repo.markApproved({ id: verdictId, actorUserId: USER_ID });
    expect(approved).toBe(true);

    const preview = await applyGraphVerdict(db, { verdictId, actorUserId: USER_ID, dryRun: true });
    expect(preview.status).toBe("approved");
    expect(preview.plan.state).toBe("applied");

    const applied = await applyGraphVerdict(db, { verdictId, actorUserId: USER_ID });

    expect(applied.status).toBe("applied");
    expect(applied.ledgerRef).toMatch(/^archived-at:/);
    const archivedAt = applied.ledgerRef?.slice("archived-at:".length) ?? "";
    await expect(
      db.selectFrom("entities").select("deleted_at").where("id", "=", "archive-subject").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deleted_at: archivedAt });
    await expect(
      db.selectFrom("entity_relationships").select("id").where("id", "like", "rel-%").execute(),
    ).resolves.toHaveLength(2);

    const reverted = await revertGraphVerdict(db, { verdictId, actorUserId: USER_ID });

    expect(reverted).toEqual({ verdictId, status: "reverted", ledgerRef: `archived-at:${archivedAt}` });
    await expect(
      db
        .selectFrom("graph_verdicts")
        .select(["status", "applied_ledger_ref"])
        .where("id", "=", verdictId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "reverted", applied_ledger_ref: `archived-at:${archivedAt}` });
    await expect(
      db.selectFrom("entities").select("deleted_at").where("id", "=", "archive-subject").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deleted_at: null });
    await expect(
      db.selectFrom("entity_relationships").select("id").where("id", "like", "rel-%").execute(),
    ).resolves.toHaveLength(2);
  });

  it("applies, replays, and undoes container classifications across outcomes", async () => {
    await seedConnector(db, "verdict-connector");
    await seedEntity(db, "legacy-project", "Legacy Container", "project");
    await seedSourceRef(db, "legacy-ref", "legacy-project", "legacy-container");
    await seedContainer(db, "retype-container", {
      externalId: "legacy-container",
      name: "Legacy Container",
      classifiedEntityId: "legacy-project",
    });
    await seedContainer(db, "mint-container", { name: "Minted Team" });
    await seedContainer(db, "label-container", { name: "Sprint Label" });
    await seedContainer(db, "drift-container", { name: "Drift Container" });

    const repo = createGraphVerdictRepository(db);
    const retypeId = await storeContainerVerdict(db, {
      containerId: "retype-container",
      subjectEntityId: "legacy-project",
      classification: "team",
    });
    await repo.markApproved({ id: retypeId, actorUserId: USER_ID });

    const retyped = await applyGraphVerdict(db, { verdictId: retypeId, actorUserId: USER_ID });
    expect(retyped.ledgerRef).toBe("retyped:legacy-project:project");
    await expect(
      db.selectFrom("entities").select("source_type").where("id", "=", "legacy-project").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ source_type: "team" });
    await expect(
      db
        .selectFrom("containers")
        .select(["classification", "classification_status", "classified_entity_id", "verdict_id"])
        .where("id", "=", "retype-container")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      classification: "team",
      classification_status: "active",
      classified_entity_id: "legacy-project",
      verdict_id: retypeId,
    });
    await expect(applyGraphVerdict(db, { verdictId: retypeId, actorUserId: USER_ID })).resolves.toMatchObject({
      ledgerRef: "retyped:legacy-project:project",
    });
    await revertGraphVerdict(db, { verdictId: retypeId, actorUserId: USER_ID });
    await expect(
      db.selectFrom("entities").select("source_type").where("id", "=", "legacy-project").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ source_type: "project" });
    await expect(
      db
        .selectFrom("containers")
        .select(["classification", "classification_status", "classified_entity_id", "verdict_id"])
        .where("id", "=", "retype-container")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      classification: null,
      classification_status: null,
      classified_entity_id: null,
      verdict_id: null,
    });

    const mintId = await storeContainerVerdict(db, { containerId: "mint-container", classification: "team" });
    await repo.markApproved({ id: mintId, actorUserId: USER_ID });
    const minted = await applyGraphVerdict(db, { verdictId: mintId, actorUserId: USER_ID });
    expect(minted.ledgerRef).toMatch(/^entity:/);
    const mintedEntityId = minted.ledgerRef?.slice("entity:".length) ?? "";
    await expect(applyGraphVerdict(db, { verdictId: mintId, actorUserId: USER_ID })).resolves.toMatchObject({
      ledgerRef: `entity:${mintedEntityId}`,
    });
    await expect(
      db
        .selectFrom("entity_source_refs")
        .select(["entity_id", "source", "source_id"])
        .where("entity_id", "=", mintedEntityId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ entity_id: mintedEntityId, source: "clickup", source_id: "mint-container" });
    await revertGraphVerdict(db, { verdictId: mintId, actorUserId: USER_ID });
    await expect(
      db.selectFrom("entities").select("deleted_at").where("id", "=", mintedEntityId).executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ deleted_at: expect.any(String) });

    const labelId = await storeContainerVerdict(db, { containerId: "label-container", classification: "time_box" });
    await repo.markApproved({ id: labelId, actorUserId: USER_ID });
    await expect(applyGraphVerdict(db, { verdictId: labelId, actorUserId: USER_ID })).resolves.toMatchObject({
      ledgerRef: "label:time_box",
    });
    await expect(db.selectFrom("entities").select("id").where("name", "=", "Sprint Label").execute()).resolves.toEqual(
      [],
    );
    await revertGraphVerdict(db, { verdictId: labelId, actorUserId: USER_ID });
    await expect(
      db
        .selectFrom("containers")
        .select(["classification", "verdict_id"])
        .where("id", "=", "label-container")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ classification: null, verdict_id: null });

    const driftId = await storeContainerVerdict(db, { containerId: "drift-container", classification: "team" });
    await repo.markApproved({ id: driftId, actorUserId: USER_ID });
    await db.updateTable("containers").set({ name: "Drifted Container" }).where("id", "=", "drift-container").execute();
    await expect(applyGraphVerdict(db, { verdictId: driftId, actorUserId: USER_ID })).rejects.toMatchObject({
      code: "STALE_VERDICT",
    });
    await expect(
      db
        .selectFrom("containers")
        .select(["classification", "verdict_id"])
        .where("id", "=", "drift-container")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ classification: null, verdict_id: null });
    await expect(
      db.selectFrom("graph_verdicts").select("status").where("id", "=", driftId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "approved" });
  });

  it("stores container verdict subjects uniquely while preserving entity verdict storage", async () => {
    await seedConnector(db, "verdict-connector");
    await seedEntity(db, "entity-subject", "Entity Subject");
    await seedContainer(db, "unique-container", { name: "Unique Container" });
    const repo = createGraphVerdictRepository(db);
    const firstId = await storeContainerVerdict(db, { containerId: "unique-container", classification: "team" });
    await repo.markApproved({ id: firstId, actorUserId: USER_ID });
    const run = await repo.createRun({
      source: "test",
      proposedByUserId: USER_ID,
      tokenId: null,
      note: null,
      verdictsProposed: 2,
    });
    const container = await db
      .selectFrom("containers")
      .selectAll()
      .where("id", "=", "unique-container")
      .executeTakeFirstOrThrow();
    const entity = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", "entity-subject")
      .executeTakeFirstOrThrow();

    const stored = await repo.storeVerdicts([
      {
        runId: run.id,
        action: "classify_container",
        subjectEntityId: null,
        subjectContainerId: container.id,
        subjectName: container.name,
        subjectEntityType: "container_classification",
        targetEntityId: null,
        resolvedTargetEntityId: null,
        targetName: null,
        reason: "Duplicate active container verdict.",
        evidenceJson: JSON.stringify({ classification: "team", entityStatus: "active" }),
        evidenceFingerprint: containerVerdictFingerprint({ action: "classify_container", container }),
        validationStatus: "ok",
        validationReason: null,
        wouldChangeJson: JSON.stringify({ containers: 1 }),
        status: "awaiting_human",
      },
      {
        runId: run.id,
        action: "archive",
        subjectEntityId: entity.id,
        subjectName: entity.name,
        subjectEntityType: entity.source_type,
        targetEntityId: null,
        resolvedTargetEntityId: null,
        targetName: null,
        reason: "Entity verdict still stores normally.",
        evidenceJson: JSON.stringify({ fileIds: [], reviewIds: [], notes: [] }),
        evidenceFingerprint: fingerprintFor({
          action: "archive",
          subject: entity,
          target: null,
          evidence: { fileIds: [], reviewIds: [], notes: [] },
        }),
        validationStatus: "ok",
        validationReason: null,
        wouldChangeJson: JSON.stringify({ entities: 1 }),
        status: "awaiting_human",
      },
    ]);

    expect(stored.rows[0]).toMatchObject({
      status: "bounced",
      validationReason: "approved_verdict_pending",
      subjectEntityId: null,
      subjectContainerId: "unique-container",
    });
    expect(stored.rows[1]).toMatchObject({
      status: "awaiting_human",
      subjectEntityId: "entity-subject",
    });
    const rows = await db
      .selectFrom("graph_verdicts")
      .select(["id", "subject_container_id", "subject_entity_id", "status", "validation_reason"])
      .where("id", "in", stored.ids)
      .orderBy("created_at", "asc")
      .execute();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject_container_id: "unique-container",
          subject_entity_id: null,
          status: "bounced",
          validation_reason: "approved_verdict_pending",
        }),
        expect.objectContaining({
          subject_container_id: null,
          subject_entity_id: "entity-subject",
          status: "awaiting_human",
          validation_reason: null,
        }),
      ]),
    );
  });
});
