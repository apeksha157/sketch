import { type Kysely, sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "../db/index";
import type { DB } from "../db/schema";
import { createTestPgDb, getSharedPgDb } from "../test-utils";
import type { StageReport } from "./enrichment-stage-report";
import { hybridSearch, search, searchFiles } from "./search";
import { CRM_ACTIVITY_FILE_TYPES, type ContentCategory } from "./types";

const CONNECTOR_ID = "connector-crm-activity-visibility";
const DRIVE_CONNECTOR_ID = "connector-crm-activity-visibility-drive";
const QUERY_TERM = "bodylessvisibilityneedle";
const CONTACT_ID = "structured-crm_contact";
const NULL_FILE_TYPE_ID = "structured-null-file-type";

const visibleActivityIds = CRM_ACTIVITY_FILE_TYPES.map((fileType) => `document-${fileType}`);
const hiddenActivityIds = CRM_ACTIVITY_FILE_TYPES.map((fileType) => `structured-${fileType}`);
const expectedVisibleIds = [...visibleActivityIds, CONTACT_ID].sort();
const expectedVisibleIdsWithNullFileType = [...expectedVisibleIds, NULL_FILE_TYPE_ID].sort();

type VisibilityFixtureRow = {
  id: string;
  connectorConfigId: string;
  source: string;
  fileType: string | null;
  category: ContentCategory;
  fileName: string;
  timestamp: string;
};

function makeVector(dims: number, values: Record<number, number> = {}): string {
  const arr = new Array(dims).fill(0);
  for (const [idx, val] of Object.entries(values)) arr[Number(idx)] = val;
  return `[${arr.join(",")}]`;
}

async function insertConnector(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values([
      {
        id: CONNECTOR_ID,
        connector_type: "zoho_crm",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      },
      {
        id: DRIVE_CONNECTOR_ID,
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      },
    ])
    .onConflict((oc) => oc.doNothing())
    .execute();
}

async function insertVisibilityFixture(db: Kysely<DB>, opts: { withFileEmbeddings?: boolean } = {}): Promise<void> {
  await insertConnector(db);

  const now = Date.parse("2026-01-15T12:00:00.000Z");
  const rows: VisibilityFixtureRow[] = [
    ...CRM_ACTIVITY_FILE_TYPES.flatMap((fileType, index) => [
      {
        id: `structured-${fileType}`,
        connectorConfigId: CONNECTOR_ID,
        source: "zoho_crm",
        fileType,
        category: "structured" as const,
        fileName: `${QUERY_TERM} structured ${fileType}`,
        timestamp: new Date(now + index * 2000).toISOString(),
      },
      {
        id: `document-${fileType}`,
        connectorConfigId: CONNECTOR_ID,
        source: "zoho_crm",
        fileType,
        category: "document" as const,
        fileName: `${QUERY_TERM} document ${fileType}`,
        timestamp: new Date(now + index * 2000 + 1000).toISOString(),
      },
    ]),
    {
      id: CONTACT_ID,
      connectorConfigId: CONNECTOR_ID,
      source: "zoho_crm",
      fileType: "crm_contact",
      category: "structured",
      fileName: `${QUERY_TERM} structured crm_contact`,
      timestamp: new Date(now + 20_000).toISOString(),
    },
    {
      id: NULL_FILE_TYPE_ID,
      connectorConfigId: DRIVE_CONNECTOR_ID,
      source: "google_drive",
      fileType: null,
      category: "structured",
      fileName: `${QUERY_TERM} structured null file type`,
      timestamp: new Date(now + 21_000).toISOString(),
    },
  ];

  await db
    .insertInto("indexed_files")
    .values(
      rows.map((row) => ({
        id: row.id,
        connector_config_id: row.connectorConfigId,
        provider_file_id: row.id,
        file_name: row.fileName,
        file_type: row.fileType,
        content_category: row.category,
        source: row.source,
        source_path: null,
        provider_url: null,
        content: `# ${row.fileName}\nCRM rendered header block`,
        summary: null,
        context_note: null,
        access_scope_id: null,
        source_created_at: row.timestamp,
        source_updated_at: row.timestamp,
        synced_at: row.timestamp,
      })),
    )
    .execute();

  if (!opts.withFileEmbeddings) return;

  const vector = makeVector(EMBEDDING_DIMENSIONS, { 0: 1 });
  await db
    .insertInto("file_embeddings")
    .values(rows.map((row) => ({ indexed_file_id: row.id, embedding: vector })))
    .execute();
}

function expectOnlyDocumentsAndParentObjects(ids: string[]): void {
  expect(ids.slice().sort()).toEqual(expectedVisibleIds);
  for (const id of hiddenActivityIds) expect(ids).not.toContain(id);
}

function expectVisibleRowsIncludingNullFileType(ids: string[]): void {
  expect(ids.slice().sort()).toEqual(expectedVisibleIdsWithNullFileType);
  for (const id of hiddenActivityIds) expect(ids).not.toContain(id);
}

describe("CRM bodyless activity visibility on Postgres search paths", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
    await insertVisibilityFixture(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("hides structured CRM activities but keeps document activities in searchFiles", async () => {
    const results = await searchFiles(db, QUERY_TERM, { source: "zoho_crm", limit: 20 });

    expectOnlyDocumentsAndParentObjects(results.map((result) => result.id));

    const sourceAgnosticResults = await searchFiles(db, QUERY_TERM, { limit: 20 });
    expectVisibleRowsIncludingNullFileType(sourceAgnosticResults.map((result) => result.id));
  });

  it("hides structured CRM activities but keeps document activities in hybridSearch FTS", async () => {
    const results = await hybridSearch(db, QUERY_TERM, { source: "zoho_crm", limit: 20 });

    expectOnlyDocumentsAndParentObjects(results.map((result) => result.id));

    const sourceAgnosticResults = await hybridSearch(db, QUERY_TERM, { limit: 20 });
    expectVisibleRowsIncludingNullFileType(sourceAgnosticResults.map((result) => result.id));
  });

  it("hides structured CRM activities but keeps parent objects in recency browse", async () => {
    const results = await search(db, "", { sources: ["zoho_crm"], sortBy: "recency", limit: 20 });

    expectOnlyDocumentsAndParentObjects(results.map((result) => result.id));

    const sourceAgnosticResults = await search(db, "", {
      sources: ["zoho_crm", "google_drive"],
      sortBy: "recency",
      limit: 20,
    });
    expectVisibleRowsIncludingNullFileType(sourceAgnosticResults.map((result) => result.id));
  });
});

/**
 * `hybridSearch` opens its own transaction for the Postgres KNN reads, because
 * `SET LOCAL hnsw.*` cannot work outside a transaction; this suite uses a fresh
 * database instead of nesting inside the worker-shared BEGIN/ROLLBACK harness.
 */
describe("CRM bodyless activity visibility on Postgres KNN", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await createTestPgDb();
  }, 30000);

  afterEach(async () => {
    await sql`DELETE FROM indexed_files`.execute(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("pushes the bodyless CRM activity predicate into vector candidate SQL", async () => {
    await insertVisibilityFixture(db, { withFileEmbeddings: true });

    const queryEmbedding = new Array(EMBEDDING_DIMENSIONS).fill(0);
    queryEmbedding[0] = 1;

    const reports: StageReport[] = [];
    const results = await hybridSearch(db, "nomatchingtoken", {
      queryEmbedding,
      limit: 20,
      stageReport: (report) => reports.push(report),
    });

    expectVisibleRowsIncludingNullFileType(results.map((result) => result.id));
    const vectorReport = reports.find((report) => report.stage === "vectorCandidates");
    expect(vectorReport?.summary?.filesAfterDedup).toBe(expectedVisibleIdsWithNullFileType.length);
    expect(vectorReport?.summary?.imageVectorsScored).toBe(expectedVisibleIdsWithNullFileType.length);
  });
});
