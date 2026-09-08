import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { backfillZohoSourceMeta } from "./zoho-crm-backfill";

const CONFIG = "zoho-backfill-config";

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: "zoho-backfill-user", name: "User", email: "zoho@example.com" }).execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONFIG,
      connector_type: "zoho_crm",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "zoho-backfill-user",
    })
    .execute();
}

async function insertFile(
  db: Kysely<DB>,
  row: {
    id: string;
    providerFileId: string;
    fileName: string;
    fileType: string;
    content: string;
    sourceMeta?: Record<string, unknown>;
    rollupGroupId?: string | null;
  },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: row.id,
      connector_config_id: CONFIG,
      provider_file_id: row.providerFileId,
      provider_url: null,
      file_name: row.fileName,
      file_type: row.fileType,
      content_category: "structured",
      content: row.content,
      source: "zoho_crm",
      source_path: "Zoho CRM / Test",
      source_meta: row.sourceMeta ? JSON.stringify(row.sourceMeta) : null,
      rollup_group_id: row.rollupGroupId ?? null,
      content_hash: row.id,
      synced_at: "2026-01-02T00:00:00.000Z",
      source_created_at: "2026-01-01T00:00:00.000Z",
      source_updated_at: "2026-01-02T00:00:00.000Z",
    })
    .execute();
}

async function readMeta(db: Kysely<DB>, id: string) {
  const row = await db.selectFrom("indexed_files").select("source_meta").where("id", "=", id).executeTakeFirstOrThrow();
  return JSON.parse(row.source_meta ?? "{}") as Record<string, unknown>;
}

describe("backfillZohoSourceMeta", () => {
  it("parses Zoho content into source meta, handles pipe values, truncated notes, and populated rows", async () => {
    const db = await createTestDb();
    await seedBase(db);
    await insertFile(db, {
      id: "deal",
      providerFileId: "Deals:d1",
      fileName: "Deal",
      fileType: "crm_deal",
      content: "# Deal (Deals)\n\nStage: Qualification | Amount: 5000 | Closing Date: 2026-10-01 | Probability: 50",
    });
    await insertFile(db, {
      id: "task",
      providerFileId: "Tasks:t1",
      fileName: "Task",
      fileType: "crm_task",
      content: "# Task (Tasks)\n\nStatus: Open | Priority: High | Due: 2026-03-01 | Related: Deal",
      rollupGroupId: "Deals:d1",
    });
    await insertFile(db, {
      id: "account",
      providerFileId: "Accounts:a1",
      fileName: "Account",
      fileType: "crm_account",
      rollupGroupId: "Accounts:a1",
      content: [
        "# Account (Accounts)",
        "",
        [
          "Industry: Finance",
          "Owner: Shreeja P",
          "Website: https://acme.test",
          "Employees: 200",
          "Tag: Tier 1",
          "Strategic",
          "Last Activity Time: 2026-02-01T00:00:00.000Z",
        ].join(" | "),
      ].join("\n"),
    });
    await insertFile(db, {
      id: "note",
      providerFileId: "Notes:n1",
      fileName: "Note",
      fileType: "crm_note",
      content: "# Long Note (Notes)\n\nParent: Acme\n\n## Description\nLong body\n[truncated]",
      rollupGroupId: "Accounts:a1",
    });
    await insertFile(db, {
      id: "populated",
      providerFileId: "Deals:d2",
      fileName: "Populated",
      fileType: "crm_deal",
      content: "# Populated (Deals)\n\nStage: Existing",
      sourceMeta: { zohoCrm: { module: "Deals", recordId: "d2", stage: "Already There" } },
    });

    expect(await backfillZohoSourceMeta(db, { apply: false })).toEqual({
      rowsSeen: 5,
      wouldUpdate: 4,
      updated: 0,
      fieldRowsWritten: 0,
      skippedAlreadyPopulated: 1,
      skippedMalformedProviderFileId: 0,
      truncatedNotes: 1,
    });
    expect(await backfillZohoSourceMeta(db, { apply: true })).toEqual({
      rowsSeen: 5,
      wouldUpdate: 4,
      updated: 4,
      fieldRowsWritten: 0,
      skippedAlreadyPopulated: 1,
      skippedMalformedProviderFileId: 0,
      truncatedNotes: 1,
    });

    expect((await readMeta(db, "deal")).zohoCrm).toMatchObject({
      module: "Deals",
      recordId: "d1",
      backfilled: true,
      stage: "Qualification",
      amount: "5000",
      closingDate: "2026-10-01",
      probability: "50",
    });
    expect((await readMeta(db, "task")).zohoCrm).toMatchObject({
      module: "Tasks",
      recordId: "t1",
      related: [{ role: "parent", module: "Deals", id: "d1" }],
      status: "Open",
      priority: "High",
      dueDate: "2026-03-01",
    });
    expect((await readMeta(db, "account")).zohoCrm).not.toHaveProperty("related");
    expect((await readMeta(db, "account")).zohoCrm).toMatchObject({
      module: "Accounts",
      recordId: "a1",
      owner: "Shreeja P",
      industry: "Finance",
      website: "https://acme.test",
      companySize: "200",
      tag: "Tier 1 | Strategic",
      lastActivityTime: "2026-02-01T00:00:00.000Z",
    });
    expect((await readMeta(db, "note")).zohoCrm).toEqual({
      module: "Notes",
      recordId: "n1",
      backfilled: true,
      createdTime: "2026-01-01T00:00:00.000Z",
      modifiedTime: "2026-01-02T00:00:00.000Z",
    });
    expect((await readMeta(db, "populated")).zohoCrm).toEqual({
      module: "Deals",
      recordId: "d2",
      stage: "Already There",
    });
  });
});
