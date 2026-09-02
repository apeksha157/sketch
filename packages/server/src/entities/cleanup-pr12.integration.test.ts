import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordAlias } from "../db/repositories/entity-alias-rows";
import { createGraphVerdictRepository } from "../db/repositories/graph-verdicts";
import type { DB } from "../db/schema";
import { handleProposeGraphVerdicts } from "../mcp/curation/propose-graph-verdicts";
import { createTestPgDb } from "../test-utils";
import type { CleanupVerdict } from "./cleanup-adjudication";
import { planCleanup } from "./cleanup-apply";
import { parseAliasesString } from "./materialize-json";
import { mergeEntitiesInTransaction } from "./merge";
import { normalizeName } from "./name-keys";
import { applyGraphVerdict, revertGraphVerdict } from "./verdict-apply";
import { fingerprintFor } from "./verdict-fingerprint";

const USER_ID = "cleanup-pr12-user";

async function seedUser(db: Kysely<DB>): Promise<void> {
  await sql`INSERT INTO users (id, name) VALUES (${USER_ID}, 'Cleanup PR12 User')`.execute(db);
}

async function seedEntity(
  db: Kysely<DB>,
  input: {
    id: string;
    name: string;
    sourceType: string;
    aliases?: string[];
    provenanceTier?: string;
  },
): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: input.sourceType,
      subtype: null,
      aliases: input.aliases && input.aliases.length > 0 ? JSON.stringify(input.aliases) : null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      provenance_tier: input.provenanceTier ?? "inferred",
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    })
    .execute();
}

function verdict(input: {
  entityId: string;
  name: string;
  action: CleanupVerdict["action"];
  targetEntityId?: string | null;
  targetName?: string | null;
}): CleanupVerdict {
  return {
    entityId: input.entityId,
    name: input.name,
    action: input.action,
    targetEntityId: input.targetEntityId ?? null,
    targetName: input.targetName ?? null,
    reason: "test",
    evidence: [],
    mechanical: false,
    approved: true,
    validation: "ok",
    validationReason: null,
  };
}

function parseJsonResult<T>(result: { content: Array<{ type: "text"; text: string }> }): T {
  return JSON.parse(result.content[0]?.text ?? "null") as T;
}

async function storeApprovedMergeVerdict(
  db: Kysely<DB>,
  input: { loserId: string; survivorId: string },
): Promise<string> {
  const repo = createGraphVerdictRepository(db);
  const run = await repo.createRun({
    source: "test",
    proposedByUserId: USER_ID,
    tokenId: null,
    note: null,
    verdictsProposed: 1,
  });
  const subject = await db.selectFrom("entities").selectAll().where("id", "=", input.loserId).executeTakeFirstOrThrow();
  const target = await db
    .selectFrom("entities")
    .selectAll()
    .where("id", "=", input.survivorId)
    .executeTakeFirstOrThrow();
  const evidence = { fileIds: [], reviewIds: [], notes: ["same person"] };
  const stored = await repo.storeVerdicts([
    {
      runId: run.id,
      action: "merge_into",
      subjectEntityId: subject.id,
      subjectName: subject.name,
      subjectEntityType: subject.source_type,
      targetEntityId: target.id,
      resolvedTargetEntityId: target.id,
      targetName: target.name,
      reason: "Merge duplicate person.",
      evidenceJson: JSON.stringify(evidence),
      evidenceFingerprint: fingerprintFor({ action: "merge_into", subject, target, evidence }),
      validationStatus: "ok",
      validationReason: null,
      wouldChangeJson: JSON.stringify({ entities: 2, entity_merges: 1 }),
      status: "awaiting_human",
    },
  ]);
  const verdictId = stored.ids[0] ?? "";
  await repo.markApproved({ id: verdictId, actorUserId: USER_ID });
  return verdictId;
}

describe("generic cleanup verdict planning and application", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
    await seedUser(db);
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("plans generic entity merges while rejecting type mismatches, non-project nests, and declared-to-weaker merges", async () => {
    await seedEntity(db, { id: "person-ok-source", name: "Person OK Source", sourceType: "person" });
    await seedEntity(db, { id: "person-ok-target", name: "Person OK Target", sourceType: "person" });
    await seedEntity(db, { id: "person-mismatch", name: "Person Mismatch", sourceType: "person" });
    await seedEntity(db, { id: "company-target", name: "Company Target", sourceType: "company" });
    await seedEntity(db, { id: "person-nest", name: "Person Nest", sourceType: "person" });
    await seedEntity(db, { id: "person-nest-target", name: "Person Nest Target", sourceType: "person" });
    await seedEntity(db, {
      id: "declared-loser",
      name: "Declared Loser",
      sourceType: "person",
      provenanceTier: "declared",
    });
    await seedEntity(db, { id: "weak-survivor", name: "Weak Survivor", sourceType: "person" });

    const rows = await planCleanup(db, [
      verdict({
        entityId: "person-ok-source",
        name: "Person OK Source",
        action: "merge_into",
        targetEntityId: "person-ok-target",
      }),
      verdict({
        entityId: "person-mismatch",
        name: "Person Mismatch",
        action: "merge_into",
        targetEntityId: "company-target",
      }),
      verdict({
        entityId: "person-nest",
        name: "Person Nest",
        action: "nest_under",
        targetEntityId: "person-nest-target",
      }),
      verdict({
        entityId: "declared-loser",
        name: "Declared Loser",
        action: "merge_into",
        targetEntityId: "weak-survivor",
      }),
    ]);

    expect(rows.map((row) => ({ state: row.state, reason: row.reason }))).toEqual([
      { state: "applied", reason: null },
      { state: "failed", reason: "type_mismatch" },
      { state: "failed", reason: "action_not_allowed_for_type" },
      { state: "failed", reason: "protected_tier_direction" },
    ]);
  });

  it("removes and reverts aliases through proposed graph verdicts while bouncing canonical-name removals", async () => {
    await seedEntity(db, {
      id: "alias-subject",
      name: "Alias Subject",
      sourceType: "person",
      aliases: ["Ace", "A. Subject"],
    });
    await recordAlias(db, {
      entityId: "alias-subject",
      alias: "Ace",
      provenance: "judge",
      createdBy: "judge-user",
    });

    const proposed = parseJsonResult<{
      stored: number;
      bounced: number;
      results: Array<{ verdictId: string; validationStatus: string; validationReason: string | null }>;
    }>(
      await handleProposeGraphVerdicts(
        {
          verdicts: [
            {
              action: "remove_alias",
              subjectEntityId: "alias-subject",
              targetName: "Ace",
              reason: "Remove stale alias.",
            },
          ],
        },
        db,
        { userId: USER_ID, tokenId: "token-1" },
      ),
    );
    expect(proposed).toMatchObject({ stored: 1, bounced: 0 });
    expect(proposed.results[0]).toMatchObject({ validationStatus: "ok", validationReason: null });
    const verdictId = proposed.results[0]?.verdictId ?? "";
    const repo = createGraphVerdictRepository(db);
    await repo.markApproved({ id: verdictId, actorUserId: USER_ID });

    const applied = await applyGraphVerdict(db, { verdictId, actorUserId: USER_ID });

    expect(applied.ledgerRef).toBe(`alias-removed:${normalizeName("Ace")}`);
    const removedEntity = await db
      .selectFrom("entities")
      .select("aliases")
      .where("id", "=", "alias-subject")
      .executeTakeFirstOrThrow();
    expect(parseAliasesString(removedEntity.aliases)).toEqual(["A. Subject"]);
    await expect(
      db
        .selectFrom("entity_aliases")
        .selectAll()
        .where("entity_id", "=", "alias-subject")
        .where("normalized_alias", "=", "ace")
        .execute(),
    ).resolves.toHaveLength(0);
    const appliedRow = await repo.findById(verdictId);
    expect(appliedRow?.would_change_json ? JSON.parse(appliedRow.would_change_json) : null).toMatchObject({
      removedAlias: "Ace",
      removedAliasProvenance: "judge",
      removedAliasCreatedBy: "judge-user",
    });

    await revertGraphVerdict(db, { verdictId, actorUserId: USER_ID });

    const restoredEntity = await db
      .selectFrom("entities")
      .select("aliases")
      .where("id", "=", "alias-subject")
      .executeTakeFirstOrThrow();
    expect(parseAliasesString(restoredEntity.aliases).sort()).toEqual(["A. Subject", "Ace"].sort());
    await expect(
      db
        .selectFrom("entity_aliases")
        .select(["alias", "provenance", "created_by"])
        .where("entity_id", "=", "alias-subject")
        .where("normalized_alias", "=", "ace")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      alias: "Ace",
      provenance: "judge",
      created_by: "judge-user",
    });

    const canonical = parseJsonResult<{
      stored: number;
      bounced: number;
      results: Array<{ validationStatus: string; validationReason: string | null }>;
    }>(
      await handleProposeGraphVerdicts(
        {
          verdicts: [
            {
              action: "remove_alias",
              subjectEntityId: "alias-subject",
              targetName: "Alias Subject",
              reason: "Do not remove the canonical name.",
            },
          ],
        },
        db,
        { userId: USER_ID, tokenId: "token-1" },
      ),
    );
    expect(canonical).toMatchObject({ stored: 0, bounced: 1 });
    expect(canonical.results[0]).toMatchObject({
      validationStatus: "failed",
      validationReason: "alias_is_canonical_name",
    });
  });

  it("promotes verdict-applied merge survivors to human-confirmed and leaves bare merges at strongest-of-two", async () => {
    await seedEntity(db, { id: "verdict-loser", name: "Verdict Loser", sourceType: "person" });
    await seedEntity(db, { id: "verdict-survivor", name: "Verdict Survivor", sourceType: "person" });
    const verdictId = await storeApprovedMergeVerdict(db, { loserId: "verdict-loser", survivorId: "verdict-survivor" });

    await applyGraphVerdict(db, { verdictId, actorUserId: USER_ID });

    await expect(
      db
        .selectFrom("entities")
        .select("provenance_tier")
        .where("id", "=", "verdict-survivor")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ provenance_tier: "human_confirmed" });

    await revertGraphVerdict(db, { verdictId, actorUserId: USER_ID });

    await expect(
      db
        .selectFrom("entities")
        .select("provenance_tier")
        .where("id", "=", "verdict-survivor")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ provenance_tier: "inferred" });

    await seedEntity(db, { id: "bare-loser", name: "Bare Loser", sourceType: "person", provenanceTier: "structural" });
    await seedEntity(db, { id: "bare-survivor", name: "Bare Survivor", sourceType: "person" });
    await db.transaction().execute((trx) =>
      mergeEntitiesInTransaction(trx, {
        survivorId: "bare-survivor",
        loserId: "bare-loser",
        userId: USER_ID,
        mergedBy: "test",
      }),
    );

    await expect(
      db.selectFrom("entities").select("provenance_tier").where("id", "=", "bare-survivor").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ provenance_tier: "structural" });
  });
});
