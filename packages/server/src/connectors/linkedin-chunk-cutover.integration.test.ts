import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createConversationRepository } from "../db/repositories/conversations";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger, createTestPgDb } from "../test-utils";
import type { AimfoxLead } from "./aimfox-client";
import type { ChunkGenerate } from "./chunk-generate";
import { createLinkedinAimfoxConnector } from "./linkedin-aimfox";
import { LINKEDIN_CONVERSATION_FILE_TYPE } from "./linkedin-emission";
import {
  LINKEDIN_CONVERSATION_KIND,
  LINKEDIN_CONVERSATION_PLATFORM,
  linkedinProviderConversationId,
} from "./linkedin-ingest";
import { getSyncIdentity, syncIdentityKey } from "./sync-identity";
import { loadExistingContentHashes, processSyncedItem } from "./sync-item";
import type { SyncedItem } from "./types";

const CONNECTOR_TYPE = "linkedin_aimfox";
const ACCOUNT_ID = "acct-1";
const OWNER_EMAIL = "member@example.com";
const HOUR_MS = 60 * 60 * 1000;

const credentials = { type: "api_key", api_key: "key" } as const;
const scopeConfig = { accountIds: [ACCOUNT_ID], maxRpm: 100_000 };

interface StubMessage {
  id: string;
  from: "owner" | "lead";
  body: string;
  at: number;
}

interface StubConversation {
  conversationUrn: string;
  leadId: string;
  messages: StubMessage[];
}

/** Counts the numbered prompt lines the engine renders, so a stub can cover the whole window. */
function promptMessageCount(prompt: string): number {
  return [...prompt.matchAll(/^\d+\. /gm)].length;
}

/** Never splits: every window comes back as one topic segment. */
const singleTopic: ChunkGenerate = async (prompt) =>
  JSON.stringify({ segments: [{ start: 1, end: promptMessageCount(prompt), threads: ["outreach"] }] });

function leadFixture(leadId: string): AimfoxLead {
  return {
    id: leadId,
    urn: `urn:li:${leadId}`,
    first_name: "Priya",
    last_name: "Nair",
    full_name: "Priya Nair",
    public_identifier: leadId,
    occupation: "Founder",
    picture_url: "",
    location: { name: "San Francisco" },
    about: "About",
    premium: false,
    connections: 500,
    followers: 1000,
    current_experience: [],
    work_experience: [],
    education: [],
    skills: [],
    certifications: [],
    languages: [],
    contact_info: { phone_numbers: [] },
    phones: [],
    email: `${leadId}@example.com`,
    emails: [{ address: `${leadId}@example.com`, type: "work" }],
    labels: [],
    notes: [],
    is_lead: true,
    lead_of: [],
    origins: [],
  };
}

/** A lead with neither a public identifier nor a name: `buildPersonSeed` returns null for it. */
function unseedableLead(leadId: string): AimfoxLead {
  return { ...leadFixture(leadId), public_identifier: "", full_name: "", first_name: "", last_name: "" };
}

/**
 * Records the conversation urns a run fetched details for, so a test can assert
 * a thread was genuinely not listed rather than assume it.
 */
function stubAimfox(
  conversations: StubConversation[],
  options: { leadSeedable?: boolean } = {},
): { detailFetches: string[] } {
  const detailFetches: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (/\/accounts$/.test(url)) {
      return json({ status: "ok", accounts: [{ id: ACCOUNT_ID, full_name: "Member User" }] });
    }
    if (url.includes("/conversations?")) {
      const params = new URL(url).searchParams;
      const before = Number(params.get("before"));
      const page = conversations
        .map((conversation) => ({
          unread_count: 0,
          connected: true,
          last_activity_at: conversation.messages.at(-1)?.at ?? 0,
          conversation_urn: conversation.conversationUrn,
          last_message: {
            body: "Thanks",
            sender: { id: ACCOUNT_ID, full_name: "Member User" },
            created_at: conversation.messages.at(-1)?.at ?? 0,
          },
          participants: [
            {
              id: conversation.leadId,
              urn: `urn:li:${conversation.leadId}`,
              public_identifier: conversation.leadId,
              full_name: "Priya Nair",
              is_lead: true,
              lead_of: [],
              labels: [],
            },
          ],
          owner: ACCOUNT_ID,
          source: "linkedin",
        }))
        .filter((conversation) => conversation.last_activity_at < before)
        .sort((left, right) => right.last_activity_at - left.last_activity_at)
        .slice(0, Number(params.get("count")) || 100);
      return json({ status: "ok", conversations: page });
    }
    const conversationMatch = url.match(/\/accounts\/([^/]+)\/conversations\/(.+)$/);
    if (conversationMatch) {
      const conversationUrn = decodeURIComponent(conversationMatch[2]);
      detailFetches.push(conversationUrn);
      const conversation = conversations.find((entry) => entry.conversationUrn === conversationUrn);
      return json({
        status: "ok",
        messages: (conversation?.messages ?? []).map((message) => ({
          id: message.id,
          body: message.body,
          created_at: message.at,
          sender:
            message.from === "owner"
              ? { id: ACCOUNT_ID, full_name: "Member User" }
              : { id: conversation?.leadId ?? "lead", full_name: "Priya Nair" },
        })),
      });
    }
    const leadId = decodeURIComponent(url.split("/leads/")[1] ?? "");
    return json({ status: "ok", lead: options.leadSeedable === false ? unseedableLead(leadId) : leadFixture(leadId) });
  });
  return { detailFetches };
}

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>): void {
  describe(label, () => {
    let db!: Kysely<DB>;
    let connectorConfigId!: string;
    let base!: number;

    beforeEach(async () => {
      db = await createDb();
      base = Date.now();
      const ownerId = `owner-${randomUUID()}`;
      await createUserRepository(db).create({ id: ownerId, name: "Member User", email: OWNER_EMAIL });
      const config = await createConnectorRepository(db).createConfig({
        connectorType: CONNECTOR_TYPE,
        authType: "api_key",
        credentials: JSON.stringify(credentials),
        scopeConfig: JSON.stringify(scopeConfig),
        createdBy: ownerId,
      });
      connectorConfigId = config.id;
    }, 30_000);

    afterEach(async () => {
      vi.restoreAllMocks();
      await db.destroy();
    });

    /**
     * The `sync.ts` item loop, reduced to what the cutover depends on: persist
     * each item, link its slice, report the result back to the connector, then
     * take the cursor. Keeping the order faithful is the point — the archive
     * pass runs after the last `onItemResult`.
     */
    async function runSync(options: {
      cursor: string | null;
      engineEnabled: boolean;
      generate?: ChunkGenerate;
      /** The flag is on but no boundary generator is configured, so the engine cannot run. */
      noGenerator?: boolean;
      appConfig?: Record<string, unknown>;
      /** Reports the matching items back as failed without writing them, the way a persist error would. */
      failItem?: (item: SyncedItem) => boolean;
    }): Promise<{ items: SyncedItem[]; cursor: string | null }> {
      const connector = createLinkedinAimfoxConnector();
      const repo = createConnectorRepository(db);
      const existingHashes = await loadExistingContentHashes(db, CONNECTOR_TYPE, connectorConfigId);
      const logger = createTestLogger();
      const items: SyncedItem[] = [];

      for await (const item of connector.sync({
        db,
        connectorConfigId,
        credentials,
        scopeConfig,
        cursor: options.cursor,
        logger,
        ownerEmail: OWNER_EMAIL,
        linkedinChunkerGenerate: options.noGenerator ? undefined : (options.generate ?? singleTopic),
        appConfig: {
          LINKEDIN_CHUNK_ENGINE_ENABLED: options.engineEnabled,
          ...options.appConfig,
        } as never,
        getExistingItemState: (providerFileId) => {
          const state = existingHashes.get(
            syncIdentityKey(getSyncIdentity({ connectorConfigId, connectorType: CONNECTOR_TYPE, providerFileId })),
          );
          return state ? { sourceMeta: state.sourceMeta, threadId: state.threadId } : null;
        },
      })) {
        if (options.failItem?.(item)) {
          await connector.onItemResult?.({ item, persisted: false, error: "stub persist failure" });
          continue;
        }
        const outcome = await processSyncedItem({
          db,
          repo,
          connectorConfigId,
          connectorType: CONNECTOR_TYPE,
          item,
          existingHashes,
        });
        if (outcome.kind === "skipped_empty") {
          await connector.onItemResult?.({ item, persisted: false, error: "empty synced item" });
          continue;
        }
        if (item.conversationSliceId) {
          await db
            .updateTable("conversation_slices")
            .set({ indexed_file_id: outcome.indexedFileId, legacy_unjudged_at: null })
            .where("id", "=", item.conversationSliceId)
            .execute();
        }
        await connector.onItemResult?.({ item, persisted: true });
        items.push(item);
      }

      const cursor = await connector.getCursor({
        credentials,
        scopeConfig,
        currentCursor: options.cursor,
        logger,
      });
      return { items, cursor };
    }

    async function conversationFiles(): Promise<
      Array<{ provider_file_id: string; file_type: string | null; is_archived: number }>
    > {
      return db
        .selectFrom("indexed_files")
        .select(["provider_file_id", "file_type", "is_archived"])
        .orderBy("provider_file_id", "asc")
        .execute();
    }

    function legacySegments(files: Array<{ provider_file_id: string; is_archived: number }>) {
      return files.filter((file) => file.provider_file_id.includes(":segment-"));
    }

    function engineFiles(
      files: Array<{ provider_file_id: string; file_type: string | null; is_archived: number }>,
    ): Array<{ provider_file_id: string; is_archived: number }> {
      return files.filter(
        (file) => file.file_type === LINKEDIN_CONVERSATION_FILE_TYPE && !file.provider_file_id.startsWith("linkedin:"),
      );
    }

    async function messageCount(): Promise<number> {
      const row = await db
        .selectFrom("conversation_messages")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      return Number(row.count);
    }

    /**
     * Three messages a day apart: the legacy 4-hour gap cuts them into three
     * segments. `shiftHours` moves the whole thread forward, which is how a
     * thread is made new enough for a later run's incremental pass to list it.
     */
    function spacedConversation(conversationUrn: string, leadId: string, shiftHours = 0): StubConversation {
      const at = (hoursAgo: number) => base - (hoursAgo - shiftHours) * HOUR_MS;
      return {
        conversationUrn,
        leadId,
        messages: [
          { id: `${leadId}-m1`, from: "owner", body: "Loved your talk, can we compare notes?", at: at(30) },
          { id: `${leadId}-m2`, from: "lead", body: "Yes, pricing is what we wrestle with.", at: at(20) },
          { id: `${leadId}-m3`, from: "owner", body: "Here is how we price it.", at: at(10) },
        ],
      };
    }

    /**
     * The durable fact D13 routes on, and the only thing that puts a
     * conversation on the engine: the reindex worker writes this row before it
     * re-fetches the thread. Nothing in a sync run creates it on its own.
     */
    async function placeOnEngine(conversationUrn: string): Promise<void> {
      await createConversationRepository(db).getOrCreate(
        {
          platform: LINKEDIN_CONVERSATION_PLATFORM,
          kind: LINKEDIN_CONVERSATION_KIND,
          providerConversationId: linkedinProviderConversationId(ACCOUNT_ID, conversationUrn),
        },
        "Priya Nair",
      );
    }

    /** A fresh inbound reply, newer than everything the thread already holds. */
    function withReply(conversation: StubConversation, body: string): StubConversation {
      return {
        ...conversation,
        messages: [
          ...conversation.messages,
          { id: `${conversation.leadId}-reply`, from: "lead", body, at: base - HOUR_MS },
        ],
      };
    }

    async function sliceIds(): Promise<string[]> {
      const rows = await db.selectFrom("conversation_slices").select("id").orderBy("id", "asc").execute();
      return rows.map((row) => row.id);
    }

    async function conversationRowId(conversationUrn: string): Promise<number> {
      const row = await db
        .selectFrom("conversations")
        .select("id")
        .where("provider_conversation_id", "=", `${ACCOUNT_ID}:${conversationUrn}`)
        .executeTakeFirstOrThrow();
      return row.id;
    }

    /**
     * A second thread whose fresh reply drags the run watermark past the thread
     * under test, so the next run genuinely does not list that one. A
     * single-conversation fixture cannot do this: its own last activity is the
     * watermark, and `activity >= highWatermark` re-lists it every run — which
     * would quietly hide any defect that only appears once a conversation stops
     * being listed. It stays on the segmenter throughout, so it adds no engine
     * files of its own.
     */
    function watermarkCarrier(replied: boolean): StubConversation {
      const conversation = spacedConversation("urn:conversation:2", "lead-2");
      return replied ? withReply(conversation, "Separate thread, fresh reply") : conversation;
    }

    async function sliceStatuses(conversationUrn: string): Promise<string[]> {
      const rows = await db
        .selectFrom("conversation_slices")
        .select("status")
        .where("conversation_id", "=", await conversationRowId(conversationUrn))
        .orderBy("first_message_id", "asc")
        .execute();
      return rows.map((row) => row.status);
    }

    function segmentsOf(
      files: Array<{ provider_file_id: string; is_archived: number }>,
      conversationUrn: string,
    ): number[] {
      return legacySegments(files)
        .filter((file) => file.provider_file_id.includes(conversationUrn))
        .map((file) => file.is_archived);
    }

    it("chunks a brand-new conversation on the engine without waiting for a reindex", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1")]);

      await runSync({ cursor: null, engineEnabled: true });

      const files = await conversationFiles();
      expect(legacySegments(files)).toHaveLength(0);
      expect(engineFiles(files).filter((file) => file.is_archived === 0)).toHaveLength(1);
      expect(await sliceIds()).not.toHaveLength(0);
      expect(await messageCount()).toBe(3);
    });

    it("keeps a pre-engine conversation on the segmenter while its legacy files are live", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1")]);
      const legacyRun = await runSync({ cursor: null, engineEnabled: false });
      expect(legacySegments(await conversationFiles())).toHaveLength(3);

      stubAimfox([withReply(spacedConversation("urn:conversation:1", "lead-1"), "One more thought on pricing")]);
      await runSync({ cursor: legacyRun.cursor, engineEnabled: true });

      const files = await conversationFiles();
      expect(legacySegments(files).length).toBeGreaterThan(3);
      expect(legacySegments(files).every((file) => file.is_archived === 0)).toBe(true);
      expect(engineFiles(files)).toHaveLength(0);
      expect(await sliceIds()).toHaveLength(0);
      expect(await db.selectFrom("conversations").select("id").execute()).toHaveLength(0);
    });

    it("moves a pre-engine conversation onto the engine once the reindex archived its legacy files", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1")]);
      const legacyRun = await runSync({ cursor: null, engineEnabled: false });
      await db
        .updateTable("indexed_files")
        .set({ is_archived: 1 })
        .where("file_type", "=", LINKEDIN_CONVERSATION_FILE_TYPE)
        .where("provider_file_id", "like", "linkedin:%:segment-%")
        .execute();
      await placeOnEngine("urn:conversation:1");

      await runSync({ cursor: legacyRun.cursor, engineEnabled: true });

      const files = await conversationFiles();
      expect(legacySegments(files).map((file) => file.is_archived)).toEqual([1, 1, 1]);
      expect(engineFiles(files).filter((file) => file.is_archived === 0)).toHaveLength(1);
      expect(await sliceIds()).not.toHaveLength(0);
    });

    it("keeps a touched conversation on its legacy segments while it has no conversation row", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1")]);

      const legacyRun = await runSync({ cursor: null, engineEnabled: false });
      expect(legacySegments(await conversationFiles())).toHaveLength(3);

      await runSync({ cursor: legacyRun.cursor, engineEnabled: true });
      const files = await conversationFiles();

      expect(legacySegments(files).map((file) => file.is_archived)).toEqual([0, 0, 0]);
      expect(engineFiles(files)).toHaveLength(0);
      expect(await messageCount()).toBe(0);
      expect(await db.selectFrom("conversations").select("id").execute()).toHaveLength(0);
    });

    it("moves a conversation the reindex placed on the engine and archives its segment files", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1")]);

      const legacyRun = await runSync({ cursor: null, engineEnabled: false });
      expect(legacySegments(await conversationFiles())).toHaveLength(3);
      await placeOnEngine("urn:conversation:1");

      await runSync({ cursor: legacyRun.cursor, engineEnabled: true });
      const files = await conversationFiles();

      expect(engineFiles(files).filter((file) => file.is_archived === 0)).toHaveLength(1);
      expect(legacySegments(files).map((file) => file.is_archived)).toEqual([1, 1, 1]);
      expect(files.find((file) => file.file_type === "linkedin_profile")?.is_archived).toBe(0);
      expect(await messageCount()).toBe(3);
    });

    it("publishes nothing and keeps the legacy files while the window budget leaves history undrained", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1"), watermarkCarrier(false)]);
      const legacyRun = await runSync({ cursor: null, engineEnabled: false });
      await placeOnEngine("urn:conversation:1");

      stubAimfox([spacedConversation("urn:conversation:1", "lead-1"), watermarkCarrier(true)]);
      const budgeted = await runSync({
        cursor: legacyRun.cursor,
        engineEnabled: true,
        appConfig: { LINKEDIN_CHUNK_WINDOW_MESSAGES: 1, LINKEDIN_CHUNK_MAX_WINDOWS_PER_RUN: 1 },
      });
      const midMigration = await conversationFiles();
      expect(segmentsOf(midMigration, "urn:conversation:1")).toEqual([0, 0, 0]);
      expect(engineFiles(midMigration)).toHaveLength(0);

      const quiet = stubAimfox([spacedConversation("urn:conversation:1", "lead-1"), watermarkCarrier(true)]);
      await runSync({ cursor: budgeted.cursor, engineEnabled: true });

      expect(quiet.detailFetches).not.toContain("urn:conversation:1");
      const finished = await conversationFiles();
      expect(segmentsOf(finished, "urn:conversation:1")).toEqual([1, 1, 1]);
      expect(engineFiles(finished).filter((file) => file.is_archived === 0)).toHaveLength(1);
    });

    it("lands a reply that arrives mid-migration only in the new generation", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1")]);
      const legacyRun = await runSync({ cursor: null, engineEnabled: false });
      await placeOnEngine("urn:conversation:1");

      const budgeted = await runSync({
        cursor: legacyRun.cursor,
        engineEnabled: true,
        appConfig: { LINKEDIN_CHUNK_WINDOW_MESSAGES: 1, LINKEDIN_CHUNK_MAX_WINDOWS_PER_RUN: 1 },
      });
      stubAimfox([withReply(spacedConversation("urn:conversation:1", "lead-1"), "Following up on the pricing note")]);

      const finished = await runSync({ cursor: budgeted.cursor, engineEnabled: true });

      const files = await conversationFiles();
      expect(legacySegments(files).map((file) => file.is_archived)).toEqual([1, 1, 1]);
      expect(engineFiles(files).filter((file) => file.is_archived === 0)).not.toHaveLength(0);
      expect(await messageCount()).toBe(4);
      const slices = finished.items.filter((item) => item.conversationSliceId);
      expect(slices.some((item) => item.content?.includes("Following up on the pricing note"))).toBe(true);
    });

    it("re-archives legacy files whose archive was lost after the cutover, without re-cutting", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1"), watermarkCarrier(false)]);
      const legacyRun = await runSync({ cursor: null, engineEnabled: false });
      await placeOnEngine("urn:conversation:1");
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1"), watermarkCarrier(true)]);
      const cutover = await runSync({ cursor: legacyRun.cursor, engineEnabled: true });
      const sliceIdsBefore = await sliceIds();

      await db
        .updateTable("indexed_files")
        .set({ is_archived: 0 })
        .where("file_type", "=", LINKEDIN_CONVERSATION_FILE_TYPE)
        .where("provider_file_id", "like", "linkedin:%:segment-%")
        .execute();

      const quiet = stubAimfox([spacedConversation("urn:conversation:1", "lead-1"), watermarkCarrier(true)]);
      await runSync({ cursor: cutover.cursor, engineEnabled: true });

      expect(quiet.detailFetches).not.toContain("urn:conversation:1");
      const files = await conversationFiles();
      expect(segmentsOf(files, "urn:conversation:1")).toEqual([1, 1, 1]);
      expect(engineFiles(files).filter((file) => file.is_archived === 0)).toHaveLength(1);
      expect(await sliceIds()).toEqual(sliceIdsBefore);
    });

    it("closes a quiet conversation's open tail once it passes the idle wall", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1"), watermarkCarrier(false)]);
      const legacyRun = await runSync({ cursor: null, engineEnabled: false });
      await placeOnEngine("urn:conversation:1");
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1"), watermarkCarrier(true)]);
      const cutover = await runSync({ cursor: legacyRun.cursor, engineEnabled: true });
      expect(await sliceStatuses("urn:conversation:1")).toEqual(["open"]);

      const quiet = stubAimfox([spacedConversation("urn:conversation:1", "lead-1"), watermarkCarrier(true)]);
      await runSync({
        cursor: cutover.cursor,
        engineEnabled: true,
        appConfig: { LINKEDIN_CHUNK_IDLE_CLOSE_HOURS: 1 },
      });

      expect(quiet.detailFetches).not.toContain("urn:conversation:1");
      expect(await sliceStatuses("urn:conversation:1")).toEqual(["closed"]);
    });

    it("mirrors the cutover when the flag goes off and back on", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1")]);
      const legacyRun = await runSync({ cursor: null, engineEnabled: false });
      await placeOnEngine("urn:conversation:1");
      const cutover = await runSync({ cursor: legacyRun.cursor, engineEnabled: true });
      expect(legacySegments(await conversationFiles()).map((file) => file.is_archived)).toEqual([1, 1, 1]);

      const rolledBack = await runSync({ cursor: cutover.cursor, engineEnabled: false });
      const afterRollback = await conversationFiles();
      expect(legacySegments(afterRollback).map((file) => file.is_archived)).toEqual([0, 0, 0]);
      expect(engineFiles(afterRollback).every((file) => file.is_archived === 1)).toBe(true);

      await runSync({ cursor: rolledBack.cursor, engineEnabled: true });
      const afterForward = await conversationFiles();
      expect(legacySegments(afterForward).map((file) => file.is_archived)).toEqual([1, 1, 1]);
      expect(engineFiles(afterForward).filter((file) => file.is_archived === 0)).toHaveLength(1);
    });

    it("writes no legacy segments over the engine files of a conversation the engine cannot run for", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1")]);
      await placeOnEngine("urn:conversation:1");
      const cutover = await runSync({ cursor: null, engineEnabled: true });
      expect(engineFiles(await conversationFiles()).filter((file) => file.is_archived === 0)).toHaveLength(1);

      await runSync({ cursor: cutover.cursor, engineEnabled: true, noGenerator: true });

      const files = await conversationFiles();
      expect(legacySegments(files)).toHaveLength(0);
      expect(engineFiles(files).filter((file) => file.is_archived === 0)).toHaveLength(1);
    });

    it("keeps the engine files when a rollback run produced no legacy segments", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1")]);
      await placeOnEngine("urn:conversation:1");
      const cutover = await runSync({ cursor: null, engineEnabled: true });
      expect(engineFiles(await conversationFiles()).filter((file) => file.is_archived === 0)).toHaveLength(1);

      stubAimfox([spacedConversation("urn:conversation:1", "lead-1")], { leadSeedable: false });
      await runSync({ cursor: cutover.cursor, engineEnabled: false });

      const files = await conversationFiles();
      expect(engineFiles(files).filter((file) => file.is_archived === 0)).toHaveLength(1);
      expect(legacySegments(files)).toHaveLength(0);
    });

    it("holds the legacy files of a conversation whose slice the emitter could not render", async () => {
      stubAimfox([
        spacedConversation("urn:conversation:1", "lead-1"),
        spacedConversation("urn:conversation:2", "lead-2"),
      ]);
      const legacyRun = await runSync({ cursor: null, engineEnabled: false });
      await placeOnEngine("urn:conversation:1");
      await placeOnEngine("urn:conversation:2");
      const cutover = await runSync({ cursor: legacyRun.cursor, engineEnabled: true });
      expect(legacySegments(await conversationFiles()).every((file) => file.is_archived === 1)).toBe(true);

      await db
        .updateTable("indexed_files")
        .set({ is_archived: 0 })
        .where("file_type", "=", LINKEDIN_CONVERSATION_FILE_TYPE)
        .where("provider_file_id", "like", "linkedin:%:segment-%")
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ roster_snapshot: "{}" })
        .where("conversation_id", "=", await conversationRowId("urn:conversation:1"))
        .execute();

      await runSync({ cursor: cutover.cursor, engineEnabled: true });

      const files = await conversationFiles();
      expect(segmentsOf(files, "urn:conversation:1")).toEqual([0, 0, 0]);
      expect(segmentsOf(files, "urn:conversation:2")).toEqual([1, 1, 1]);
    });

    it("writes no conversation rows at all while the flag is off", async () => {
      stubAimfox([spacedConversation("urn:conversation:1", "lead-1")]);

      const first = await runSync({ cursor: null, engineEnabled: false });
      await runSync({ cursor: first.cursor, engineEnabled: false });

      expect(await messageCount()).toBe(0);
      const conversations = await db.selectFrom("conversations").select("id").execute();
      expect(conversations).toHaveLength(0);
      expect(legacySegments(await conversationFiles()).map((file) => file.is_archived)).toEqual([0, 0, 0]);
    });
  });
}

runSuite("LinkedIn chunk cutover (sqlite)", createTestDb);
runSuite("LinkedIn chunk cutover (postgres)", createTestPgDb);
