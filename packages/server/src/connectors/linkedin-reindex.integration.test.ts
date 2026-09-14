import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createLinkedinReindexRepository } from "../db/repositories/linkedin-reindex";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger, createTestPgDb } from "../test-utils";
import type { AimfoxLead } from "./aimfox-client";
import type { ChunkGenerate } from "./chunk-generate";
import { createLinkedinAimfoxConnector } from "./linkedin-aimfox";
import { LINKEDIN_CONVERSATION_FILE_TYPE } from "./linkedin-emission";
import {
  LinkedinReindexWorker,
  type LinkedinSyncRequestOutcome,
  enqueueLinkedinReindex,
} from "./linkedin-reindex-worker";
import { resetRpmPacerForTests } from "./rpm-pacer";
import { getSyncIdentity, syncIdentityKey } from "./sync-identity";
import { loadExistingContentHashes, processSyncedItem } from "./sync-item";
import type { SyncedItem } from "./types";

const CONNECTOR_TYPE = "linkedin_aimfox";
const ACCOUNT_ID = "acct-1";
const OWNER_EMAIL = "member@example.com";
const HOUR_MS = 60 * 60 * 1000;

const credentials = { type: "api_key", api_key: "key" } as const;
const scopeConfig = { accountIds: [ACCOUNT_ID], maxRpm: 100_000, chunkEngine: true };

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

interface StubOptions {
  /** Status to answer a conversation detail fetch with, instead of the messages. */
  conversationStatus?: number;
  /** Counted so a test can prove a retry happened at all. */
  onConversationFetch?: () => void;
}

/**
 * Aimfox with an empty inbox listing: the reindex exists precisely because a
 * conversation that dropped out of the listing can no longer be reached that
 * way, so the stub never offers one.
 */
function stubAimfox(conversationMessagesAt: number[], options: StubOptions = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (/\/accounts$/.test(url)) {
      return json({ status: "ok", accounts: [{ id: ACCOUNT_ID, full_name: "Member User" }] });
    }
    if (url.includes("/conversations?")) return json({ status: "ok", conversations: [] });
    if (/\/accounts\/[^/]+\/conversations\/.+$/.test(url)) {
      options.onConversationFetch?.();
      if (options.conversationStatus) return json({ status: "error" }, options.conversationStatus);
      return json({
        status: "ok",
        messages: conversationMessagesAt.map((at, index) => ({
          id: `m-${index}`,
          body: `Message ${index}`,
          created_at: at,
          sender:
            index % 2 === 0 ? { id: ACCOUNT_ID, full_name: "Member User" } : { id: "lead-1", full_name: "Priya Nair" },
        })),
      });
    }
    const leadId = decodeURIComponent(url.split("/leads/")[1] ?? "");
    return json({ status: "ok", lead: leadFixture(leadId) });
  });
}

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>): void {
  describe(label, () => {
    let db!: Kysely<DB>;
    let connectorConfigId!: string;
    let base!: number;

    beforeEach(async () => {
      resetRpmPacerForTests();
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

    /** One pre-engine conversation: legacy segments hanging off the lead's profile file. */
    async function seedLegacyConversation(
      conversationUrn: string,
      leadId: string,
      options: { archived?: boolean } = {},
    ): Promise<void> {
      const repo = createConnectorRepository(db);
      for (let segmentIndex = 0; segmentIndex < 2; segmentIndex++) {
        const file = await repo.upsertFile({
          source: CONNECTOR_TYPE,
          providerFileId: `linkedin:${ACCOUNT_ID}:${conversationUrn}:segment-${segmentIndex}`,
          threadId: `${ACCOUNT_ID}:${conversationUrn}`,
          providerUrl: null,
          fileName: `LinkedIn conversation ${segmentIndex}`,
          fileType: LINKEDIN_CONVERSATION_FILE_TYPE,
          contentCategory: "document",
          content: `Legacy segment ${segmentIndex}`,
          sourcePath: "LinkedIn / Priya Nair",
          contentHash: `hash-${conversationUrn}-${segmentIndex}`,
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          connectorConfigId,
          rollupGroupId: `linkedin:${ACCOUNT_ID}:profile:${leadId}`,
        });
        if (options.archived) {
          await db.updateTable("indexed_files").set({ is_archived: 1 }).where("id", "=", file.id).execute();
        }
      }
    }

    function createWorker(
      options: {
        now?: () => number;
        requestSync?: (connectorConfigId: string) => Promise<LinkedinSyncRequestOutcome>;
      } = {},
    ): LinkedinReindexWorker {
      return new LinkedinReindexWorker({
        db,
        logger: createTestLogger(),
        listConnectors: async () => [{ id: connectorConfigId, scopeConfig }],
        resolveApiKey: async () => credentials.api_key,
        requestSync: options.requestSync,
        now: options.now,
      });
    }

    /** Lets a fire-and-forget sync request settle without asserting on wall-clock time. */
    async function flush(): Promise<void> {
      await new Promise((resolve) => setImmediate(resolve));
    }

    async function drainWorker(worker: LinkedinReindexWorker): Promise<void> {
      worker.start();
      await worker.kick();
      await worker.stop();
    }

    async function reindexRows() {
      return db
        .selectFrom("linkedin_reindex_conversations")
        .select(["conversation_urn", "phase", "attempts", "lead_id", "lead_name", "owner_name", "next_retry_at"])
        .orderBy("conversation_urn", "asc")
        .execute();
    }

    async function legacyFiles(conversationUrn: string) {
      return db
        .selectFrom("indexed_files")
        .select(["provider_file_id", "is_archived"])
        .where("connector_config_id", "=", connectorConfigId)
        .where("provider_file_id", "like", `linkedin:%:${conversationUrn}:segment-%`)
        .orderBy("provider_file_id", "asc")
        .execute();
    }

    async function engineFiles() {
      return db
        .selectFrom("indexed_files")
        .innerJoin("conversation_slices", "conversation_slices.id", "indexed_files.provider_file_id")
        .select(["indexed_files.id", "indexed_files.is_archived"])
        .where("indexed_files.connector_config_id", "=", connectorConfigId)
        .execute();
    }

    /**
     * The `sync.ts` item loop reduced to what the cutover depends on: persist,
     * link the slice, report back, then take the cursor — in that order, since
     * the archive pass runs after the last `onItemResult`.
     */
    async function runSync(): Promise<SyncedItem[]> {
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
        cursor: null,
        logger,
        ownerEmail: OWNER_EMAIL,
        linkedinChunkerGenerate: singleTopic,
        appConfig: { LINKEDIN_CHUNK_ENGINE_ENABLED: false } as never,
        getExistingItemState: (providerFileId) => {
          const state = existingHashes.get(
            syncIdentityKey(getSyncIdentity({ connectorConfigId, connectorType: CONNECTOR_TYPE, providerFileId })),
          );
          return state ? { sourceMeta: state.sourceMeta, threadId: state.threadId } : null;
        },
      })) {
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
      await connector.getCursor({ credentials, scopeConfig, currentCursor: null, logger });
      return items;
    }

    it("queues exactly the conversations holding live legacy files, and never the same one twice", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      await seedLegacyConversation("urn:conversation:2", "lead-2");
      await seedLegacyConversation("urn:conversation:3", "lead-3", { archived: true });

      const first = await enqueueLinkedinReindex(db, connectorConfigId);
      const second = await enqueueLinkedinReindex(db, connectorConfigId);

      expect(first).toEqual({ conversationsQueued: 2, conversationsSkipped: 0 });
      expect(second).toEqual({ conversationsQueued: 0, conversationsSkipped: 2 });
      const rows = await reindexRows();
      expect(rows.map((row) => row.conversation_urn)).toEqual(["urn:conversation:1", "urn:conversation:2"]);
      expect(rows.map((row) => row.lead_id)).toEqual(["lead-1", "lead-2"]);
    });

    it("refetches a queued conversation into the shared tables and marks it fetched", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      await enqueueLinkedinReindex(db, connectorConfigId);
      stubAimfox([base - 30 * HOUR_MS, base - 20 * HOUR_MS, base - 10 * HOUR_MS]);

      await drainWorker(createWorker());

      const rows = await reindexRows();
      expect(rows.map((row) => [row.phase, row.lead_name, row.owner_name])).toEqual([
        ["fetched", "Priya Nair", "Member User"],
      ]);
      const messages = await db
        .selectFrom("conversation_messages")
        .select(["source", "text"])
        .orderBy("id", "asc")
        .execute();
      expect(messages).toHaveLength(3);
      expect(messages.every((message) => message.source === "history")).toBe(true);
      expect((await legacyFiles("urn:conversation:1")).map((file) => file.is_archived)).toEqual([0, 0]);
    });

    it("re-cuts a fetched conversation in the next sync, archives its legacy files and closes its reindex row", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      await enqueueLinkedinReindex(db, connectorConfigId);
      stubAimfox([base - 30 * HOUR_MS, base - 20 * HOUR_MS, base - 10 * HOUR_MS]);
      await drainWorker(createWorker());

      await runSync();

      expect((await engineFiles()).filter((file) => file.is_archived === 0)).toHaveLength(1);
      expect((await legacyFiles("urn:conversation:1")).map((file) => file.is_archived)).toEqual([1, 1]);
      expect((await reindexRows()).map((row) => row.phase)).toEqual(["complete"]);
    });

    it("asks for one sync per drain that fetched something, and none for a drain that moved nothing", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      await enqueueLinkedinReindex(db, connectorConfigId);
      stubAimfox([base - 30 * HOUR_MS, base - 20 * HOUR_MS]);
      const syncs: string[] = [];
      const worker = createWorker({
        requestSync: async (id) => {
          syncs.push(id);
          return "started";
        },
      });

      worker.start();
      await worker.kick();
      await vi.waitFor(() => expect(syncs).toEqual([connectorConfigId]));

      await worker.kick();
      await flush();
      await worker.kick();
      await flush();
      await worker.stop();

      expect((await reindexRows()).map((row) => row.phase)).toEqual(["fetched"]);
      expect(syncs).toEqual([connectorConfigId]);
    });

    it("asks once at boot for rows a previous process fetched but never got synced", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      await enqueueLinkedinReindex(db, connectorConfigId);
      stubAimfox([base - 30 * HOUR_MS, base - 20 * HOUR_MS]);
      await drainWorker(createWorker());
      const syncs: string[] = [];
      const rebooted = createWorker({
        requestSync: async (id) => {
          syncs.push(id);
          return "started";
        },
      });

      rebooted.start();
      await rebooted.kick();
      await vi.waitFor(() => expect(syncs).toEqual([connectorConfigId]));

      await rebooted.kick();
      await flush();
      await rebooted.stop();

      expect(syncs).toEqual([connectorConfigId]);
    });

    it("stops without waiting for the sync it asked for", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      await enqueueLinkedinReindex(db, connectorConfigId);
      stubAimfox([base - 30 * HOUR_MS, base - 20 * HOUR_MS]);
      let releaseSync!: () => void;
      const syncRunning = new Promise<void>((resolve) => {
        releaseSync = resolve;
      });
      let requested = false;
      const worker = createWorker({
        requestSync: async () => {
          requested = true;
          await syncRunning;
          return "started";
        },
      });

      worker.start();
      await worker.kick();
      await vi.waitFor(() => expect(requested).toBe(true));
      await worker.stop();

      releaseSync();
      await flush();
    });

    it("retries a 403 rather than failing every conversation behind it", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      await enqueueLinkedinReindex(db, connectorConfigId);
      stubAimfox([], { conversationStatus: 403 });

      await drainWorker(createWorker({ now: () => base }));

      expect((await reindexRows()).map((row) => [row.phase, row.attempts])).toEqual([["pending", 1]]);
      expect((await legacyFiles("urn:conversation:1")).map((file) => file.is_archived)).toEqual([0, 0]);
    });

    it("re-arms only this connector's exhausted rows when the button is pressed again", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      await enqueueLinkedinReindex(db, connectorConfigId);
      const otherConfig = await createConnectorRepository(db).createConfig({
        connectorType: CONNECTOR_TYPE,
        authType: "api_key",
        credentials: JSON.stringify(credentials),
        scopeConfig: JSON.stringify(scopeConfig),
        createdBy: (await createUserRepository(db).findByEmail(OWNER_EMAIL))?.id ?? "",
      });
      await createLinkedinReindexRepository(db).enqueue([
        {
          runId: randomUUID(),
          connectorConfigId: otherConfig.id,
          accountId: ACCOUNT_ID,
          conversationUrn: "urn:conversation:9",
          leadId: "lead-9",
        },
      ]);
      await db.updateTable("linkedin_reindex_conversations").set({ phase: "exhausted", attempts: 5 }).execute();

      const result = await createWorker().queueReindex(connectorConfigId);

      expect(result).toEqual({ conversationsQueued: 0, conversationsSkipped: 1, conversationsRearmed: 1 });
      const rows = await db
        .selectFrom("linkedin_reindex_conversations")
        .select(["connector_config_id", "phase", "attempts"])
        .orderBy("conversation_urn", "asc")
        .execute();
      expect(rows.map((row) => [row.connector_config_id === connectorConfigId, row.phase, row.attempts])).toEqual([
        [true, "pending", 0],
        [false, "exhausted", 5],
      ]);
    });

    it("fails a conversation Aimfox no longer serves and leaves its legacy files on the timeline", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      await enqueueLinkedinReindex(db, connectorConfigId);
      stubAimfox([], { conversationStatus: 404 });

      await drainWorker(createWorker());

      expect((await reindexRows()).map((row) => row.phase)).toEqual(["failed"]);
      expect((await legacyFiles("urn:conversation:1")).map((file) => file.is_archived)).toEqual([0, 0]);
      expect(await db.selectFrom("conversation_messages").select("id").execute()).toHaveLength(0);
    });

    it("backs a transient failure off, exhausts it, then re-arms it on the next boot", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      await enqueueLinkedinReindex(db, connectorConfigId);
      let fetches = 0;
      stubAimfox([], { conversationStatus: 503, onConversationFetch: () => fetches++ });

      let clock = base;
      for (let attempt = 0; attempt < 5; attempt++) {
        await drainWorker(createWorker({ now: () => clock }));
        clock += 60 * 60_000;
      }

      const exhausted = await reindexRows();
      expect(exhausted.map((row) => [row.phase, row.attempts])).toEqual([["exhausted", 5]]);
      expect(exhausted[0].next_retry_at).toBeNull();
      expect(fetches).toBeGreaterThanOrEqual(5);

      const rearmed = await createLinkedinReindexRepository(db).rearmExhausted(new Date(clock).toISOString());

      expect(rearmed).toBe(1);
      expect((await reindexRows()).map((row) => [row.phase, row.attempts])).toEqual([["pending", 0]]);
    });

    it("does not wait for a retry that is not due yet", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      await enqueueLinkedinReindex(db, connectorConfigId);
      let fetches = 0;
      stubAimfox([], { conversationStatus: 503, onConversationFetch: () => fetches++ });

      await drainWorker(createWorker({ now: () => base }));
      const afterFirst = fetches;
      await drainWorker(createWorker({ now: () => base + 1_000 }));

      expect(fetches).toBe(afterFirst);
      expect((await reindexRows()).map((row) => row.attempts)).toEqual([1]);
    });

    it("queues every connector's backlog from the startup flag through the same entry point", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      const worker = new LinkedinReindexWorker({
        db,
        logger: createTestLogger(),
        appConfig: { LINKEDIN_CHUNK_REINDEX_HISTORY_ON_STARTUP: true, LINKEDIN_CHUNK_ENGINE_ENABLED: false },
        listConnectors: async () => [{ id: connectorConfigId, scopeConfig }],
        resolveApiKey: async () => credentials.api_key,
      });

      expect(await worker.reconcile()).toEqual({ rearmed: 0, queued: 1 });
      expect((await reindexRows()).map((row) => row.phase)).toEqual(["pending"]);
    });

    it("queues nothing at boot for a connector whose engine switch is off", async () => {
      await seedLegacyConversation("urn:conversation:1", "lead-1");
      const worker = new LinkedinReindexWorker({
        db,
        logger: createTestLogger(),
        appConfig: { LINKEDIN_CHUNK_REINDEX_HISTORY_ON_STARTUP: true, LINKEDIN_CHUNK_ENGINE_ENABLED: true },
        listConnectors: async () => [{ id: connectorConfigId, scopeConfig: { ...scopeConfig, chunkEngine: false } }],
        resolveApiKey: async () => credentials.api_key,
      });

      expect(await worker.reconcile()).toEqual({ rearmed: 0, queued: 0 });
      expect(await reindexRows()).toHaveLength(0);
    });
  });
}

runSuite("LinkedIn reindex (sqlite)", createTestDb);
runSuite("LinkedIn reindex (postgres)", createTestPgDb);
