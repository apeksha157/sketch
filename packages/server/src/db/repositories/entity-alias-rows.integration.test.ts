import { describe, expect, it } from "vitest";
import { parseAliasesString } from "../../entities/materialize-json";
import { mergeEntities } from "../../entities/merge";
import { normalizeName } from "../../entities/name-keys";
import { createTestDb } from "../../test-utils";
import { createEntityRepository } from "./entities";
import { listAliasRows } from "./entity-alias-rows";
import { mergeEntityAliases } from "./entity-aliases";

describe("entity alias row dual-write", () => {
  it("records row parity for exercised alias blob write seams", async () => {
    const db = await createTestDb();
    try {
      const repo = createEntityRepository(db);
      const company = await repo.upsertEntity({
        name: "Acme",
        sourceType: "company",
        aliases: ["Acme Inc"],
      });
      await repo.appendAlias(company.id, "Acme Human", "human_confirmed", "user-1");
      await repo.updateEntity(company.id, { aliases: JSON.stringify(["Acme Inc", "Acme Human", "Acme Update"]) });

      await repo.upsertEntityFromTool({
        name: "Old Tool Name",
        sourceType: "tool",
        source: "tool-source",
        sourceId: "tool-1",
      });
      const renamed = await repo.upsertEntityFromTool({
        name: "New Tool Name",
        sourceType: "tool",
        source: "tool-source",
        sourceId: "tool-1",
      });

      const person = await repo.createPersonEntity({
        name: "Riya",
        email: "riya@example.com",
        subtype: "external",
        source: "email_seed",
        sourceId: "riya",
      });
      await mergeEntityAliases(db, person.id, ["Riya Roster"], "roster");

      const survivor = await repo.upsertEntity({ name: "Survivor Co", sourceType: "company" });
      const loser = await repo.upsertEntity({ name: "Loser Co", sourceType: "company", aliases: ["Loser Alias"] });
      await mergeEntities(db, { survivorId: survivor.id, loserId: loser.id, userId: undefined, mergedBy: "test" });

      for (const entityId of [company.id, renamed.id, person.id, survivor.id]) {
        const entity = await db.selectFrom("entities").selectAll().where("id", "=", entityId).executeTakeFirstOrThrow();
        const blobAliases = parseAliasesString(entity.aliases).map(normalizeName).sort();
        const rowAliases = (await listAliasRows(db, entityId)).map((row) => row.normalized_alias).sort();
        expect(rowAliases).toEqual(blobAliases);
      }
    } finally {
      await db.destroy();
    }
  });
});
