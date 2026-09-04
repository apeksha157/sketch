/**
 * Raw-content persistence through processSyncedItem.
 *
 * Raw payloads (full transcripts) are written outside the item transaction by
 * design: a failed statement aborts a Postgres transaction, so the sync
 * persists the file first and compensates (drops the detail marker from
 * source_meta) when the raw write fails afterward. These tests seed real rows
 * and inject failures by dropping the raw table, so they need real autocommit
 * semantics — the Postgres variant uses a fresh createTestPgDb rather than the
 * worker-shared BEGIN/ROLLBACK db (a failed statement inside that wrapper
 * would abort the whole test transaction).
 */
import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createRawContentRepository } from "../db/repositories/raw-contents";
import type { DB } from "../db/schema";
import { createTestDb, createTestPgDb } from "../test-utils";
import { loadExistingContentHashes, processSyncedItem } from "./sync-item";
import type { SyncedItem } from "./types";

const CONFIG = "fireflies-config-raw";

const MARKER = { fetchedAt: "2026-09-04T00:00:00.000Z", attempts: 1, summaryObserved: true, contactsLoaded: true };

function transcriptItem(overrides: Partial<SyncedItem> = {}): SyncedItem {
  return {
    providerFileId: "t-raw-1",
    providerUrl: null,
    fileName: "Meeting t-raw-1",
    fileType: "meeting_transcript",
    contentCategory: "document",
    content: "summary content",
    sourcePath: null,
    contentHash: "hash-1",
    sourceCreatedAt: "2026-09-03T10:00:00.000Z",
    sourceUpdatedAt: "2026-09-03T10:00:00.000Z",
    sourceMeta: { detail: { ...MARKER } },
    rawContent: { kind: "transcript", content: "## Transcript\n[00:01] Sanaa: Full sentence" },
    ...overrides,
  };
}

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: "user-raw", name: "User", email: "user-raw@example.com" }).execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONFIG,
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: "{}",
      created_by: "user-raw",
    })
    .execute();
}

async function runItem(db: Kysely<DB>, item: SyncedItem) {
  const existingHashes = await loadExistingContentHashes(db, "fireflies", CONFIG);
  return processSyncedItem({
    db,
    repo: createConnectorRepository(db),
    connectorConfigId: CONFIG,
    connectorType: "fireflies",
    item,
    existingHashes,
  });
}

async function readFile(db: Kysely<DB>, indexedFileId: string) {
  return db
    .selectFrom("indexed_files")
    .select(["id", "content", "source_meta"])
    .where("id", "=", indexedFileId)
    .executeTakeFirstOrThrow();
}

function runSuite(label: string, makeDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    it("persists the raw row on the created path and updates it on the unchanged path, marker intact", async () => {
      const db = await makeDb();
      await seedBase(db);

      const first = await runItem(db, transcriptItem());
      expect(first.kind).toBe("created");
      const fileId = first.kind === "skipped_empty" ? "" : first.indexedFileId;
      const raw = await createRawContentRepository(db).getRawContent(fileId, "transcript");
      expect(raw?.content).toContain("Sanaa: Full sentence");

      const second = await runItem(
        db,
        transcriptItem({ rawContent: { kind: "transcript", content: "## Transcript\n[00:02] Sanaa: Amended" } }),
      );
      expect(second.kind).toBe("unchanged");
      const updated = await createRawContentRepository(db).getRawContent(fileId, "transcript");
      expect(updated?.content).toContain("Amended");
      const file = await readFile(db, fileId);
      expect(JSON.parse(file.source_meta ?? "{}")).toEqual({ detail: MARKER });
      const rows = await db.selectFrom("indexed_file_raw_contents").selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.char_length).toBe("## Transcript\n[00:02] Sanaa: Amended".length);
    });

    it("compensates a failed raw write on the created path: file survives, detail marker removed", async () => {
      const db = await makeDb();
      await seedBase(db);
      await db.schema.dropTable("indexed_file_raw_contents").execute();

      const result = await runItem(db, transcriptItem());
      expect(result.kind).toBe("created");
      const fileId = result.kind === "skipped_empty" ? "" : result.indexedFileId;
      const file = await readFile(db, fileId);
      expect(file.content).toBe("summary content");
      expect(file.source_meta).toBeNull();
    });

    it("omits the marker when the raw write fails on the unchanged path, but still updates sync metadata", async () => {
      const db = await makeDb();
      await seedBase(db);
      const created = await runItem(db, transcriptItem());
      const fileId = created.kind === "skipped_empty" ? "" : created.indexedFileId;
      await db
        .updateTable("indexed_files")
        .set({ source_meta: null, file_name: "Old title" })
        .where("id", "=", fileId)
        .execute();
      await db.schema.dropTable("indexed_file_raw_contents").execute();

      const result = await runItem(db, transcriptItem({ fileName: "New title" }));
      expect(result.kind).toBe("unchanged");
      const file = await db
        .selectFrom("indexed_files")
        .select(["file_name", "source_meta"])
        .where("id", "=", fileId)
        .executeTakeFirstOrThrow();
      expect(file.file_name).toBe("New title");
      expect(file.source_meta).toBeNull();
    });

    it("items without rawContent leave the raw table untouched and keep today's marker behavior", async () => {
      const db = await makeDb();
      await seedBase(db);

      const result = await runItem(db, transcriptItem({ rawContent: undefined }));
      expect(result.kind).toBe("created");
      const fileId = result.kind === "skipped_empty" ? "" : result.indexedFileId;
      const rows = await db.selectFrom("indexed_file_raw_contents").selectAll().execute();
      expect(rows).toHaveLength(0);
      const file = await readFile(db, fileId);
      expect(JSON.parse(file.source_meta ?? "{}")).toEqual({ detail: MARKER });
    });
  });
}

runSuite("raw-content persistence (sqlite)", () => createTestDb());
runSuite("raw-content persistence (pglite)", () => createTestPgDb());

describe("raw-content persistence keeps enrichment state intact (sqlite)", () => {
  it("an unchanged item with fresh raw content does not reset enrichment statuses", async () => {
    const db = await createTestDb();
    await seedBase(db);
    const created = await runItem(db, transcriptItem());
    const fileId = created.kind === "skipped_empty" ? "" : created.indexedFileId;
    await db
      .updateTable("indexed_files")
      .set({ embedding_status: "complete", summary_status: "complete" })
      .where("id", "=", fileId)
      .execute();

    await runItem(
      db,
      transcriptItem({ rawContent: { kind: "transcript", content: "## Transcript\n[00:05] Sanaa: Longer version" } }),
    );
    const file = await db
      .selectFrom("indexed_files")
      .select(["embedding_status", "summary_status"])
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow();
    expect(file.embedding_status).toBe("complete");
    expect(file.summary_status).toBe("complete");
    await sql`SELECT 1`.execute(db);
  });
});
