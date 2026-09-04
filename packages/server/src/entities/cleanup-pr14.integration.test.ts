import type { Kysely } from "kysely";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordAlias } from "../db/repositories/entity-alias-rows";
import { MACHINE_PRINCIPAL_USER_ID } from "../db/repositories/machine-principal";
import type { DB, EntityAliasProvenance } from "../db/schema";
import { handleProposeGraphVerdicts } from "../mcp/curation/propose-graph-verdicts";
import { createTestPgDb } from "../test-utils";
import { parseAliasesString } from "./materialize-json";
import { normalizeName } from "./name-keys";
import { approveGatedKinds, runExecutorLeg } from "./resolver-pass";

const EPOCH = "1970-01-01T00:00:00.000Z";
const logger = pino({ level: "silent" });

type ProposeResult = {
  stored: number;
  bounced: number;
  summary: string;
  results: Array<{
    verdictId: string;
    action: string;
    subjectEntityId: string;
    validationStatus: string;
    validationReason: string | null;
    disposition: string;
  }>;
};

async function seedEntity(
  db: Kysely<DB>,
  input: {
    id: string;
    name: string;
    sourceType: string;
    aliases?: string[];
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
      provenance_tier: "inferred",
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    })
    .execute();
}

async function seedAlias(
  db: Kysely<DB>,
  input: {
    entityId: string;
    alias: string;
    provenance: EntityAliasProvenance;
  },
): Promise<void> {
  await recordAlias(db, {
    entityId: input.entityId,
    alias: input.alias,
    provenance: input.provenance,
    createdBy: `${input.provenance}-writer`,
  });
}

function parseJsonResult<T>(result: { content: Array<{ type: "text"; text: string }> }): T {
  return JSON.parse(result.content[0]?.text ?? "null") as T;
}

async function entityAliases(db: Kysely<DB>, entityId: string): Promise<string[]> {
  const row = await db.selectFrom("entities").select("aliases").where("id", "=", entityId).executeTakeFirstOrThrow();
  return parseAliasesString(row.aliases);
}

async function aliasRowCount(db: Kysely<DB>, entityId: string, alias: string): Promise<number> {
  const rows = await db
    .selectFrom("entity_aliases")
    .select("id")
    .where("entity_id", "=", entityId)
    .where("normalized_alias", "=", normalizeName(alias))
    .execute();
  return rows.length;
}

async function proposeAsMachine(db: Kysely<DB>, verdicts: unknown[]): Promise<ProposeResult> {
  return parseJsonResult<ProposeResult>(
    await handleProposeGraphVerdicts({ verdicts } as Parameters<typeof handleProposeGraphVerdicts>[0], db, {
      userId: MACHINE_PRINCIPAL_USER_ID,
      tokenId: "token-pr14",
    }),
  );
}

async function runGatedExecutor(db: Kysely<DB>): Promise<{ approved: string[]; applied: number }> {
  const gated = await approveGatedKinds(db, { kinds: ["remove_alias"], since: EPOCH });
  const executor = await runExecutorLeg(db, logger);
  return { approved: gated.approved, applied: executor.applied };
}

describe("resolver executor remove_alias gating (formerly propose autoApply)", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("applies mint-model alias removals through the executor while parking human-confirmed aliases", async () => {
    await seedEntity(db, {
      id: "machine-alias-subject",
      name: "Machine Alias Subject",
      sourceType: "person",
      aliases: ["Machine Mess", "Stable Name"],
    });
    await seedEntity(db, {
      id: "human-alias-subject",
      name: "Human Alias Subject",
      sourceType: "person",
      aliases: ["Human Signal"],
    });
    await seedAlias(db, { entityId: "machine-alias-subject", alias: "Machine Mess", provenance: "mint_model" });
    await seedAlias(db, { entityId: "human-alias-subject", alias: "Human Signal", provenance: "human_confirmed" });

    const proposed = await proposeAsMachine(db, [
      {
        action: "remove_alias",
        subjectEntityId: "machine-alias-subject",
        targetName: "Machine Mess",
        reason: "Remove model-created alias.",
      },
      {
        action: "remove_alias",
        subjectEntityId: "human-alias-subject",
        targetName: "Human Signal",
        reason: "This should still require human review.",
      },
    ]);
    expect(proposed).toMatchObject({ stored: 2, bounced: 0, summary: "awaiting_human=2 bounced=0" });
    expect(proposed.results.map((row) => row.disposition)).toEqual(["awaiting_human", "awaiting_human"]);

    const { approved, applied } = await runGatedExecutor(db);
    expect(approved).toEqual([proposed.results[0]?.verdictId]);
    expect(applied).toBe(1);
    await expect(
      db
        .selectFrom("graph_verdicts")
        .select(["status", "decided_by_user_id"])
        .where("id", "=", proposed.results[0]?.verdictId ?? "")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "applied", decided_by_user_id: MACHINE_PRINCIPAL_USER_ID });
    await expect(entityAliases(db, "machine-alias-subject")).resolves.toEqual(["Stable Name"]);
    await expect(aliasRowCount(db, "machine-alias-subject", "Machine Mess")).resolves.toBe(0);
    await expect(
      db
        .selectFrom("entity_alias_rejections")
        .select(["entity_id", "rejected_name", "rejected_by"])
        .where("entity_id", "=", "machine-alias-subject")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      entity_id: "machine-alias-subject",
      rejected_name: "Machine Mess",
      rejected_by: `graph-verdict:${proposed.results[0]?.verdictId ?? ""}`,
    });
    await expect(
      db
        .selectFrom("graph_verdicts")
        .select(["status", "decided_by_user_id"])
        .where("id", "=", proposed.results[1]?.verdictId ?? "")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "awaiting_human", decided_by_user_id: null });
    await expect(entityAliases(db, "human-alias-subject")).resolves.toEqual(["Human Signal"]);
    await expect(aliasRowCount(db, "human-alias-subject", "Human Signal")).resolves.toBe(1);
  });

  it("parks blob-only alias removals when no provenance row exists", async () => {
    await seedEntity(db, {
      id: "blob-only-alias-subject",
      name: "Blob Only Alias Subject",
      sourceType: "person",
      aliases: ["Blob Only"],
    });

    const proposed = await proposeAsMachine(db, [
      {
        action: "remove_alias",
        subjectEntityId: "blob-only-alias-subject",
        targetName: "Blob Only",
        reason: "Unknown alias provenance must be reviewed.",
      },
    ]);
    expect(proposed).toMatchObject({ stored: 1, bounced: 0, summary: "awaiting_human=1 bounced=0" });

    const { approved, applied } = await runGatedExecutor(db);
    expect(approved).toEqual([]);
    expect(applied).toBe(0);
    await expect(
      db
        .selectFrom("graph_verdicts")
        .select("status")
        .where("id", "=", proposed.results[0]?.verdictId ?? "")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "awaiting_human" });
    await expect(entityAliases(db, "blob-only-alias-subject")).resolves.toEqual(["Blob Only"]);
    await expect(aliasRowCount(db, "blob-only-alias-subject", "Blob Only")).resolves.toBe(0);
  });

  it("applies only eligible removals in mixed batches and never touches other kinds", async () => {
    await seedEntity(db, {
      id: "mixed-machine-alias",
      name: "Mixed Machine Alias",
      sourceType: "person",
      aliases: ["Legacy Mess"],
    });
    await seedEntity(db, { id: "mixed-merge-source", name: "Mixed Merge Source", sourceType: "project" });
    await seedEntity(db, { id: "mixed-merge-target", name: "Mixed Merge Target", sourceType: "project" });
    await seedEntity(db, {
      id: "mixed-bounced-alias",
      name: "Mixed Bounced Alias",
      sourceType: "person",
      aliases: ["Kept Alias"],
    });
    await seedAlias(db, { entityId: "mixed-machine-alias", alias: "Legacy Mess", provenance: "legacy" });

    const proposed = await proposeAsMachine(db, [
      {
        action: "remove_alias",
        subjectEntityId: "mixed-machine-alias",
        targetName: "Legacy Mess",
        reason: "Remove legacy machine mess.",
      },
      {
        action: "merge_into",
        subjectEntityId: "mixed-merge-source",
        targetEntityId: "mixed-merge-target",
        reason: "Merge still needs corroboration.",
      },
      {
        action: "remove_alias",
        subjectEntityId: "mixed-bounced-alias",
        targetName: "Missing Alias",
        reason: "This should bounce.",
      },
    ]);
    expect(proposed).toMatchObject({
      stored: 2,
      bounced: 1,
      summary: "awaiting_human=1 bounced=1 pending_corroboration=1",
    });
    expect(proposed.results.map((row) => row.disposition)).toEqual([
      "awaiting_human",
      "pending_corroboration",
      "bounced",
    ]);
    expect(proposed.results[2]).toMatchObject({
      validationStatus: "failed",
      validationReason: "alias_not_found",
    });

    const { applied } = await runGatedExecutor(db);
    expect(applied).toBe(1);
    await expect(
      db
        .selectFrom("graph_verdicts")
        .select(["action", "status", "validation_reason"])
        .where(
          "id",
          "in",
          proposed.results.map((row) => row.verdictId),
        )
        .orderBy("action", "asc")
        .orderBy("subject_entity_id", "asc")
        .execute(),
    ).resolves.toEqual([
      { action: "merge_into", status: "pending_corroboration", validation_reason: null },
      { action: "remove_alias", status: "bounced", validation_reason: "alias_not_found" },
      { action: "remove_alias", status: "applied", validation_reason: null },
    ]);
    await expect(entityAliases(db, "mixed-machine-alias")).resolves.toEqual([]);
    await expect(entityAliases(db, "mixed-bounced-alias")).resolves.toEqual(["Kept Alias"]);
    await expect(
      db
        .selectFrom("entities")
        .select(["deleted_at", "merged_into_entity_id"])
        .where("id", "=", "mixed-merge-source")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deleted_at: null, merged_into_entity_id: null });
  });
});
