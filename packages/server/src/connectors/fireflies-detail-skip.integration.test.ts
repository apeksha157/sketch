/**
 * Detail-skip behavior for the Fireflies connector.
 *
 * Incremental syncs consult prior per-transcript detail state (persisted in
 * `indexed_files.source_meta.detail`, looked up through `connector_files`
 * ownership links) to avoid re-fetching the per-transcript detail query for
 * transcripts whose detail already settled. These tests seed real DB rows and
 * drive `connector.sync()` against a stubbed Fireflies API, asserting which
 * transcript ids get detail requests and which items are yielded.
 *
 * Runs against both dialects: ownership traversal and source_meta parsing are
 * DB-level concerns. The Postgres variant uses the worker-shared PGlite with
 * per-test BEGIN/ROLLBACK per the repo testing convention.
 */
import { type Kysely, sql } from "kysely";
import pino from "pino";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, getSharedPgDb } from "../test-utils";
import { createFirefliesConnector } from "./fireflies";
import type { SyncedItem } from "./types";

const silentLogger = pino({ level: "silent" });

const CONFIG_A = "fireflies-config-a";
const CONFIG_B = "fireflies-config-b";

const HOUR_MS = 60 * 60 * 1000;

interface TranscriptFixture {
  id: string;
  title?: string;
  date?: number;
}

interface DetailMarkerSeed {
  fetchedAt?: string;
  attempts: number;
  summaryObserved: boolean;
  contactsLoaded: boolean;
  nextRetryAt?: string;
}

interface DetailFixture {
  summary?: {
    overview: string | string[] | null;
    shorthand_bullet: string | string[] | null;
    action_items: string | string[] | null;
    keywords: string | null;
  } | null;
}

function settledMarker(): DetailMarkerSeed {
  return { fetchedAt: new Date().toISOString(), attempts: 1, summaryObserved: true, contactsLoaded: true };
}

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values([
      { id: "user-a", name: "User A", email: "user-a@example.com" },
      { id: "user-b", name: "User B", email: "user-b@example.com" },
    ])
    .execute();
  await db
    .insertInto("connector_configs")
    .values([
      { id: CONFIG_A, connector_type: "fireflies", auth_type: "api_key", credentials: "{}", created_by: "user-a" },
      { id: CONFIG_B, connector_type: "fireflies", auth_type: "api_key", credentials: "{}", created_by: "user-b" },
    ])
    .execute();
}

async function seedIndexedTranscript(
  db: Kysely<DB>,
  opts: {
    providerFileId: string;
    ownedBy: string;
    linkedTo: string[];
    marker?: DetailMarkerSeed | null;
    rawSourceMeta?: string;
    archived?: boolean;
    source?: string;
  },
): Promise<void> {
  const fileId = `file-${opts.providerFileId}`;
  const sourceMeta =
    opts.rawSourceMeta !== undefined
      ? opts.rawSourceMeta
      : opts.marker !== undefined
        ? opts.marker === null
          ? null
          : JSON.stringify({ detail: opts.marker })
        : null;
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: opts.ownedBy,
      source: opts.source ?? "fireflies",
      provider_file_id: opts.providerFileId,
      file_name: `Meeting ${opts.providerFileId}`,
      file_type: "meeting_transcript",
      content_category: "document",
      content: "existing content",
      source_path: null,
      provider_url: null,
      source_updated_at: "2026-09-01T00:00:00.000Z",
      synced_at: "2026-09-01T00:00:00.000Z",
      is_archived: opts.archived ? 1 : 0,
      source_meta: sourceMeta,
    })
    .execute();
  if (opts.linkedTo.length > 0) {
    await db
      .insertInto("connector_files")
      .values(opts.linkedTo.map((configId) => ({ connector_config_id: configId, indexed_file_id: fileId })))
      .execute();
  }
}

/**
 * Drive one sync run against a stubbed API. Returns the yielded items and the
 * transcript ids that received a detail query.
 */
async function runSync(
  db: Kysely<DB> | undefined,
  connectorConfigId: string,
  transcripts: TranscriptFixture[],
  opts: { cursor?: string | null; contactsFail?: boolean; detail?: DetailFixture } = {},
): Promise<{ items: SyncedItem[]; detailedIds: string[] }> {
  const detailedIds: string[] = [];
  const detailSummary =
    opts.detail !== undefined
      ? opts.detail.summary
      : { overview: "A summary", shorthand_bullet: null, action_items: null, keywords: null };
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };

    if (body.query.includes("contacts {")) {
      if (opts.contactsFail) {
        return new Response("boom", { status: 400, headers: { "Content-Type": "text/plain" } });
      }
      return new Response(JSON.stringify({ data: { contacts: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.query.includes("transcripts(")) {
      const page =
        (body.variables.skip as number) === 0
          ? transcripts.map((t) => ({
              id: t.id,
              title: t.title ?? `Meeting ${t.id}`,
              date: t.date ?? Date.now() - HOUR_MS,
              duration: 600,
              organizer_email: null,
              host_email: null,
              participants: [],
              meeting_attendees: [],
              transcript_url: null,
            }))
          : [];
      return new Response(JSON.stringify({ data: { transcripts: page } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.query.includes("transcript(id:")) {
      detailedIds.push(body.variables.id as string);
      return new Response(JSON.stringify({ data: { transcript: { summary: detailSummary, speakers: [] } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    const connector = createFirefliesConnector({ minRequestIntervalMs: 0 });
    const items: SyncedItem[] = [];
    for await (const item of connector.sync({
      db,
      connectorConfigId,
      credentials: { type: "api_key", api_key: "test" },
      scopeConfig: {},
      cursor: opts.cursor === undefined ? new Date().toISOString() : opts.cursor,
      logger: silentLogger,
      ownerEmail: null,
      resolveNameToEmail: undefined,
    })) {
      items.push(item);
    }
    return { items, detailedIds };
  } finally {
    fetchSpy.mockRestore();
  }
}

function detailMarkerOf(item: SyncedItem): Record<string, unknown> {
  return (item.sourceMeta as { detail: Record<string, unknown> }).detail;
}

function runSuite(label: string, mode: "sqlite" | "pglite") {
  describe(label, () => {
    let db!: Kysely<DB>;

    if (mode === "pglite") {
      beforeAll(async () => {
        db = await getSharedPgDb();
      }, 30000);
    }

    beforeEach(async () => {
      if (mode === "pglite") {
        await sql`BEGIN`.execute(db);
      } else {
        db = await createTestDb();
      }
      await seedBase(db);
    });

    afterEach(async () => {
      if (mode === "pglite") {
        await sql`ROLLBACK`.execute(db);
      }
      vi.restoreAllMocks();
    });

    it("skips detail and yield for a linked transcript with a settled marker", async () => {
      await seedIndexedTranscript(db, {
        providerFileId: "t1",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        marker: settledMarker(),
      });

      const { items, detailedIds } = await runSync(db, CONFIG_A, [{ id: "t1" }]);
      expect(detailedIds).toEqual([]);
      expect(items).toHaveLength(0);
    });

    it("lets config B skip a settled file owned by config A but linked to B", async () => {
      await seedIndexedTranscript(db, {
        providerFileId: "t1",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A, CONFIG_B],
        marker: settledMarker(),
      });

      const { items, detailedIds } = await runSync(db, CONFIG_B, [{ id: "t1" }]);
      expect(detailedIds).toEqual([]);
      expect(items).toHaveLength(0);
    });

    it("details a settled file that is linked only to the other config", async () => {
      await seedIndexedTranscript(db, {
        providerFileId: "t1",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        marker: settledMarker(),
      });

      const { items, detailedIds } = await runSync(db, CONFIG_B, [{ id: "t1" }]);
      expect(detailedIds).toEqual(["t1"]);
      expect(items).toHaveLength(1);
    });

    it("details a file whose link to this config was removed", async () => {
      await seedIndexedTranscript(db, {
        providerFileId: "t1",
        ownedBy: CONFIG_A,
        linkedTo: [],
        marker: settledMarker(),
      });

      const { items, detailedIds } = await runSync(db, CONFIG_A, [{ id: "t1" }]);
      expect(detailedIds).toEqual(["t1"]);
      expect(items).toHaveLength(1);
    });

    it("details an archived transcript that reappears, even with a settled marker", async () => {
      await seedIndexedTranscript(db, {
        providerFileId: "t1",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        marker: settledMarker(),
        archived: true,
      });

      const { items, detailedIds } = await runSync(db, CONFIG_A, [{ id: "t1" }]);
      expect(detailedIds).toEqual(["t1"]);
      expect(items).toHaveLength(1);
    });

    it("skips an unsettled transcript whose nextRetryAt is in the future", async () => {
      await seedIndexedTranscript(db, {
        providerFileId: "t1",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        marker: {
          fetchedAt: new Date().toISOString(),
          attempts: 1,
          summaryObserved: false,
          contactsLoaded: true,
          nextRetryAt: new Date(Date.now() + HOUR_MS).toISOString(),
        },
      });

      const { items, detailedIds } = await runSync(db, CONFIG_A, [{ id: "t1" }]);
      expect(detailedIds).toEqual([]);
      expect(items).toHaveLength(0);
    });

    it("re-details an unsettled transcript past nextRetryAt and increments attempts", async () => {
      await seedIndexedTranscript(db, {
        providerFileId: "t1",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        marker: {
          fetchedAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
          attempts: 1,
          summaryObserved: false,
          contactsLoaded: true,
          nextRetryAt: new Date(Date.now() - HOUR_MS).toISOString(),
        },
      });

      const { items, detailedIds } = await runSync(db, CONFIG_A, [{ id: "t1" }]);
      expect(detailedIds).toEqual(["t1"]);
      expect(items).toHaveLength(1);
      const marker = detailMarkerOf(items[0]);
      expect(marker.attempts).toBe(2);
      expect(marker.summaryObserved).toBe(true);
      expect(marker.nextRetryAt).toBeUndefined();
    });

    it("persists the yielded marker and skips on the following run", async () => {
      const { items: firstItems, detailedIds: firstDetailed } = await runSync(db, CONFIG_A, [{ id: "t1" }]);
      expect(firstDetailed).toEqual(["t1"]);
      expect(firstItems).toHaveLength(1);

      // Store the file the way processSyncedItem would: the yielded item's
      // sourceMeta lands in indexed_files.source_meta and the file is linked.
      await seedIndexedTranscript(db, {
        providerFileId: "t1",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        rawSourceMeta: JSON.stringify(firstItems[0].sourceMeta),
      });

      const { items: secondItems, detailedIds: secondDetailed } = await runSync(db, CONFIG_A, [{ id: "t1" }]);
      expect(secondDetailed).toEqual([]);
      expect(secondItems).toHaveLength(0);
    });

    it("treats attempts >= 4 as settled even when contacts never loaded (accepted residual edge)", async () => {
      await seedIndexedTranscript(db, {
        providerFileId: "t1",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        marker: { fetchedAt: new Date().toISOString(), attempts: 4, summaryObserved: false, contactsLoaded: false },
      });

      const { items, detailedIds } = await runSync(db, CONFIG_A, [{ id: "t1" }]);
      expect(detailedIds).toEqual([]);
      expect(items).toHaveLength(0);
    });

    it("details transcripts with malformed or missing markers", async () => {
      await seedIndexedTranscript(db, {
        providerFileId: "t1",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        rawSourceMeta: "not json{",
      });
      await seedIndexedTranscript(db, {
        providerFileId: "t2",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        rawSourceMeta: '{"detail":"wrong-shape"}',
      });
      await seedIndexedTranscript(db, { providerFileId: "t3", ownedBy: CONFIG_A, linkedTo: [CONFIG_A], marker: null });
      await seedIndexedTranscript(db, {
        providerFileId: "t4",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        rawSourceMeta: JSON.stringify({
          detail: { fetchedAt: new Date().toISOString(), attempts: -1, summaryObserved: true, contactsLoaded: true },
        }),
      });
      await seedIndexedTranscript(db, {
        providerFileId: "t5",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        rawSourceMeta: JSON.stringify({
          detail: { fetchedAt: new Date().toISOString(), attempts: 1.5, summaryObserved: true, contactsLoaded: true },
        }),
      });

      const { items, detailedIds } = await runSync(db, CONFIG_A, [
        { id: "t1" },
        { id: "t2" },
        { id: "t3" },
        { id: "t4" },
        { id: "t5" },
      ]);
      expect(detailedIds.sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
      expect(items).toHaveLength(5);
    });

    it("never skips on a full sync (no cursor)", async () => {
      await seedIndexedTranscript(db, {
        providerFileId: "t1",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        marker: settledMarker(),
      });

      const { items, detailedIds } = await runSync(db, CONFIG_A, [{ id: "t1" }], { cursor: null });
      expect(detailedIds).toEqual(["t1"]);
      expect(items).toHaveLength(1);
    });

    it("ignores rows from other sources sharing a provider_file_id namespace", async () => {
      await seedIndexedTranscript(db, {
        providerFileId: "t1",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        marker: settledMarker(),
        source: "google_calendar",
      });

      const { items, detailedIds } = await runSync(db, CONFIG_A, [{ id: "t1" }]);
      expect(detailedIds).toEqual(["t1"]);
      expect(items).toHaveLength(1);
    });

    it("handles mixed skipped and detailed transcripts in one page", async () => {
      await seedIndexedTranscript(db, {
        providerFileId: "settled",
        ownedBy: CONFIG_A,
        linkedTo: [CONFIG_A],
        marker: settledMarker(),
      });

      const { items, detailedIds } = await runSync(db, CONFIG_A, [{ id: "settled" }, { id: "brand-new" }]);
      expect(detailedIds).toEqual(["brand-new"]);
      expect(items).toHaveLength(1);
      expect(items[0].providerFileId).toBe("brand-new");
    });

    it("leaves items unsettled when the contacts directory fails to load", async () => {
      const { items } = await runSync(db, CONFIG_A, [{ id: "t1" }], { contactsFail: true });
      expect(items).toHaveLength(1);
      const marker = detailMarkerOf(items[0]);
      expect(marker.contactsLoaded).toBe(false);
      expect(marker.summaryObserved).toBe(true);
      expect(marker.nextRetryAt).toBeDefined();
    });

    it("does not count whitespace-only summary arrays as observed summary content", async () => {
      const { items } = await runSync(db, CONFIG_A, [{ id: "t1" }], {
        detail: { summary: { overview: null, shorthand_bullet: [""], action_items: ["   "], keywords: null } },
      });
      expect(items).toHaveLength(1);
      const marker = detailMarkerOf(items[0]);
      expect(marker.summaryObserved).toBe(false);
      expect(marker.nextRetryAt).toBeDefined();
    });

    it("counts a non-empty action_items array as summary content", async () => {
      const { items } = await runSync(db, CONFIG_A, [{ id: "t1" }], {
        detail: {
          summary: { overview: null, shorthand_bullet: null, action_items: ["Follow up with Sanaa"], keywords: null },
        },
      });
      expect(items).toHaveLength(1);
      expect(detailMarkerOf(items[0]).summaryObserved).toBe(true);
    });
  });
}

runSuite("fireflies detail skip (sqlite)", "sqlite");
runSuite("fireflies detail skip (pglite)", "pglite");
