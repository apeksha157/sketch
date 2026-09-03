import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordAlias } from "../../db/repositories/entity-alias-rows";
import type { DB, EntityAliasProvenance } from "../../db/schema";
import { createTestPgDb } from "../../test-utils";
import { handleCurationListAliases } from "./list-aliases";
import { handleProposeGraphVerdicts } from "./propose-graph-verdicts";

const USER_ID = "curation-pr15-user";

type AliasListResult = {
  total: number;
  rows: Array<{
    entityId: string;
    entityName: string;
    entityType: string;
    alias: string;
    provenance: EntityAliasProvenance;
  }>;
  limit: number;
  offset: number;
};

type ProposeResult = {
  stored: number;
  bounced: number;
  summary: string;
  results: Array<{
    verdictId: string;
    action: string;
    subjectEntityId: string;
    targetName: string | null;
    validationStatus: string;
    validationReason: string | null;
    disposition: string;
  }>;
};

function parseJsonResult<T>(result: { content: Array<{ type: "text"; text: string }> }): T {
  return JSON.parse(result.content[0]?.text ?? "null") as T;
}

async function seedUser(db: Kysely<DB>): Promise<void> {
  await sql`INSERT INTO users (id, name) VALUES (${USER_ID}, 'Curation PR15 User')`.execute(db);
}

async function seedEntity(
  db: Kysely<DB>,
  input: {
    id: string;
    name: string;
    sourceType: string;
    aliases?: string[];
    deletedAt?: string | null;
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
      deleted_at: input.deletedAt ?? null,
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

describe("curation PR15 postgres", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
    await seedUser(db);
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("filters curation_list_aliases by provenance and entity type with pageable live-only totals", async () => {
    await seedEntity(db, { id: "filter-person-a", name: "Filter Person A", sourceType: "person" });
    await seedEntity(db, { id: "filter-person-b", name: "Filter Person B", sourceType: "person" });
    await seedEntity(db, { id: "filter-company", name: "Filter Company", sourceType: "company" });
    await seedEntity(db, {
      id: "filter-deleted-person",
      name: "Filter Deleted Person",
      sourceType: "person",
      deletedAt: "2026-08-22T01:00:00.000Z",
    });
    await seedAlias(db, { entityId: "filter-person-a", alias: "Alpha Legacy", provenance: "legacy" });
    await seedAlias(db, { entityId: "filter-person-b", alias: "Beta Legacy", provenance: "legacy" });
    await seedAlias(db, { entityId: "filter-person-b", alias: "Beta Roster", provenance: "roster" });
    await seedAlias(db, { entityId: "filter-company", alias: "Company Legacy", provenance: "legacy" });
    await seedAlias(db, { entityId: "filter-deleted-person", alias: "Deleted Legacy", provenance: "legacy" });

    const full = parseJsonResult<AliasListResult>(
      await handleCurationListAliases({ provenance: "legacy", entityType: "person", limit: 10 }, db),
    );
    const first = parseJsonResult<AliasListResult>(
      await handleCurationListAliases({ provenance: "legacy", entityType: "person", limit: 1, offset: 0 }, db),
    );
    const second = parseJsonResult<AliasListResult>(
      await handleCurationListAliases({ provenance: "legacy", entityType: "person", limit: 1, offset: 1 }, db),
    );

    expect(full.total).toBe(2);
    expect(full.rows).toEqual([
      {
        entityId: "filter-person-a",
        entityName: "Filter Person A",
        entityType: "person",
        alias: "Alpha Legacy",
        provenance: "legacy",
      },
      {
        entityId: "filter-person-b",
        entityName: "Filter Person B",
        entityType: "person",
        alias: "Beta Legacy",
        provenance: "legacy",
      },
    ]);
    expect([...first.rows, ...second.rows]).toEqual(full.rows);
    expect([full, first, second].flatMap((result) => result.rows.map((row) => row.entityId))).not.toContain(
      "filter-deleted-person",
    );
  });

  it("returns curation_list_aliases rows sorted by entity name and normalized alias", async () => {
    await seedEntity(db, { id: "order-gamma", name: "Gamma Person", sourceType: "person" });
    await seedEntity(db, { id: "order-alpha", name: "Alpha Project", sourceType: "project" });
    await seedEntity(db, { id: "order-beta", name: "Beta Person", sourceType: "person" });
    await seedAlias(db, { entityId: "order-gamma", alias: "Aardvark Alias", provenance: "judge" });
    await seedAlias(db, { entityId: "order-alpha", alias: "Zulu Alias", provenance: "legacy" });
    await seedAlias(db, { entityId: "order-beta", alias: "Beta Alias", provenance: "roster" });
    await seedAlias(db, { entityId: "order-alpha", alias: "Alpha Alias", provenance: "mint_model" });

    const result = parseJsonResult<AliasListResult>(await handleCurationListAliases({ limit: 10 }, db));

    expect(result.rows.map((row) => `${row.entityName}|${row.alias}`)).toEqual([
      "Alpha Project|Alpha Alias",
      "Alpha Project|Zulu Alias",
      "Beta Person|Beta Alias",
      "Gamma Person|Aardvark Alias",
    ]);
  });

  it("echoes submitted targetName values for mixed propose_graph_verdicts dispositions", async () => {
    await seedEntity(db, {
      id: "echo-machine-alias",
      name: "Echo Machine Alias",
      sourceType: "person",
      aliases: ["Legacy Echo"],
    });
    await seedEntity(db, { id: "echo-merge-source", name: "Echo Merge Source", sourceType: "project" });
    await seedEntity(db, { id: "echo-merge-target", name: "Echo Merge Target", sourceType: "project" });
    await seedAlias(db, { entityId: "echo-machine-alias", alias: "Legacy Echo", provenance: "legacy" });

    const proposed = parseJsonResult<ProposeResult>(
      await handleProposeGraphVerdicts(
        {
          verdicts: [
            {
              action: "remove_alias",
              subjectEntityId: "echo-machine-alias",
              targetName: "Legacy Echo",
              reason: "Remove legacy alias.",
            },
            {
              action: "merge_into",
              subjectEntityId: "echo-merge-source",
              targetEntityId: "echo-merge-target",
              targetName: "Submitted Merge Name",
              reason: "Park merge for review.",
            },
            {
              action: "archive",
              subjectEntityId: "echo-missing-subject",
              reason: "Bounce missing subject.",
            },
          ],
        },
        db,
        { userId: USER_ID, tokenId: "token-pr15" },
      ),
    );

    expect(proposed).toMatchObject({
      stored: 2,
      bounced: 1,
      summary: "awaiting_human=2 bounced=1",
    });
    expect(
      proposed.results.map((row) => ({
        action: row.action,
        targetName: row.targetName,
        disposition: row.disposition,
        validationReason: row.validationReason,
      })),
    ).toEqual([
      {
        action: "remove_alias",
        targetName: "Legacy Echo",
        disposition: "awaiting_human",
        validationReason: null,
      },
      {
        action: "merge_into",
        targetName: "Submitted Merge Name",
        disposition: "awaiting_human",
        validationReason: null,
      },
      {
        action: "archive",
        targetName: null,
        disposition: "bounced",
        validationReason: "subject_not_found",
      },
    ]);
  });
});
