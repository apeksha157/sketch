import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import { createEntityRepository } from "./entities";
import { listAliasRows, recordAlias } from "./entity-alias-rows";

const SRC_ROOT = resolve(import.meta.dirname, "../..");
const ALLOWED_ALIAS_BLOB_WRITERS = new Set([
  "agents/run/test-helpers.ts",
  "connectors/entity-linking.ts",
  "db/repositories/entities.ts",
  "db/repositories/entity-aliases.ts",
  "entities/alias-admin.ts",
  "entities/cleanup-apply.ts",
  "entities/merge.ts",
]);
const ALIAS_BLOB_WRITE_PATTERNS = [/aliases:\s*JSON\.stringify/, /\.set\(\{\s*aliases/];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "migrations") continue;
      out.push(...sourceFiles(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".isolated.test.ts") &&
      !entry.name.endsWith(".integration.test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("entity alias rows", () => {
  it("keeps provenance upgrade-only and guards direct alias blob writers", async () => {
    const db = await createTestDb();
    try {
      const entity = await createEntityRepository(db).createEntity({ name: "Canvas", sourceType: "company" });
      await recordAlias(db, { entityId: entity.id, alias: "Canvas AI", provenance: "roster", createdBy: "roster" });
      await recordAlias(db, {
        entityId: entity.id,
        alias: "Canvas Ai",
        provenance: "mint_model",
        createdBy: "model",
      });
      await recordAlias(db, {
        entityId: entity.id,
        alias: "Canvas AI",
        provenance: "human_confirmed",
        createdBy: "user-1",
      });
      await recordAlias(db, { entityId: entity.id, alias: "Canvas AI", provenance: "merge", createdBy: "merge" });

      const rows = await listAliasRows(db, entity.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        alias: "Canvas AI",
        normalized_alias: "canvas ai",
        provenance: "human_confirmed",
        created_by: "user-1",
      });
    } finally {
      await db.destroy();
    }

    const offenders = sourceFiles(SRC_ROOT)
      .map((file) => {
        const rel = relative(SRC_ROOT, file).split(sep).join("/");
        const src = readFileSync(file, "utf8");
        return { file: rel, matched: ALIAS_BLOB_WRITE_PATTERNS.some((pattern) => pattern.test(src)) };
      })
      .filter((hit) => hit.matched && !ALLOWED_ALIAS_BLOB_WRITERS.has(hit.file))
      .map((hit) => hit.file);

    expect(offenders).toEqual([]);
  });
});
