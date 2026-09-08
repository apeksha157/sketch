import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { DB } from "../db/schema";
import { filesForContainer, prepareFilesForContainerMatching } from "../entities/container-file-matcher";
import { createTestPgDb } from "../test-utils";
import { loadExistingContentHashes, processSyncedItem } from "./sync-item";
import type { SyncedItem } from "./types";

const CONFIG = "zoho-history-config";

async function seedBase(db: Kysely<DB>): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  await db
    .insertInto("users")
    .values({ id: "zoho-history-user", name: "User", email: "zoho-history@example.com" })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONFIG,
      connector_type: "zoho_crm",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "zoho-history-user",
    })
    .execute();
  await db
    .insertInto("entities")
    .values({
      id: "deal-entity",
      name: "Acme renewal",
      source_type: "deal",
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto("entity_source_refs")
    .values({
      id: "deal-ref",
      entity_id: "deal-entity",
      source: "zoho_crm",
      source_id: "Deals:d1",
      source_url: null,
      last_seen_at: now,
    })
    .execute();
}

function dealItem(stage: string, sourceUpdatedAt = "2026-01-02T00:00:00.000Z"): SyncedItem {
  return {
    providerFileId: "Deals:d1",
    providerUrl: null,
    fileName: "Acme renewal",
    fileType: "crm_deal",
    contentCategory: "structured",
    content: "Deal content",
    sourcePath: "Zoho CRM / Deals",
    sourceMeta: {
      zohoCrm: {
        module: "Deals",
        recordId: "d1",
        stage,
        modifiedTime: sourceUpdatedAt,
      },
    },
    contentHash: "stable-content",
    sourceCreatedAt: "2026-01-01T00:00:00.000Z",
    sourceUpdatedAt,
  };
}

async function runItem(db: Kysely<DB>, item: SyncedItem) {
  return processSyncedItem({
    db,
    repo: createConnectorRepository(db),
    connectorConfigId: CONFIG,
    connectorType: "zoho_crm",
    item,
    existingHashes: await loadExistingContentHashes(db, "zoho_crm", CONFIG),
  });
}

describe("processSyncedItem Zoho CRM field history (pglite)", () => {
  it("writes one stage-history row for metadata changes and none for first sight or unchanged resync", async () => {
    const db = await createTestPgDb();
    await seedBase(db);

    expect((await runItem(db, dealItem("Qualification"))).kind).toBe("created");
    expect(await db.selectFrom("crm_field_history").selectAll().execute()).toHaveLength(0);

    expect((await runItem(db, dealItem("Qualification"))).kind).toBe("unchanged");
    expect(await db.selectFrom("crm_field_history").selectAll().execute()).toHaveLength(0);

    expect((await runItem(db, dealItem("Negotiation", "2026-01-03T00:00:00.000Z"))).kind).toBe("unchanged");
    const rows = await db.selectFrom("crm_field_history").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      indexed_file_id: expect.any(String),
      entity_id: "deal-entity",
      field: "stage",
      old_value: "Qualification",
      new_value: "Negotiation",
      source_modified_at: "2026-01-03T00:00:00.000Z",
    });
  }, 30000);

  it("ignores zohoCrm strings for container matching while preserving other source_meta namespaces", () => {
    const rows = prepareFilesForContainerMatching([
      {
        provider_file_id: "file-1",
        rollup_group_id: null,
        source_path: null,
        source_meta: JSON.stringify({
          zohoCrm: {
            module: "Deals",
            recordId: "container-1",
            related: [{ role: "parent", module: "Accounts", id: "a1" }],
          },
          linkedinAimfox: { companyId: "container-2" },
        }),
      },
    ]);

    expect(filesForContainer({ external_id: "container-1", path_names: "[]", name: "One" }, rows)).toEqual([]);
    expect(filesForContainer({ external_id: "container-2", path_names: "[]", name: "Two" }, rows)).toHaveLength(1);
  });
});
