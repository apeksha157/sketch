import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { listAliasRows } from "../db/repositories/entity-alias-rows";
import { mergeEntityAliases } from "../db/repositories/entity-aliases";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { createGraphVerdictRepository } from "../db/repositories/graph-verdicts";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import { parseAliasesString } from "./materialize-json";
import { normalizeName } from "./name-keys";
import { applyGraphVerdict, revertGraphVerdict } from "./verdict-apply";
import { type VerdictFingerprintEvidence, fingerprintFor } from "./verdict-fingerprint";

const ACTOR_ID = "alias-gate-user";
const EVIDENCE: VerdictFingerprintEvidence = { fileIds: [], reviewIds: [], notes: ["alias cleanup"] };

async function seedActor(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id: ACTOR_ID,
      name: "Alias Gate User",
      email: "alias-gate@example.com",
      email_verified_at: new Date().toISOString(),
      password_hash: "hash",
      auth_role: "admin",
    })
    .execute();
}

async function createRemoveAliasVerdict(db: Kysely<DB>, entityId: string, alias: string): Promise<string> {
  const verdictRepo = createGraphVerdictRepository(db);
  const run = await verdictRepo.createRun({
    source: "alias-gate-test",
    proposedByUserId: ACTOR_ID,
    tokenId: null,
    note: null,
    verdictsProposed: 1,
  });
  const entity = await db.selectFrom("entities").selectAll().where("id", "=", entityId).executeTakeFirstOrThrow();
  const stored = await verdictRepo.storeVerdicts([
    {
      runId: run.id,
      action: "remove_alias",
      subjectEntityId: entity.id,
      subjectName: entity.name,
      subjectEntityType: entity.source_type,
      targetEntityId: null,
      resolvedTargetEntityId: null,
      targetName: alias,
      reason: "remove junk alias",
      evidenceJson: JSON.stringify(EVIDENCE),
      evidenceFingerprint: fingerprintFor({
        action: "remove_alias",
        subject: entity,
        target: null,
        targetName: alias,
        evidence: EVIDENCE,
      }),
      validationStatus: "ok",
      validationReason: null,
      wouldChangeJson: "{}",
      status: "awaiting_human",
    },
  ]);
  const verdictId = stored.ids[0];
  if (!verdictId) throw new Error("verdict id missing");
  expect(await verdictRepo.markApproved({ id: verdictId, actorUserId: ACTOR_ID })).toBe(true);
  return verdictId;
}

async function normalizedAliases(db: Kysely<DB>, entityId: string): Promise<string[]> {
  const entity = await db.selectFrom("entities").selectAll().where("id", "=", entityId).executeTakeFirstOrThrow();
  return parseAliasesString(entity.aliases).map(normalizeName).sort();
}

async function rejectionOwners(db: Kysely<DB>, entityId: string, alias: string): Promise<string[]> {
  const rows = await db
    .selectFrom("entity_alias_rejections")
    .select("rejected_by")
    .where("entity_id", "=", entityId)
    .where("normalized_rejected_name", "=", normalizeName(alias))
    .orderBy("rejected_by", "asc")
    .execute();
  return rows.map((row) => row.rejected_by);
}

describe("alias write gate integration", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
    await seedActor(db);
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("ledgers remove_alias verdicts and blocks re-append until verdict revert", async () => {
    const repo = createEntityRepository(db);
    const entity = await repo.createEntity({
      name: "Cleanup Project",
      sourceType: "project",
      aliases: ["Obsolete Alias"],
    });
    const verdictId = await createRemoveAliasVerdict(db, entity.id, "Obsolete Alias");

    await applyGraphVerdict(db, { verdictId, actorUserId: ACTOR_ID });

    expect(await rejectionOwners(db, entity.id, "Obsolete Alias")).toEqual([`graph-verdict:${verdictId}`]);
    await repo.appendAlias(entity.id, "Obsolete Alias", "mint_model", "model");
    await repo.appendAlias(entity.id, "Useful Alias", "mint_model", "model");
    expect(await normalizedAliases(db, entity.id)).toEqual(["useful alias"]);
    expect((await listAliasRows(db, entity.id)).map((row) => row.normalized_alias)).toEqual(["useful alias"]);

    await revertGraphVerdict(db, { verdictId, actorUserId: ACTOR_ID });

    expect(await rejectionOwners(db, entity.id, "Obsolete Alias")).toEqual([]);
    expect(await normalizedAliases(db, entity.id)).toEqual(["obsolete alias", "useful alias"]);

    const second = await repo.createEntity({
      name: "Human Rejection Project",
      sourceType: "project",
      aliases: ["Human Alias"],
    });
    await createEntityReviewRepo(db).addRejection({
      entityId: second.id,
      rejectedName: "Human Alias",
      rejectedBy: "user-1",
    });
    const secondVerdictId = await createRemoveAliasVerdict(db, second.id, "Human Alias");
    await applyGraphVerdict(db, { verdictId: secondVerdictId, actorUserId: ACTOR_ID });

    await revertGraphVerdict(db, { verdictId: secondVerdictId, actorUserId: ACTOR_ID });

    expect(await rejectionOwners(db, second.id, "Human Alias")).toEqual(["user-1"]);
    expect(await normalizedAliases(db, second.id)).toEqual(["human alias"]);
  });

  it("prevents ledgered aliases from being re-taught by mint, roster, or human-confirmed writes", async () => {
    const repo = createEntityRepository(db);
    const reviewRepo = createEntityReviewRepo(db);
    const entity = await repo.createEntity({
      name: "Riya Sharma",
      sourceType: "person",
      subtype: "external",
    });
    await reviewRepo.addRejection({
      entityId: entity.id,
      rejectedName: "Wrong Nickname",
      rejectedBy: "graph-verdict:old-verdict",
    });

    await repo.appendAlias(entity.id, "Wrong Nickname", "mint_model", "mint");
    await mergeEntityAliases(db, entity.id, ["Wrong Nickname"], "roster", new Date().toISOString(), "roster-sync");
    await repo.appendAlias(entity.id, "Wrong Nickname", "human_confirmed", ACTOR_ID);

    expect(await normalizedAliases(db, entity.id)).toEqual([]);
    expect(await listAliasRows(db, entity.id)).toEqual([]);
  });
});
