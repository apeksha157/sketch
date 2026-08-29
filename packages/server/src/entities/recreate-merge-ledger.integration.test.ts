import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import { mergeEntities, unmergeEntities } from "./merge";
import { resetDerivedEntityData } from "./recreate";

const USER_ID = "recreate-merge-user";

async function seedEntity(db: Kysely<DB>, id: string, name: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "project",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      provenance_tier: "inferred",
      created_at: now,
      updated_at: now,
    })
    .execute();
}

describe("recreate with a merge ledger", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
    await sql`INSERT INTO users (id, name) VALUES (${USER_ID}, 'Recreate Merge User')`.execute(db);
    await seedEntity(db, "survivor", "Canonical Project");
    await seedEntity(db, "loser", "Fragment Project");
    await mergeEntities(db, { survivorId: "survivor", loserId: "loser", userId: USER_ID });
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("resets without violating the merge-ledger FKs and preserves both merge endpoints", async () => {
    await resetDerivedEntityData(db, createTestLogger());

    await expect(db.selectFrom("entity_merges").selectAll().execute()).resolves.toHaveLength(1);
    const survivor = await db.selectFrom("entities").selectAll().where("id", "=", "survivor").executeTakeFirstOrThrow();
    expect(survivor.deleted_at).toBeNull();
    const loser = await db.selectFrom("entities").selectAll().where("id", "=", "loser").executeTakeFirstOrThrow();
    expect(loser.deleted_at).not.toBeNull();
    expect(loser.merged_into_entity_id).toBe("survivor");
  });

  it("still deletes derived entities that no merge references", async () => {
    await seedEntity(db, "unreferenced", "Rebuildable Project");

    const summary = await resetDerivedEntityData(db, createTestLogger());

    expect(summary.deleted.entities).toBe(1);
    const remaining = await db.selectFrom("entities").select("id").orderBy("id", "asc").execute();
    expect(remaining.map((row) => row.id)).toEqual(["loser", "survivor"]);
  });

  it("can unmerge after a reset", async () => {
    await resetDerivedEntityData(db, createTestLogger());

    const merge = await db.selectFrom("entity_merges").selectAll().executeTakeFirstOrThrow();
    await unmergeEntities(db, { mergeId: merge.id, userId: USER_ID });

    const loser = await db.selectFrom("entities").selectAll().where("id", "=", "loser").executeTakeFirstOrThrow();
    expect(loser.deleted_at).toBeNull();
    expect(loser.merged_into_entity_id).toBeNull();
  });
});
