import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { getSyncIdentity, syncIdentityKey } from "./sync-identity";
import { type ProcessSyncedItemResult, loadExistingContentHashes, processSyncedItem } from "./sync-item";
import type { SyncedItem } from "./types";

describe("loadExistingContentHashes config scoping", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  async function insertConfig(id: string, connectorType: string): Promise<void> {
    await db
      ?.insertInto("connector_configs")
      .values({
        id,
        connector_type: connectorType,
        auth_type: "oauth",
        credentials: "{}",
        created_by: "owner",
      })
      .execute();
  }

  async function insertFile(row: {
    id: string;
    connectorConfigId: string;
    source: string;
    providerFileId: string;
    providerMessageId: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await db
      ?.insertInto("indexed_files")
      .values({
        id: row.id,
        connector_config_id: row.connectorConfigId,
        provider_file_id: row.providerFileId,
        provider_message_id: row.providerMessageId,
        source: row.source,
        file_name: row.id,
        file_type: "doc",
        content_category: "document",
        content_hash: `hash-${row.id}`,
        synced_at: now,
        source_updated_at: now,
      })
      .execute();
  }

  it("excludes another config's message-keyed rows from the map", async () => {
    db = await createTestDb();
    await insertConfig("cfg-a", "outlook");
    await insertConfig("cfg-b", "outlook");
    await insertFile({
      id: "file-a",
      connectorConfigId: "cfg-a",
      source: "outlook",
      providerFileId: "graph-a",
      providerMessageId: "<msg-a@example.com>",
    });
    await insertFile({
      id: "file-b",
      connectorConfigId: "cfg-b",
      source: "outlook",
      providerFileId: "graph-b",
      providerMessageId: "<msg-b@example.com>",
    });

    const map = await loadExistingContentHashes(db, "outlook", "cfg-b");

    const ownKey = syncIdentityKey(
      getSyncIdentity({
        connectorConfigId: "cfg-b",
        connectorType: "outlook",
        providerFileId: "graph-b",
        providerMessageId: "<msg-b@example.com>",
      }),
    );
    const otherKey = syncIdentityKey(
      getSyncIdentity({
        connectorConfigId: "cfg-a",
        connectorType: "outlook",
        providerFileId: "graph-a",
        providerMessageId: "<msg-a@example.com>",
      }),
    );
    expect(map.get(ownKey)?.id).toBe("file-b");
    expect(map.has(otherKey)).toBe(false);
  });

  it("retains another config's globally-deduped provider_file_id rows for cross-config dedup", async () => {
    db = await createTestDb();
    await insertConfig("cfg-a", "google_drive");
    await insertConfig("cfg-b", "google_drive");
    await insertFile({
      id: "file-shared",
      connectorConfigId: "cfg-a",
      source: "google_drive",
      providerFileId: "shared-pf",
      providerMessageId: null,
    });

    const map = await loadExistingContentHashes(db, "google_drive", "cfg-b");

    const sharedKey = syncIdentityKey(
      getSyncIdentity({
        connectorConfigId: "cfg-b",
        connectorType: "google_drive",
        providerFileId: "shared-pf",
        providerMessageId: null,
      }),
    );
    expect(map.get(sharedKey)?.id).toBe("file-shared");
  });
});

function indexedFileIdOf(result: ProcessSyncedItemResult): string {
  if (result.kind === "skipped_empty") throw new Error("item was skipped");
  return result.indexedFileId;
}

describe("processSyncedItem CRM record fields", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  async function insertConfig(id: string, connectorType: string): Promise<void> {
    await db
      ?.insertInto("connector_configs")
      .values({
        id,
        connector_type: connectorType,
        auth_type: "oauth",
        credentials: "{}",
        created_by: "owner",
      })
      .execute();
  }

  async function runItem(connectorConfigId: string, connectorType: "zoho_crm" | "google_drive", item: SyncedItem) {
    if (!db) throw new Error("missing db");
    return processSyncedItem({
      db,
      repo: createConnectorRepository(db),
      connectorConfigId,
      connectorType,
      item,
      existingHashes: await loadExistingContentHashes(db, connectorType, connectorConfigId),
    });
  }

  it("writes, dedupes, and replaces Zoho CRM current-value fields", async () => {
    db = await createTestDb();
    await insertConfig("cfg-zoho-fields", "zoho_crm");
    await insertConfig("cfg-drive-fields", "google_drive");

    const baseItem: SyncedItem = {
      providerFileId: "Contacts:c1",
      providerUrl: null,
      fileName: "Asha Contact",
      fileType: "crm_contact",
      contentCategory: "document",
      content: "Contact body",
      sourcePath: "Zoho CRM / Contacts",
      sourceMeta: {
        zohoCrm: {
          module: "Contacts",
          recordId: "c1",
          leadSource: "LinkedIn",
          tag: "Eligible, San Francisco, Bay Area",
          tags: ["Eligible", "San Francisco, Bay Area"],
        },
      },
      contentHash: "stable-contact-content",
      sourceCreatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-02T00:00:00.000Z",
    };

    const created = await runItem("cfg-zoho-fields", "zoho_crm", baseItem);
    expect(created.kind).toBe("created");
    const createdFileId = indexedFileIdOf(created);
    const firstRows = await db
      .selectFrom("crm_record_fields")
      .select(["field", "value", "value_norm"])
      .where("indexed_file_id", "=", createdFileId)
      .orderBy("field")
      .orderBy("value")
      .execute();
    expect(firstRows).toEqual([
      { field: "leadSource", value: "LinkedIn", value_norm: "linkedin" },
      { field: "tag", value: "Eligible", value_norm: "eligible" },
      { field: "tag", value: "San Francisco, Bay Area", value_norm: "san francisco, bay area" },
    ]);

    const updated = await runItem("cfg-zoho-fields", "zoho_crm", {
      ...baseItem,
      sourceMeta: {
        zohoCrm: {
          module: "Contacts",
          recordId: "c1",
          leadSource: "LinkedIn",
          tag: "Eligible, Nurture",
          tags: ["Nurture"],
        },
      },
    });
    expect(updated.kind).toBe("unchanged");
    const replacedRows = await db
      .selectFrom("crm_record_fields")
      .select(["field", "value", "value_norm"])
      .where("indexed_file_id", "=", createdFileId)
      .orderBy("field")
      .orderBy("value")
      .execute();
    expect(replacedRows).toEqual([
      { field: "leadSource", value: "LinkedIn", value_norm: "linkedin" },
      { field: "tag", value: "Nurture", value_norm: "nurture" },
    ]);

    const nonZoho = await runItem("cfg-drive-fields", "google_drive", {
      providerFileId: "drive-1",
      providerUrl: null,
      fileName: "Drive file",
      fileType: "doc",
      contentCategory: "document",
      content: "Drive body",
      sourcePath: "Drive",
      sourceMeta: { googleDrive: { owner: "Alice" } },
      contentHash: "drive-content",
      sourceCreatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(nonZoho.kind).toBe("created");
    const nonZohoFileId = indexedFileIdOf(nonZoho);
    expect(
      await db.selectFrom("crm_record_fields").selectAll().where("indexed_file_id", "=", nonZohoFileId).execute(),
    ).toEqual([]);
  });
});
