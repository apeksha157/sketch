import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createTestDb } from "../test-utils";
import { backfillEntityAliases } from "./backfill-entity-aliases";

describe("backfillEntityAliases", () => {
  it("is idempotent and creates one row for every unique live blob alias", async () => {
    const db = await createTestDb();
    try {
      const repo = createEntityRepository(db);
      const person = await repo.createEntity({ name: "Confirmed Person", sourceType: "person" });
      await db
        .updateTable("entities")
        .set({
          aliases: JSON.stringify([
            "person@example.com",
            "Seed Alias",
            "Confirmed Name",
            "Legacy Alias",
            "Legacy Alias",
          ]),
          metadata: JSON.stringify({ email: "person@example.com" }),
        })
        .where("id", "=", person.id)
        .execute();
      await db
        .insertInto("entity_contact_points")
        .values({
          id: randomUUID(),
          entity_id: person.id,
          kind: "email",
          value: "person@example.com",
          display_value: null,
          label: null,
          is_primary: 1,
          source: "test",
          connector_config_id: null,
          created_by_user_id: null,
          verified_at: null,
          last_contacted_at: null,
        })
        .execute();
      await db
        .insertInto("entity_review_queue")
        .values({
          id: randomUUID(),
          proposed_name: "Confirmed Name",
          normalized_name: "confirmed name",
          entity_type: "person",
          status: "confirmed",
          triggered_by_user_id: "user-1",
          resolved_entity_id: person.id,
          seed_aliases: JSON.stringify(["Seed Alias"]),
        })
        .execute();

      const survivor = await repo.createEntity({ name: "Survivor", sourceType: "company" });
      const loser = await repo.createEntity({ name: "Loser", sourceType: "company" });
      await db
        .updateTable("entities")
        .set({ aliases: JSON.stringify(["Merge Alias"]) })
        .where("id", "=", survivor.id)
        .execute();
      await db
        .insertInto("entity_merges")
        .values({
          id: randomUUID(),
          survivor_entity_id: survivor.id,
          merged_entity_id: loser.id,
          entity_type: "company",
          moves: JSON.stringify([{ kind: "alias_added", value: "Merge Alias", normalizedKey: "mergealias" }]),
          merged_by_user_id: null,
          group_id: null,
          merged_by: "test",
        })
        .execute();

      await db
        .updateTable("entities")
        .set({ deleted_at: new Date().toISOString(), merged_into_entity_id: survivor.id })
        .where("id", "=", loser.id)
        .execute();

      await expect(backfillEntityAliases(db)).resolves.toEqual({
        totalBlobAliases: 6,
        rowsWritten: 5,
        provenanceDistribution: {
          legacy: 1,
          mint_model: 1,
          roster: 1,
          merge: 1,
          judge: 0,
          human_confirmed: 1,
        },
        entitiesTouched: 2,
        aliasesSkippedAsDuplicate: 1,
      });
      const before = await db.selectFrom("entity_aliases").selectAll().orderBy("id", "asc").execute();
      const second = await backfillEntityAliases(db);
      const after = await db.selectFrom("entity_aliases").selectAll().orderBy("id", "asc").execute();

      expect(second.rowsWritten).toBe(0);
      expect(after).toEqual(before);
      expect(after.map((row) => [row.normalized_alias, row.provenance]).sort()).toEqual([
        ["confirmed name", "human_confirmed"],
        ["legacy alias", "legacy"],
        ["merge alias", "merge"],
        ["person@example.com", "roster"],
        ["seed alias", "mint_model"],
      ]);
    } finally {
      await db.destroy();
    }
  });
});
