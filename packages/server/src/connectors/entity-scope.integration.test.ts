import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, getSharedPgDb } from "../test-utils";
import { entityScopeHasFiles, entityScopePredicateSql } from "./entity-scope";

describe("entityScopePredicateSql dialect parity", () => {
  let postgres!: Kysely<DB>;
  let sqlite!: Kysely<DB>;

  beforeAll(async () => {
    postgres = await getSharedPgDb();
  }, 30_000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(postgres);
    sqlite = await createTestDb();
  });

  afterEach(async () => {
    await sqlite.destroy();
    await sql`ROLLBACK`.execute(postgres);
  });

  it("returns the same distinct OR union and AND intersection", async () => {
    const actual: Record<string, { or: string[]; and: string[] }> = {};

    for (const [dialect, db] of [
      ["sqlite", sqlite],
      ["postgres", postgres],
    ] as const) {
      await seedScopeRows(db);

      const orRows = await db
        .selectFrom("indexed_files")
        .select("id")
        .where(
          entityScopePredicateSql(sql.ref("indexed_files.id"), {
            entityIds: ["pr2-entity-a", "pr2-entity-b"],
            mode: "or",
          }),
        )
        .orderBy("id", "asc")
        .execute();
      const andRows = await db
        .selectFrom("indexed_files")
        .select("id")
        .where(
          entityScopePredicateSql(sql.ref("indexed_files.id"), {
            entityIds: ["pr2-entity-a", "pr2-entity-a", "pr2-entity-b"],
            mode: "and",
          }),
        )
        .orderBy("id", "asc")
        .execute();

      actual[dialect] = {
        or: orRows.map((row) => row.id),
        and: andRows.map((row) => row.id),
      };
      await expect(entityScopeHasFiles(db, { entityIds: ["pr2-entity-a", "pr2-entity-b"], mode: "and" })).resolves.toBe(
        true,
      );
      await expect(entityScopeHasFiles(db, { entityIds: ["pr2-missing-entity"], mode: "and" })).resolves.toBe(false);
    }

    expect(actual.sqlite).toEqual({
      or: ["pr2-file-a", "pr2-file-b", "pr2-file-both"],
      and: ["pr2-file-both"],
    });
    expect(actual.postgres).toEqual(actual.sqlite);
  });
});

async function seedScopeRows(db: Kysely<DB>) {
  const now = "2026-09-06T00:00:00.000Z";
  await db
    .insertInto("connector_configs")
    .values({
      id: "pr2-entity-scope-config",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "pr2-test",
    })
    .execute();
  await db
    .insertInto("entities")
    .values([
      {
        id: "pr2-entity-a",
        name: "PR2 Entity A",
        source_type: "company",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: "pr2-entity-b",
        name: "PR2 Entity B",
        source_type: "company",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("indexed_files")
    .values(
      ["pr2-file-a", "pr2-file-b", "pr2-file-both", "pr2-file-neither"].map((id) => ({
        id,
        connector_config_id: "pr2-entity-scope-config",
        provider_file_id: id,
        file_name: id,
        file_type: "doc",
        content_category: "document",
        source: "google_drive",
        source_updated_at: now,
        synced_at: now,
      })),
    )
    .execute();
  await db
    .insertInto("entity_mentions")
    .values([
      mention("pr2-mention-a", "pr2-entity-a", "pr2-file-a", "mentioned", now),
      mention("pr2-mention-b", "pr2-entity-b", "pr2-file-b", "mentioned", now),
      mention("pr2-mention-both-a", "pr2-entity-a", "pr2-file-both", "mentioned", now),
      mention("pr2-mention-both-a-authored", "pr2-entity-a", "pr2-file-both", "authored", now),
      mention("pr2-mention-both-b", "pr2-entity-b", "pr2-file-both", "mentioned", now),
    ])
    .execute();
}

function mention(
  id: string,
  entityId: string,
  indexedFileId: string,
  relation: "mentioned" | "authored",
  mentionedAt: string,
) {
  return {
    id,
    entity_id: entityId,
    indexed_file_id: indexedFileId,
    chunk_index: null,
    context_snippet: null,
    confidence: "EXTRACTED" as const,
    source: "test",
    relation,
    mentioned_at: mentionedAt,
  };
}
