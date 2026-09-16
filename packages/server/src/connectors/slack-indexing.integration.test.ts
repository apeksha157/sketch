import type { Kysely } from "kysely";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository, readSourceMeta } from "../db/repositories/connectors";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import type { SlackIndexingFacade } from "../slack/indexing-facade";
import { createTestDb, createTestPgDb } from "../test-utils";
import type { ChunkEngineKnobs } from "./chunk-engine";
import { runEnrichment } from "./enrichment";
import type { GeminiGenerator } from "./gemini-generate";
import { repairSlackChunkStreamsOnStartup } from "./slack-chunk-adapters";
import { runSlackChunkEngine } from "./slack-chunk-engine-runner";
import {
  type SlackEmissionRunSummary,
  archiveAllSlackChannelFiles,
  emitSlackSyncedItems,
  reconcileSlackChannelAcls,
  resetSlackChannelVisibilityCache,
} from "./slack-emission";
import { createSlackIndexingConnector } from "./slack-indexing";
import { ensureSlackConnectorConfig } from "./slack-provisioning";
import { runConnectorSync } from "./sync";
import { loadExistingContentHashes, processSyncedItem } from "./sync-item";
import { toEmailPrincipals } from "./types";

const logger = pino({ level: "silent" });

const pipelineKnobs: ChunkEngineKnobs = {
  windowMessages: 20,
  windowTokens: 7_500,
  minMessages: 1,
  targetMessages: 10,
  maxMessages: 80,
  maxTokens: 1_500,
  tickMinutes: 30,
  idleCloseHours: 96,
  provisionalRefreshMessages: 3,
  model: null,
  reasoningEffort: "high",
  burstThresholdMessages: null,
  topicRegistryCap: 30,
  groupWorkerPool: 2,
  maxWindowsPerRun: 8,
};

function fakeFacade(overrides: Partial<SlackIndexingFacade> = {}): SlackIndexingFacade {
  return {
    isConfigured: async () => true,
    listMemberChannels: async () => [{ id: "C1", name: "general" }],
    listChannelMembers: async () => ["U0TEAM"],
    getChannelInfo: async (channelId: string) => ({ id: channelId, name: "general" }),
    getUserInfo: async () => ({
      name: "priya",
      realName: "Priya",
      email: "priya@example.com",
      phone: null,
      isBot: false,
    }),
    iterateUsers: async function* () {},
    iterateChannels: async function* () {},
    iterateChannelMembers: async function* () {},
    listUsers: async () => [],
    listChannels: async () => [],
    ...overrides,
  };
}

async function insertEmittableSlackSlice(
  db: Kysely<DB>,
  input: {
    channelId: string;
    startedAt: string;
    messageCount?: number;
    status?: "open" | "closed";
    providerThreadId?: string | null;
    legacy?: boolean;
  },
) {
  const conversations = createConversationRepository(db);
  const conversation = await conversations.getOrCreate(
    { platform: "slack", kind: "channel", providerConversationId: input.channelId },
    input.channelId.toLowerCase(),
  );
  const messageCount = input.messageCount ?? 1;
  const messageIds: number[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    const timestamp = new Date(Date.parse(input.startedAt) + index * 1000).toISOString();
    const message = await conversations.insertMessage({
      conversationId: conversation.id,
      providerMessageId: `${input.channelId}-${input.startedAt}-${index}`,
      senderJid: "U0TEAM",
      senderName: "Roopak",
      text: `message ${input.channelId} ${index}`,
      providerThreadId: input.providerThreadId,
      isThreadReply: input.providerThreadId !== null && input.providerThreadId !== undefined,
      providerTimestamp: timestamp,
      receivedAt: timestamp,
    });
    messageIds.push(message.row.id);
  }
  const slice = await createConversationSlicesRepository(db).insertIfAbsent({
    conversationId: conversation.id,
    firstMessageId: messageIds[0] as number,
    lastMessageId: messageIds[messageIds.length - 1] as number,
    startedAt: input.startedAt,
    endedAt: new Date(Date.parse(input.startedAt) + (messageCount - 1) * 1000).toISOString(),
    messageCount,
    denoisedMessageIds: messageIds,
    flushReason: "gap",
    rosterSnapshot: "[]",
    salienceVerdict: "kept",
    providerThreadId: input.providerThreadId,
    status: input.status,
  });
  if (input.legacy) {
    await db
      .updateTable("conversation_slices")
      .set({ legacy_unjudged_at: "2026-09-01T00:00:00.000Z" })
      .where("id", "=", slice.row.id)
      .execute();
  }
  return slice.row;
}

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      await db
        .insertInto("users")
        .values({
          id: "user-admin",
          name: "Roopak",
          email: "roopak@example.com",
          auth_role: "admin",
          slack_user_id: "U0TEAM",
        })
        .execute();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("ensures exactly one slack connector config across repeated calls", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      await Promise.all([ensureSlackConnectorConfig({ db, logger }), ensureSlackConnectorConfig({ db, logger })]);

      const rows = await db
        .selectFrom("connector_configs")
        .select(["id", "auth_type", "sync_status", "created_by"])
        .where("connector_type", "=", "slack")
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.auth_type).toBe("system");
      expect(rows[0]?.sync_status).toBe("pending");
      expect(rows[0]?.created_by).toBe("user-admin");
    });

    it("skips provisioning until an admin user exists", async () => {
      await db.updateTable("users").set({ auth_role: "member" }).where("id", "=", "user-admin").execute();
      await ensureSlackConnectorConfig({ db, logger });
      const rows = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .execute();
      expect(rows).toHaveLength(0);

      await db.updateTable("users").set({ auth_role: "admin" }).where("id", "=", "user-admin").execute();
      await ensureSlackConnectorConfig({ db, logger });
      const after = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .execute();
      expect(after).toHaveLength(1);
    });

    it("the provisioned config is discoverable by the sync scheduler", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const configs = await createConnectorRepository(db).findSyncableConfigs({ staleAfterMs: 60_000 });
      expect(configs.some((config) => config.connector_type === "slack")).toBe(true);
    });

    it("chunks and emits kept slices without running the legacy salience judge", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await createConnectorRepository(db)
        .findSyncableConfigs({ staleAfterMs: 60_000 })
        .then((configs) => configs.find((config) => config.connector_type === "slack"));
      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "C1" },
        "general",
      );
      const recentMessageTime = Date.now() - 2 * 60_000;
      for (let index = 0; index < 2; index += 1) {
        await conversations.insertMessage({
          conversationId: conversation.id,
          providerMessageId: `engine-${index}`,
          senderJid: "U0TEAM",
          senderName: "Roopak",
          text: `Engine message ${index}`,
          providerThreadId: `engine-${index}`,
          providerTimestamp: new Date(recentMessageTime + index * 60_000).toISOString(),
          receivedAt: new Date(recentMessageTime + index * 60_000).toISOString(),
        });
      }
      let legacyJudgeCalls = 0;
      const connector = createSlackIndexingConnector();
      const items = [];
      for await (const item of connector.sync({
        db,
        connectorConfigId: config?.id,
        credentials: { type: "system" },
        scopeConfig: {},
        cursor: null,
        logger,
        slackIndexing: fakeFacade(),
        salienceGenerator: {
          generateJSON: async () => {
            legacyJudgeCalls += 1;
            throw new Error("legacy salience judge must not run");
          },
        } as never,
        appConfig: {
          SLACK_CHUNK_MODEL: "openai/test-boundary",
          SLACK_CHUNK_REASONING_EFFORT: "low",
          SLACK_CHUNK_MIN_MESSAGES: 2,
        },
        slackChunkerGenerate: async (_prompt, opts) => {
          expect(opts.model).toBe("openai/test-boundary");
          expect(opts.reasoningEffort).toBe("low");
          return JSON.stringify({ segments: [{ start: 1, end: 2, threads: ["engine"] }] });
        },
      })) {
        items.push(item);
      }

      const slices = await db
        .selectFrom("conversation_slices")
        .select(["status", "salience_verdict"])
        .where("conversation_id", "=", conversation.id)
        .execute();
      expect(legacyJudgeCalls).toBe(0);
      expect(slices).toEqual([{ status: "open", salience_verdict: "kept" }]);
      expect(items).toHaveLength(1);
    });

    it("dead-letters a slice without explicit membership", async () => {
      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });
      await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: 1,
        lastMessageId: 5,
        startedAt: "2026-07-17T00:00:00.000Z",
        endedAt: "2026-07-17T01:00:00.000Z",
        messageCount: 3,
        denoisedMessageIds: null,
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });

      const items = [];
      for await (const item of emitSlackSyncedItems({ db, logger, facade: fakeFacade() })) items.push(item);

      const slice = await db
        .selectFrom("conversation_slices")
        .select(["salience_verdict", "salience_signals", "salience_claim_token", "salience_claimed_at"])
        .where("conversation_id", "=", conversation.id)
        .executeTakeFirstOrThrow();
      expect(items).toHaveLength(0);
      expect(slice.salience_verdict).toBe("dropped");
      expect(slice.salience_signals).toContain("invalid_membership");
      expect(slice.salience_claim_token).toBeNull();
      expect(slice.salience_claimed_at).toBeNull();
    });

    it("rename refresh unlinks kept slices so they re-emit under the new channel name", async () => {
      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "C_RENAMED" },
        "old-name",
      );
      const slices = createConversationSlicesRepository(db);
      const inserted = await slices.insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: 1,
        lastMessageId: 2,
        startedAt: "2026-07-01T00:00:00.000Z",
        endedAt: "2026-07-01T01:00:00.000Z",
        messageCount: 2,
        denoisedMessageIds: [1, 2],
        flushReason: "gap",
        rosterSnapshot: "[]",
      });
      await db
        .insertInto("connector_configs")
        .values({
          id: "slack-config-rename",
          connector_type: "slack",
          auth_type: "system",
          credentials: "{}",
          created_by: "user-admin",
        })
        .execute();
      await db
        .insertInto("indexed_files")
        .values({
          id: "file-old-name",
          connector_config_id: "slack-config-rename",
          provider_file_id: "slack://slice/rename-test",
          file_name: "Slack: #old-name",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          content_hash: "hash-rename",
          is_archived: 0,
          synced_at: new Date().toISOString(),
        })
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ salience_verdict: "kept", indexed_file_id: "file-old-name" })
        .where("id", "=", inserted.row.id)
        .execute();

      const { refreshSlackChannelName } = await import("./slack-emission");
      const refreshed = await refreshSlackChannelName({
        db,
        logger,
        channelId: "C_RENAMED",
        channelName: "new-name",
      });
      expect(refreshed).toBe(true);

      const row = await db
        .selectFrom("conversations")
        .select("display_name")
        .where("id", "=", conversation.id)
        .executeTakeFirstOrThrow();
      expect(row.display_name).toBe("new-name");
      const slice = await db
        .selectFrom("conversation_slices")
        .select("indexed_file_id")
        .where("id", "=", inserted.row.id)
        .executeTakeFirstOrThrow();
      expect(slice.indexed_file_id).toBeNull();

      const unchanged = await refreshSlackChannelName({
        db,
        logger,
        channelId: "C_RENAMED",
        channelName: "new-name",
      });
      expect(unchanged).toBe(false);
    });

    it("startup repair requeues a linked orphaned open slice", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const orphan = await insertEmittableSlackSlice(db, {
        channelId: "C_REPAIR",
        startedAt: "2026-09-01T08:00:00.000Z",
        status: "open",
      });
      await insertEmittableSlackSlice(db, {
        channelId: "C_REPAIR",
        startedAt: "2026-09-01T09:00:00.000Z",
        status: "closed",
      });
      await db
        .insertInto("indexed_files")
        .values({
          id: "file-orphaned-open",
          connector_config_id: config.id,
          provider_file_id: orphan.id,
          file_name: "Slack orphan",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          synced_at: "2026-09-01T08:00:00.000Z",
        })
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: "file-orphaned-open" })
        .where("id", "=", orphan.id)
        .execute();

      await repairSlackChunkStreamsOnStartup(db, logger);
      const repaired = await db
        .selectFrom("conversation_slices")
        .select(["status", "indexed_file_id"])
        .where("id", "=", orphan.id)
        .executeTakeFirstOrThrow();

      expect(repaired).toEqual({ status: "closed", indexed_file_id: null });
    });

    it("migration 154 reclassifies mpdm-named channel conversations as mpim", async () => {
      const conversations = createConversationRepository(db);
      const mpim = await conversations.getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "G_LEGACY" },
        "mpdm-roopak--himanshu-1",
      );
      const channel = await conversations.getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "C_REAL" },
        "general",
      );
      await db
        .insertInto("channels")
        .values([
          { id: "ch-mpim", slack_channel_id: "G_LEGACY", name: "mpdm-roopak--himanshu-1", type: "group" },
          { id: "ch-real", slack_channel_id: "C_REAL", name: "general", type: "public_channel" },
        ])
        .execute();

      const migration = await import("../db/migrations/154-reclassify-mpim-conversations");
      await migration.up(db as unknown as Kysely<unknown>);

      const kinds = await db
        .selectFrom("conversations")
        .select(["id", "kind"])
        .where("id", "in", [mpim.id, channel.id])
        .execute();
      expect(kinds.find((row) => row.id === mpim.id)?.kind).toBe("mpim");
      expect(kinds.find((row) => row.id === channel.id)?.kind).toBe("channel");

      const channelRows = await db.selectFrom("channels").select(["id", "type"]).orderBy("id").execute();
      expect(channelRows).toEqual([
        { id: "ch-mpim", type: "mpim" },
        { id: "ch-real", type: "public_channel" },
      ]);
    });

    it("migration 155 requeues kept linked slices for re-emission and leaves the rest alone", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "C1" },
        "general",
      );
      const fileValues = ["file-kept", "file-dropped"].map((id) => ({
        id,
        connector_config_id: config.id,
        provider_file_id: id,
        file_name: id,
        file_type: "slack_conversation_slice",
        content_category: "document",
        source: "slack",
        synced_at: "2026-06-01T00:00:00.000Z",
      }));
      await db.insertInto("indexed_files").values(fileValues).execute();

      const slices = createConversationSlicesRepository(db);
      const seedSlice = async (n: number, verdict: "kept" | "dropped", fileId: string | null) => {
        const message = await conversations.insertMessage({
          conversationId: conversation.id,
          providerMessageId: `100.${n}`,
          senderJid: "U0TEAM",
          senderName: "Roopak",
          text: `message ${n}`,
          providerTimestamp: "2026-06-01T00:00:00.000Z",
          receivedAt: "2026-06-01T00:00:00.000Z",
        });
        const slice = await slices.insertIfAbsent({
          conversationId: conversation.id,
          firstMessageId: message.row.id,
          lastMessageId: message.row.id,
          startedAt: "2026-06-01T00:00:00.000Z",
          endedAt: "2026-06-01T00:00:00.000Z",
          messageCount: 1,
          denoisedMessageIds: [message.row.id],
          flushReason: "gap",
          rosterSnapshot: "[]",
          salienceVerdict: verdict,
        });
        if (fileId) {
          await db
            .updateTable("conversation_slices")
            .set({ indexed_file_id: fileId })
            .where("id", "=", slice.row.id)
            .execute();
        }
        return slice.row.id;
      };
      const keptLinked = await seedSlice(1, "kept", "file-kept");
      const droppedLinked = await seedSlice(2, "dropped", "file-dropped");
      const keptUnlinked = await seedSlice(3, "kept", null);

      const seedWhatsAppSlice = async (jid: string, suffix: string, indexEnabled: 0 | 1) => {
        await db
          .insertInto("whatsapp_groups")
          .values({ jid, name: `Group ${suffix}`, index_enabled: indexEnabled, updated_at: "2026-06-01T00:00:00.000Z" })
          .execute();
        const wa = await db
          .insertInto("conversations")
          .values({
            platform: "whatsapp",
            kind: "group",
            provider_conversation_id: jid,
            display_name: `Group ${suffix}`,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await db
          .insertInto("indexed_files")
          .values({
            id: `file-wa-${suffix}`,
            connector_config_id: config.id,
            provider_file_id: `slice-wa-${suffix}`,
            file_name: `WhatsApp: Group ${suffix}`,
            file_type: "whatsapp_conversation_slice",
            content_category: "document",
            source: "whatsapp",
            synced_at: "2026-06-01T00:00:00.000Z",
          })
          .execute();
        await db
          .insertInto("conversation_slices")
          .values({
            id: `slice-wa-${suffix}`,
            conversation_id: wa.id,
            first_message_id: 1,
            last_message_id: 1,
            started_at: "2026-06-01T00:00:00.000Z",
            ended_at: "2026-06-01T00:00:00.000Z",
            message_count: 1,
            flush_reason: "gap",
            roster_snapshot: "[]",
            salience_verdict: "kept",
            indexed_file_id: `file-wa-${suffix}`,
          })
          .execute();
        return `slice-wa-${suffix}`;
      };
      const waEnabled = await seedWhatsAppSlice("on@g.us", "on", 1);
      const waDisabled = await seedWhatsAppSlice("off@g.us", "off", 0);

      const migration = await import("../db/migrations/155-requeue-kept-slice-reemission");
      await migration.up(db as unknown as Kysely<unknown>);

      const rows = await db.selectFrom("conversation_slices").select(["id", "indexed_file_id"]).execute();
      const byId = new Map(rows.map((row) => [row.id, row.indexed_file_id]));
      expect(byId.get(keptLinked)).toBeNull();
      expect(byId.get(droppedLinked)).toBe("file-dropped");
      expect(byId.get(keptUnlinked)).toBeNull();
      expect(byId.get(waEnabled)).toBeNull();
      expect(byId.get(waDisabled)).toBe("file-wa-off");
    });

    it("reactivates a disabled singleton so indexing survives owner removal", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const created = await db
        .selectFrom("connector_configs")
        .select(["id"])
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      await createConnectorRepository(db).archiveConnectorsForOwner("user-admin");

      await ensureSlackConnectorConfig({ db, logger });

      const row = await db
        .selectFrom("connector_configs")
        .select(["id", "sync_status", "created_by", "error_message"])
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      expect(row.id).toBe(created.id);
      expect(row.sync_status).toBe("pending");
      expect(row.created_by).toBe("user-admin");
      expect(row.error_message).toBeNull();
    });

    it("resolves the identity ladder: teammate, then CRM entity by email, then display name", async () => {
      await db
        .insertInto("entities")
        .values({
          id: "entity-1",
          name: "Asha Mehta",
          source_type: "crm",
          status: "active",
          hotness: 0,
          created_at: "2026-07-01T00:00:00.000Z",
          updated_at: "2026-07-01T00:00:00.000Z",
        })
        .execute();
      await db
        .insertInto("entity_contact_points")
        .values({
          id: "cp-1",
          entity_id: "entity-1",
          kind: "email",
          value: "asha@client.com",
          source: "crm",
        })
        .execute();

      const facade = fakeFacade({
        listChannelMembers: async () => ["U0TEAM", "U0CRM", "U0EXT"],
        getUserInfo: async (userId: string) =>
          userId === "U0CRM"
            ? { name: "asha", realName: "Asha M", email: "Asha@Client.com", phone: null, isBot: false }
            : { name: "guest", realName: "Guest Person", email: null, phone: null, isBot: false },
      });

      const { resolveSlackChannelRoster } = await import("../slack/identity-resolution");
      const roster = await resolveSlackChannelRoster({
        db,
        facade,
        channelId: "C1",
        channelName: "general",
        logger,
      });

      expect(roster.participants).toEqual([
        { slackUserId: "U0TEAM", displayName: "Roopak", kind: "teammate", email: "roopak@example.com" },
        { slackUserId: "U0CRM", displayName: "Asha Mehta", kind: "entity", email: "Asha@Client.com" },
        { slackUserId: "U0EXT", displayName: "Guest Person", kind: "external", email: null },
      ]);
    });

    it("excludes bot members from the roster, including a bot with a stray users row", async () => {
      await db
        .insertInto("users")
        .values({
          id: "user-bot",
          name: "sketchdev",
          auth_role: "member",
          slack_user_id: "U0BOT",
        })
        .execute();

      const facade = fakeFacade({
        listChannelMembers: async () => ["U0TEAM", "U0BOT", "U0EXTBOT"],
        getUserInfo: async (userId: string) =>
          userId === "U0TEAM"
            ? { name: "roopak", realName: "Roopak", email: "roopak@example.com", phone: null, isBot: false }
            : { name: "botsy", realName: "Botsy", email: null, phone: null, isBot: true },
      });

      const { resolveSlackChannelRoster } = await import("../slack/identity-resolution");
      const roster = await resolveSlackChannelRoster({
        db,
        facade,
        channelId: "C1",
        channelName: "general",
        logger,
      });

      expect(roster.participants).toEqual([
        { slackUserId: "U0TEAM", displayName: "Roopak", kind: "teammate", email: "roopak@example.com" },
      ]);
    });

    it("renders the thread root header and resolves mention tokens in emitted content", async () => {
      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });
      const rootTs = "1700.1";
      await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: rootTs,
        senderJid: "U0EXT",
        senderName: "Guest",
        text: "Kicking off the pricing thread",
        providerThreadId: rootTs,
        isThreadReply: false,
        providerTimestamp: "2026-07-17T09:00:00.000Z",
        receivedAt: "2026-07-17T09:00:00.000Z",
      });
      const reply = await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1700.2",
        senderJid: "U0TEAM",
        senderName: "Roopak",
        text: "Agreed <@U0TEAM>, let's finalize by Friday",
        providerThreadId: rootTs,
        providerParentMessageId: rootTs,
        isThreadReply: true,
        providerTimestamp: "2026-07-17T09:05:00.000Z",
        receivedAt: "2026-07-17T09:05:00.000Z",
      });

      await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: reply.row.id,
        lastMessageId: reply.row.id,
        startedAt: "2026-07-17T09:05:00.000Z",
        endedAt: "2026-07-17T09:05:00.000Z",
        messageCount: 1,
        denoisedMessageIds: [reply.row.id],
        flushReason: "gap",
        rosterSnapshot: "[]",
        providerThreadId: rootTs,
        salienceVerdict: "kept",
      });

      const items = [];
      for await (const item of emitSlackSyncedItems({ db, logger, facade: fakeFacade() })) items.push(item);
      expect(items).toHaveLength(1);
      expect(items[0]?.content).toContain("Thread root by Guest: Kicking off the pricing thread");
      expect(items[0]?.content).toContain("@Roopak, let's finalize by Friday");
      expect(items[0]?.content).not.toContain("<@U0TEAM>");
    });

    it("emitted content is transcript-only: channel header without the participant roster", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "C1" },
        "general",
      );
      const message = await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1900.1",
        senderJid: "U0TEAM",
        senderName: "Roopak",
        text: "see attached files.",
        attachments: [
          {
            originalName: "pricing-plan.pdf",
            mimeType: "application/pdf",
            localPath: "/tmp/pricing-plan.pdf",
            sizeBytes: 1,
          },
        ],
        providerTimestamp: "2026-07-17T11:00:00.000Z",
        receivedAt: "2026-07-17T11:00:00.000Z",
      });
      const plainMessage = await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1900.2",
        senderJid: "U0TEAM",
        senderName: "Roopak",
        text: "Decision: we ship the pricing change on Monday",
        providerTimestamp: "2026-07-17T11:01:00.000Z",
        receivedAt: "2026-07-17T11:01:00.000Z",
      });
      await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: message.row.id,
        lastMessageId: plainMessage.row.id,
        startedAt: "2026-07-17T11:00:00.000Z",
        endedAt: "2026-07-17T11:01:00.000Z",
        messageCount: 2,
        denoisedMessageIds: [message.row.id, plainMessage.row.id],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });

      const items = [];
      for await (const item of emitSlackSyncedItems({ db, logger, facade: fakeFacade() })) {
        items.push(item);
      }

      expect(items).toHaveLength(1);
      expect(items[0]?.content).toContain("Channel: #general");
      expect(items[0]?.content).toContain("Roopak: [shared file: pricing-plan.pdf]");
      expect(items[0]?.content).toContain("Roopak: Decision: we ship the pricing change on Monday");
      expect(items[0]?.content).not.toContain("see attached files.");
      expect(items[0]?.content).not.toContain("Participants:");
      expect(items[0]?.content).not.toContain("(teammate)");
    });

    it("emits teammate emails as capture-time audit stamps", async () => {
      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "C1" },
        "general",
      );
      const message = await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1900.2",
        senderJid: "U0TEAM",
        senderName: "Roopak",
        text: "Decision: keep the channel history",
        providerTimestamp: "2026-07-17T11:00:00.000Z",
        receivedAt: "2026-07-17T11:00:00.000Z",
      });
      await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: message.row.id,
        lastMessageId: message.row.id,
        startedAt: "2026-07-17T11:00:00.000Z",
        endedAt: "2026-07-17T11:00:00.000Z",
        messageCount: 1,
        denoisedMessageIds: [message.row.id],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });

      const items = [];
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade: fakeFacade(),
      })) {
        items.push(item);
      }

      expect(items).toHaveLength(1);
      expect(items[0]?.accessPrincipals).toEqual([{ type: "email", value: "roopak@example.com" }]);
      expect(items[0]?.accessScope?.members).toEqual([
        { type: "slack_user", value: "U0TEAM" },
        { type: "email", value: "roopak@example.com" },
      ]);

      const disabledItems = [];
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade: fakeFacade(),
        slackEntitySyncEnabled: false,
      })) {
        disabledItems.push(item);
      }
      expect(disabledItems).toHaveLength(1);
      expect(disabledItems[0]?.accessPrincipals).toBeUndefined();
    });

    it("emission with only an external Slack member stamps a dormant principal", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();

      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });
      const message = await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1800.1",
        senderJid: "U0EXT",
        senderName: "Guest",
        text: "external-only chatter",
        providerTimestamp: "2026-07-17T10:00:00.000Z",
        receivedAt: "2026-07-17T10:00:00.000Z",
      });
      const slice = await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: message.row.id,
        lastMessageId: message.row.id,
        startedAt: "2026-07-17T10:00:00.000Z",
        endedAt: "2026-07-17T10:00:00.000Z",
        messageCount: 1,
        denoisedMessageIds: [message.row.id],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });
      await db
        .insertInto("indexed_files")
        .values({
          id: "file-no-teammate",
          connector_config_id: config.id,
          provider_file_id: slice.row.id,
          file_name: "Slack: #general",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          synced_at: "2026-07-17T10:05:00.000Z",
        })
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: "file-no-teammate" })
        .where("id", "=", slice.row.id)
        .execute();

      const facade = fakeFacade({ listChannelMembers: async () => ["U0EXT"] });
      let skipped = 0;
      const items = [];
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade,
        now: new Date("2026-07-18T10:00:00.000Z"),
        onSkippedNoScope: () => {
          skipped += 1;
        },
      })) {
        items.push(item);
      }

      expect(items).toHaveLength(1);
      expect(skipped).toBe(0);
      expect(items[0]?.accessPrincipals).toEqual([]);
      expect(items[0]?.accessScope?.members).toEqual([{ type: "slack_user", value: "U0EXT" }]);
      const file = await db
        .selectFrom("indexed_files")
        .select(["is_archived"])
        .where("id", "=", "file-no-teammate")
        .executeTakeFirstOrThrow();
      expect(file.is_archived).toBe(0);
      const unlinked = await db
        .selectFrom("conversation_slices")
        .select("indexed_file_id")
        .where("id", "=", slice.row.id)
        .executeTakeFirstOrThrow();
      expect(unlinked.indexed_file_id).toBe("file-no-teammate");
    });

    it("emission with only an external Slack member preserves a queued slice", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "C1" },
        "general",
      );
      const message = await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1800.9",
        senderJid: "U0EXT",
        senderName: "Guest",
        text: "external-only chatter",
        providerTimestamp: "2026-07-17T10:00:00.000Z",
        receivedAt: "2026-07-17T10:00:00.000Z",
      });
      const slice = await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: message.row.id,
        lastMessageId: message.row.id,
        startedAt: "2026-07-17T10:00:00.000Z",
        endedAt: "2026-07-17T10:00:00.000Z",
        messageCount: 1,
        denoisedMessageIds: [message.row.id],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });
      await db
        .insertInto("indexed_files")
        .values({
          id: "file-requeued",
          connector_config_id: config.id,
          provider_file_id: slice.row.id,
          file_name: "Slack: #general",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          synced_at: "2026-07-17T10:05:00.000Z",
        })
        .execute();

      const facade = fakeFacade({ listChannelMembers: async () => ["U0EXT"] });
      let skipped = 0;
      const items = [];
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade,
        onSkippedNoScope: () => {
          skipped += 1;
        },
      })) {
        items.push(item);
      }

      expect(items).toHaveLength(1);
      expect(skipped).toBe(0);
      expect(items[0]?.accessPrincipals).toEqual([]);
      expect(items[0]?.accessScope?.members).toEqual([{ type: "slack_user", value: "U0EXT" }]);
      const file = await db
        .selectFrom("indexed_files")
        .select(["is_archived", "access_scope_id"])
        .where("id", "=", "file-requeued")
        .executeTakeFirstOrThrow();
      expect(file.is_archived).toBe(0);
      expect(file.access_scope_id).toBeNull();
    });

    it("Slack emissions retain capture-time teammate email stamps across re-emissions", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("users")
        .values({
          id: "user-new",
          name: "New Teammate",
          email: "new@example.com",
          auth_role: "member",
          slack_user_id: "U1TEAM",
        })
        .execute();

      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });
      const message = await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1800.3",
        senderJid: "U0TEAM",
        senderName: "Roopak",
        text: "Decision: keep the channel history",
        providerTimestamp: "2026-07-17T10:00:00.000Z",
        receivedAt: "2026-07-17T10:00:00.000Z",
      });
      const slice = await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: message.row.id,
        lastMessageId: message.row.id,
        startedAt: "2026-07-17T10:00:00.000Z",
        endedAt: "2026-07-17T10:00:00.000Z",
        messageCount: 1,
        denoisedMessageIds: [message.row.id],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });
      const facade = fakeFacade({
        listChannelMembers: async () => ["U0TEAM"],
        getUserInfo: async (slackUserId: string) =>
          slackUserId === "U0TEAM"
            ? { name: "roopak", realName: "Roopak", email: "roopak@example.com", phone: null, isBot: false }
            : { name: "new", realName: "New Teammate", email: "new@example.com", phone: null, isBot: false },
      });
      const firstItems = [];
      for await (const item of emitSlackSyncedItems({ db, logger, facade })) {
        firstItems.push(item);
      }
      expect(firstItems).toHaveLength(1);
      const firstItem = firstItems[0];
      if (!firstItem) throw new Error("Expected a Slack item for the first emission");
      const repo = createConnectorRepository(db);
      await processSyncedItem({
        db,
        repo,
        connectorConfigId: config.id,
        connectorType: "slack",
        item: firstItem,
        existingHashes: await loadExistingContentHashes(db, "slack", config.id),
      });

      facade.listChannelMembers = async () => ["U1TEAM"];
      const secondItems = [];
      for await (const item of emitSlackSyncedItems({ db, logger, facade })) {
        secondItems.push(item);
      }
      expect(secondItems).toHaveLength(1);
      const secondItem = secondItems[0];
      if (!secondItem) throw new Error("Expected a Slack item for the second emission");
      expect(secondItem.accessPrincipals).toEqual(toEmailPrincipals(["new@example.com"]));
      await processSyncedItem({
        db,
        repo,
        connectorConfigId: config.id,
        connectorType: "slack",
        item: secondItem,
        existingHashes: await loadExistingContentHashes(db, "slack", config.id),
      });

      const indexedFile = await db
        .selectFrom("indexed_files")
        .select("id")
        .where("source", "=", "slack")
        .where("provider_file_id", "=", slice.row.id)
        .executeTakeFirstOrThrow();
      const grants = await db
        .selectFrom("file_access")
        .select("principal_value")
        .where("indexed_file_id", "=", indexedFile.id)
        .orderBy("principal_value", "asc")
        .execute();
      expect(grants.map((row) => row.principal_value)).toEqual(["new@example.com", "roopak@example.com"]);

      const laterMessage = await conversations.insertMessage({
        conversationId: conversation.id,
        providerMessageId: "1800.4",
        senderJid: "U1TEAM",
        senderName: "New Teammate",
        text: "Decision: the new joiner can read the existing channel history",
        providerTimestamp: "2026-07-18T10:00:00.000Z",
        receivedAt: "2026-07-18T10:00:00.000Z",
      });
      const laterSlice = await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: laterMessage.row.id,
        lastMessageId: laterMessage.row.id,
        startedAt: "2026-07-18T10:00:00.000Z",
        endedAt: "2026-07-18T10:00:00.000Z",
        messageCount: 1,
        denoisedMessageIds: [laterMessage.row.id],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });
      const laterItems = [];
      for await (const item of emitSlackSyncedItems({ db, logger, facade })) {
        laterItems.push(item);
      }
      const laterItem = laterItems.find((item) => item.providerFileId === String(laterSlice.row.id));
      if (!laterItem) throw new Error("Expected a Slack item for the later slice");
      expect(laterItem.accessPrincipals).toEqual(toEmailPrincipals(["new@example.com"]));
      await processSyncedItem({
        db,
        repo,
        connectorConfigId: config.id,
        connectorType: "slack",
        item: laterItem,
        existingHashes: await loadExistingContentHashes(db, "slack", config.id),
      });

      const laterIndexedFile = await db
        .selectFrom("indexed_files")
        .select(["id", "access_scope_id"])
        .where("source", "=", "slack")
        .where("provider_file_id", "=", laterSlice.row.id)
        .executeTakeFirstOrThrow();
      if (!laterIndexedFile.access_scope_id) throw new Error("Expected the later Slack item to have an access scope");
      const laterGrants = await db
        .selectFrom("file_access")
        .select("principal_value")
        .where("indexed_file_id", "=", laterIndexedFile.id)
        .execute();
      expect(laterGrants.map((row) => row.principal_value)).toEqual(["new@example.com"]);
      const currentScopeMembers = await db
        .selectFrom("access_scope_members")
        .select("principal_value")
        .where("access_scope_id", "=", laterIndexedFile.access_scope_id)
        .execute();
      expect(currentScopeMembers.map((row) => row.principal_value).sort()).toEqual(["U1TEAM", "new@example.com"]);

      await db.deleteFrom("users").where("id", "=", "user-admin").execute();
      const grantsAfterAccountOffboarding = await db
        .selectFrom("file_access")
        .select("principal_value")
        .where("indexed_file_id", "=", indexedFile.id)
        .execute();
      expect(grantsAfterAccountOffboarding.map((row) => row.principal_value)).toContain("roopak@example.com");
      await db
        .insertInto("users")
        .values({
          id: "user-reused-email",
          name: "Reused Account",
          email: "roopak@example.com",
          auth_role: "member",
          slack_user_id: "U2TEAM",
        })
        .execute();
      expect(grantsAfterAccountOffboarding.map((row) => row.principal_value)).toContain("roopak@example.com");
    });

    it("reconciles ACLs: refreshes visible-channel membership, archives invisible channels", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const repo = createConnectorRepository(db);

      const visibleScope = await repo.upsertAccessScope(config.id, {
        scopeType: "slack_channel",
        providerScopeId: "C1",
        label: "#general",
        members: ["roopak@example.com", "departed@example.com"],
      });
      const goneScope = await repo.upsertAccessScope(config.id, {
        scopeType: "slack_channel",
        providerScopeId: "C-GONE",
        label: "#gone",
        members: ["roopak@example.com"],
      });

      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C-GONE",
      });
      const slice = await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: 1,
        lastMessageId: 2,
        startedAt: "2026-07-01T00:00:00.000Z",
        endedAt: "2026-07-01T01:00:00.000Z",
        messageCount: 2,
        denoisedMessageIds: [1, 2],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });
      await db
        .insertInto("indexed_files")
        .values({
          id: "file-gone",
          connector_config_id: config.id,
          provider_file_id: slice.row.id,
          file_name: "Slack: #gone",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          access_scope_id: goneScope,
          synced_at: "2026-07-01T02:00:00.000Z",
        })
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: "file-gone" })
        .where("id", "=", slice.row.id)
        .execute();

      resetSlackChannelVisibilityCache();
      const summary = await reconcileSlackChannelAcls({
        db,
        logger,
        facade: fakeFacade(),
        connectorConfigId: config.id,
        slackEntitySyncEnabled: false,
      });
      expect(summary.scopesRefreshed).toBe(1);
      expect(summary.scopesArchived).toBe(1);
      expect(summary.filesArchived).toBe(1);

      const members = await db
        .selectFrom("access_scope_members")
        .select("principal_value")
        .where("access_scope_id", "=", visibleScope)
        .execute();
      expect(members.map((row) => row.principal_value).sort()).toEqual(["U0TEAM", "roopak@example.com"]);

      const goneFile = await db
        .selectFrom("indexed_files")
        .select(["is_archived", "access_scope_id"])
        .where("id", "=", "file-gone")
        .executeTakeFirstOrThrow();
      expect(goneFile.is_archived).toBe(1);
      expect(goneFile.access_scope_id).toBeNull();

      const goneSlice = await db
        .selectFrom("conversation_slices")
        .select("indexed_file_id")
        .where("id", "=", slice.row.id)
        .executeTakeFirstOrThrow();
      expect(goneSlice.indexed_file_id).toBeNull();
    });

    it("reuses the channel visibility walk within the TTL and refetches after it", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      await createConnectorRepository(db).upsertAccessScope(config.id, {
        scopeType: "slack_channel",
        providerScopeId: "C1",
        label: "#general",
        members: ["roopak@example.com"],
      });
      const listMemberChannels = vi.fn(async () => [{ id: "C1", name: "general" }]);
      const facade = fakeFacade({ listMemberChannels });
      resetSlackChannelVisibilityCache();

      const run = (nowMs: number) =>
        reconcileSlackChannelAcls({
          db,
          logger,
          facade,
          connectorConfigId: config.id,
          slackEntitySyncEnabled: false,
          nowMs,
        });

      await run(0);
      await run(60_000);
      expect(listMemberChannels).toHaveBeenCalledTimes(1);

      await run(31 * 60_000);
      expect(listMemberChannels).toHaveBeenCalledTimes(2);

      resetSlackChannelVisibilityCache();
      await run(31 * 60_000);
      expect(listMemberChannels).toHaveBeenCalledTimes(3);
    });
    it("keeps differential Slack facts unique and live across tier one, tier one, tier two growth", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const conversation = await createConversationRepository(db).getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "C_PIPELINE" },
        "pipeline",
      );
      const messages = createConversationRepository(db);
      const addMessage = async (index: number) =>
        messages.insertMessage({
          conversationId: conversation.id,
          providerMessageId: `pipeline-${index}`,
          senderJid: "U0TEAM",
          senderName: "Roopak",
          text: `Project Atlas launch decision remains approved, growth update ${index}.`,
          providerTimestamp: new Date(Date.parse("2026-09-05T09:00:00.000Z") + index * 60_000).toISOString(),
          receivedAt: new Date(Date.parse("2026-09-05T09:00:00.000Z") + index * 60_000).toISOString(),
        });
      const generateBoundary = async (prompt: string) => {
        const count = [...prompt.matchAll(/^\d+\. /gmu)].length;
        return JSON.stringify({ segments: [{ start: 1, end: count, threads: ["Project Atlas"] }] });
      };
      const project = await createEntityRepository(db).upsertEntityFromTool({
        name: "Project Atlas",
        sourceType: "project",
        source: "manual",
        sourceId: "manual:project-atlas-slack-pipeline",
      });
      let factCalls = 0;
      const enrichmentGenerator = {
        generate: async () => "Project Atlas launch remains approved.",
        generateJSON: async <T>(_prompt: string, options?: { label?: string }) => {
          if (options?.label?.startsWith("extractEntities")) {
            return {
              mentions: [{ mention: "Project Atlas", type: "project", variations: [], matchesKnown: "Project Atlas" }],
              relations: [],
            } as T;
          }
          if (options?.label?.startsWith("extractEntityFacts")) {
            factCalls += 1;
            return (
              factCalls === 1
                ? { facts: { [project.id]: [{ fact: "Launch decision is approved" }] }, retractions: [] }
                : { facts: {}, retractions: [] }
            ) as T;
          }
          return {} as T;
        },
      } as GeminiGenerator;
      const persistEmission = async (now: Date) => {
        const emitted = [];
        for await (const item of emitSlackSyncedItems({
          db,
          logger,
          facade: fakeFacade(),
          minMessages: 1,
          provisionalRefreshMessages: 3,
          provisionalRefreshMaxMinutes: 10_000,
          now,
        })) {
          emitted.push(item);
          const result = await processSyncedItem({
            db,
            repo: createConnectorRepository(db),
            connectorConfigId: config.id,
            connectorType: "slack",
            item,
            existingHashes: await loadExistingContentHashes(db, "slack", config.id),
          });
          if (result.kind === "skipped_empty") throw new Error("Expected persisted Slack emission");
          await db
            .updateTable("conversation_slices")
            .set({ indexed_file_id: result.indexedFileId })
            .where("id", "=", item.providerFileId)
            .execute();
          await runEnrichment({
            db,
            logger,
            embeddingProvider: null,
            generator: enrichmentGenerator,
            fileIds: [result.indexedFileId],
          });
        }
        return emitted;
      };

      await addMessage(0);
      await runSlackChunkEngine({
        db,
        logger,
        generate: generateBoundary,
        channelKnobs: pipelineKnobs,
        threadKnobs: pipelineKnobs,
        discoveryPageRows: 100,
        discoveryMaxPages: 10,
        now: new Date("2026-09-05T09:30:00.000Z"),
      });
      await persistEmission(new Date("2026-09-05T09:30:00.000Z"));

      const tiers = [];
      for (let tick = 1; tick <= 3; tick += 1) {
        await addMessage(tick);
        const now = new Date(Date.parse("2026-09-05T09:30:00.000Z") + tick * 31 * 60_000);
        await runSlackChunkEngine({
          db,
          logger,
          generate: generateBoundary,
          channelKnobs: pipelineKnobs,
          threadKnobs: pipelineKnobs,
          discoveryPageRows: 100,
          discoveryMaxPages: 10,
          now,
        });
        const emitted = await persistEmission(now);
        expect(emitted).toHaveLength(1);
        tiers.push(emitted[0]?.enrichmentRefresh);
      }

      const slice = await db
        .selectFrom("conversation_slices")
        .select("indexed_file_id")
        .where("conversation_id", "=", conversation.id)
        .where("status", "=", "open")
        .executeTakeFirstOrThrow();
      const facts = await db
        .selectFrom("indexed_file_facts")
        .select(["fact_key", "deleted_at"])
        .where("indexed_file_id", "=", slice.indexed_file_id)
        .execute();
      expect(tiers).toEqual(["embeddings_only", "embeddings_only", "full"]);
      expect(facts).toHaveLength(1);
      expect(new Set(facts.map((fact) => fact.fact_key)).size).toBe(1);
      expect(facts.filter((fact) => fact.deleted_at !== null)).toHaveLength(0);
      expect(factCalls).toBe(2);
    });

    it("re-emits a ten-day-old linked open slice at tier two after a boundary cut trims it", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const conversation = await createConversationRepository(db).getOrCreate(
        { platform: "slack", kind: "channel", providerConversationId: "C_BOUNDARY_CUT" },
        "boundary-cut",
      );
      const messages = createConversationRepository(db);
      const ids: number[] = [];
      for (let index = 1; index <= 3; index += 1) {
        const inserted = await messages.insertMessage({
          conversationId: conversation.id,
          providerMessageId: `old-${index}`,
          senderJid: "U0TEAM",
          senderName: "Roopak",
          text: `old boundary message ${index}`,
          providerTimestamp: `2026-08-2${index}T09:00:00.000Z`,
          receivedAt: `2026-08-2${index}T09:00:00.000Z`,
        });
        ids.push(inserted.row.id);
      }
      const oneSegment = async () => JSON.stringify({ segments: [{ start: 1, end: 3, threads: ["old"] }] });
      await runSlackChunkEngine({
        db,
        logger,
        generate: oneSegment,
        channelKnobs: pipelineKnobs,
        threadKnobs: pipelineKnobs,
        discoveryPageRows: 100,
        discoveryMaxPages: 10,
        now: new Date("2026-08-26T09:00:00.000Z"),
      });
      const initial = [];
      for await (const item of emitSlackSyncedItems({ db, logger, facade: fakeFacade(), minMessages: 1 }))
        initial.push(item);
      const firstItem = initial[0];
      if (!firstItem) throw new Error("Expected initial open slice emission");
      const persisted = await processSyncedItem({
        db,
        repo: createConnectorRepository(db),
        connectorConfigId: config.id,
        connectorType: "slack",
        item: firstItem,
        existingHashes: new Map(),
      });
      if (persisted.kind === "skipped_empty") throw new Error("Expected persisted Slack boundary slice");
      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: persisted.indexedFileId })
        .where("id", "=", firstItem.providerFileId)
        .execute();

      for (let index = 4; index <= 5; index += 1) {
        const inserted = await messages.insertMessage({
          conversationId: conversation.id,
          providerMessageId: `new-${index}`,
          senderJid: "U0TEAM",
          senderName: "Roopak",
          text: `new boundary message ${index}`,
          providerTimestamp: `2026-09-05T0${index}:00:00.000Z`,
          receivedAt: `2026-09-05T0${index}:00:00.000Z`,
        });
        ids.push(inserted.row.id);
      }
      const cutBoundary = async () =>
        JSON.stringify({
          segments: [
            { start: 1, end: 2, threads: ["old"] },
            { start: 3, end: 5, threads: ["new"] },
          ],
        });
      await runSlackChunkEngine({
        db,
        logger,
        generate: cutBoundary,
        channelKnobs: pipelineKnobs,
        threadKnobs: pipelineKnobs,
        discoveryPageRows: 100,
        discoveryMaxPages: 10,
        now: new Date("2026-09-05T10:00:00.000Z"),
      });
      const trimmed = await db
        .selectFrom("conversation_slices")
        .select(["id", "indexed_file_id", "message_count"])
        .where("id", "=", firstItem.providerFileId)
        .executeTakeFirstOrThrow();
      expect(trimmed).toMatchObject({ indexed_file_id: null, message_count: 2 });

      const reemitted = [];
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade: fakeFacade(),
        minMessages: 1,
        now: new Date("2026-09-05T10:01:00.000Z"),
      })) {
        reemitted.push(item);
      }
      const trimmedItem = reemitted.find((item) => item.providerFileId === trimmed.id);
      expect(trimmedItem?.enrichmentRefresh).toBe("full");
      expect(trimmedItem?.content).toContain("old boundary message 1");
      expect(trimmedItem?.content).toContain("old boundary message 2");
      expect(trimmedItem?.content).not.toContain("old boundary message 3");
    });

    it("re-emits a linked open slice at tier two when a shrink moves it below the floor", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const slice = await insertEmittableSlackSlice(db, {
        channelId: "C_SHRINK_FLOOR",
        startedAt: "2026-09-05T10:00:00.000Z",
        messageCount: 3,
        status: "open",
      });
      const initialItems = [];
      for await (const item of emitSlackSyncedItems({ db, logger, facade: fakeFacade(), minMessages: 3 })) {
        initialItems.push(item);
      }
      const initial = initialItems[0];
      if (!initial) throw new Error("Expected initial Slack emission");
      const persisted = await processSyncedItem({
        db,
        repo: createConnectorRepository(db),
        connectorConfigId: config.id,
        connectorType: "slack",
        item: initial,
        existingHashes: new Map(),
      });
      if (persisted.kind === "skipped_empty") throw new Error("Expected persisted Slack emission");
      const membership = JSON.parse(slice.denoised_message_ids ?? "[]") as number[];
      await db
        .updateTable("conversation_slices")
        .set({
          indexed_file_id: null,
          last_message_id: membership[0],
          ended_at: new Date(Date.parse(slice.ended_at) + 60_000).toISOString(),
          message_count: 1,
          denoised_message_ids: JSON.stringify([membership[0]]),
        })
        .where("id", "=", slice.id)
        .execute();

      const refreshed = [];
      for await (const item of emitSlackSyncedItems({ db, logger, facade: fakeFacade(), minMessages: 3 })) {
        refreshed.push(item);
      }

      expect(refreshed).toHaveLength(1);
      expect(refreshed[0]?.providerFileId).toBe(slice.id);
      expect(refreshed[0]?.enrichmentRefresh).toBe("full");
    });

    it("caches a channel roster failure for the page and reports every skipped slice", async () => {
      await insertEmittableSlackSlice(db, { channelId: "C_FAIL", startedAt: "2026-09-05T08:00:00.000Z" });
      await insertEmittableSlackSlice(db, { channelId: "C_FAIL", startedAt: "2026-09-05T09:00:00.000Z" });
      const healthy = await insertEmittableSlackSlice(db, {
        channelId: "C_OK",
        startedAt: "2026-09-05T10:00:00.000Z",
      });
      let failedRosterCalls = 0;
      let summary: SlackEmissionRunSummary | undefined;
      const items = [];
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade: fakeFacade({
          listChannelMembers: async (channelId) => {
            if (channelId === "C_FAIL") {
              failedRosterCalls += 1;
              throw new Error("transient Slack outage");
            }
            return ["U0TEAM"];
          },
        }),
        onSummary: (value) => {
          summary = value;
        },
      })) {
        items.push(item);
      }
      expect(items.map((item) => item.providerFileId)).toEqual([healthy.id]);
      expect(failedRosterCalls).toBe(1);
      expect(summary).toMatchObject({ rosterFailures: 2, tier2Emits: 1 });
    });

    it.each(["channel_not_found", "not_in_channel"])(
      "dead-letters every listed slice when Slack reports %s",
      async (errorCode) => {
        const first = await insertEmittableSlackSlice(db, {
          channelId: "C_GONE",
          startedAt: "2026-09-05T08:00:00.000Z",
        });
        const second = await insertEmittableSlackSlice(db, {
          channelId: "C_GONE",
          startedAt: "2026-09-05T09:00:00.000Z",
        });
        let rosterCalls = 0;
        const facade = fakeFacade({
          listChannelMembers: async () => {
            rosterCalls += 1;
            throw { data: { error: errorCode } };
          },
        });

        const firstRun = [];
        for await (const item of emitSlackSyncedItems({ db, logger, facade })) firstRun.push(item);
        const dropped = await db
          .selectFrom("conversation_slices")
          .select(["id", "salience_verdict", "salience_signals"])
          .where("id", "in", [first.id, second.id])
          .orderBy("id")
          .execute();

        const secondRun = [];
        for await (const item of emitSlackSyncedItems({ db, logger, facade })) secondRun.push(item);

        expect(firstRun).toHaveLength(0);
        expect(secondRun).toHaveLength(0);
        expect(rosterCalls).toBe(1);
        expect(dropped).toEqual([
          expect.objectContaining({ salience_verdict: "dropped" }),
          expect.objectContaining({ salience_verdict: "dropped" }),
        ]);
        expect(dropped.map((row) => JSON.parse(row.salience_signals ?? "{}"))).toEqual([
          { droppedReason: "channel_inaccessible" },
          { droppedReason: "channel_inaccessible" },
        ]);
      },
    );

    it.each([
      { name: "an ordinary outage", error: new Error("transient Slack outage") },
      { name: "is_archived", error: { data: { error: "is_archived" } } },
    ])("keeps $name roster failures eligible for the next run", async ({ error }) => {
      const first = await insertEmittableSlackSlice(db, {
        channelId: "C_RETRY",
        startedAt: "2026-09-05T08:00:00.000Z",
      });
      const second = await insertEmittableSlackSlice(db, {
        channelId: "C_RETRY",
        startedAt: "2026-09-05T09:00:00.000Z",
      });
      let rosterCalls = 0;
      const facade = fakeFacade({
        listChannelMembers: async () => {
          rosterCalls += 1;
          throw error;
        },
      });

      for await (const _item of emitSlackSyncedItems({ db, logger, facade })) {
      }
      for await (const _item of emitSlackSyncedItems({ db, logger, facade })) {
      }
      const verdicts = await db
        .selectFrom("conversation_slices")
        .select(["id", "salience_verdict"])
        .where("id", "in", [first.id, second.id])
        .orderBy("id")
        .execute();

      expect(rosterCalls).toBe(2);
      expect(verdicts.map((row) => row.salience_verdict)).toEqual(["kept", "kept"]);
    });

    it("emits current slices before capped legacy slices newest-first", async () => {
      const oldest = await insertEmittableSlackSlice(db, {
        channelId: "C1",
        startedAt: "2026-09-01T10:00:00.000Z",
        legacy: true,
      });
      const newest = await insertEmittableSlackSlice(db, {
        channelId: "C1",
        startedAt: "2026-09-03T10:00:00.000Z",
        legacy: true,
      });
      const middle = await insertEmittableSlackSlice(db, {
        channelId: "C1",
        startedAt: "2026-09-02T10:00:00.000Z",
        legacy: true,
      });
      const current = await insertEmittableSlackSlice(db, {
        channelId: "C1",
        startedAt: "2026-09-04T10:00:00.000Z",
      });
      let summary: SlackEmissionRunSummary | undefined;
      const items = [];
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade: fakeFacade(),
        legacyPerRun: 2,
        onSummary: (value) => {
          summary = value;
        },
      })) {
        items.push(item);
      }
      expect(items.map((item) => item.providerFileId)).toEqual([current.id, newest.id, middle.id]);
      expect(items.map((item) => item.providerFileId)).not.toContain(oldest.id);
      expect(summary).toMatchObject({ legacyDrained: 2, legacyRemaining: 1 });
    });

    it("moves a successfully persisted legacy slice into the current refresh lane", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const legacy = await insertEmittableSlackSlice(db, {
        channelId: "C1",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        legacy: true,
      });
      const facade = fakeFacade({ listMemberChannels: async () => [{ id: "C1", name: "c1" }] });

      const syncResult = await runConnectorSync(
        db,
        config.id,
        logger,
        { SLACK_EMISSION_LEGACY_PER_RUN: 1 },
        { slackIndexingFacade: facade },
      );
      const persisted = await db
        .selectFrom("conversation_slices")
        .select(["indexed_file_id", "legacy_unjudged_at"])
        .where("id", "=", legacy.id)
        .executeTakeFirstOrThrow();
      const refreshed = [];
      for await (const item of emitSlackSyncedItems({ db, logger, facade })) refreshed.push(item);

      expect(syncResult.errors).toEqual([]);
      expect(syncResult.itemsProcessed).toBe(1);
      expect(persisted.indexed_file_id).not.toBeNull();
      expect(persisted.legacy_unjudged_at).toBeNull();
      expect(refreshed.map((item) => item.providerFileId)).toContain(legacy.id);
    });

    it("re-emits a growing linked open slice as tier one without advancing its enrichment anchor", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const slice = await insertEmittableSlackSlice(db, {
        channelId: "C1",
        startedAt: "2026-09-05T10:00:00.000Z",
        messageCount: 10,
        status: "open",
      });
      const firstItems = [];
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade: fakeFacade(),
        now: new Date("2026-09-05T10:30:00.000Z"),
      })) {
        firstItems.push(item);
      }
      const firstItem = firstItems[0];
      if (!firstItem) throw new Error("Expected initial Slack emission");
      await processSyncedItem({
        db,
        repo: createConnectorRepository(db),
        connectorConfigId: config.id,
        connectorType: "slack",
        item: firstItem,
        existingHashes: new Map(),
      });

      const conversations = createConversationRepository(db);
      const next = await conversations.insertMessage({
        conversationId: slice.conversation_id,
        providerMessageId: "growth-11",
        senderJid: "U0TEAM",
        senderName: "Roopak",
        text: "a newly searchable update",
        providerTimestamp: "2026-09-05T10:01:00.000Z",
        receivedAt: "2026-09-05T10:01:00.000Z",
      });
      const membership = JSON.parse(slice.denoised_message_ids ?? "[]") as number[];
      await db
        .updateTable("conversation_slices")
        .set({
          last_message_id: next.row.id,
          ended_at: "2026-09-05T10:01:00.000Z",
          message_count: 11,
          denoised_message_ids: JSON.stringify([...membership, next.row.id]),
        })
        .where("id", "=", slice.id)
        .execute();

      const secondItems = [];
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade: fakeFacade(),
        now: new Date("2026-09-05T11:00:00.000Z"),
      })) {
        secondItems.push(item);
      }
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0]?.enrichmentRefresh).toBe("embeddings_only");
      expect(secondItems[0]?.sourceMeta).toEqual({
        firstMessageId: slice.first_message_id,
        messageCount: 11,
        emittedAt: "2026-09-05T11:00:00.000Z",
        enrichedMessageCount: 10,
        enrichedAt: "2026-09-05T10:30:00.000Z",
      });
    });

    it("uses separate open floors for channels and threads and round-trips source metadata", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const channel = await insertEmittableSlackSlice(db, {
        channelId: "C1",
        startedAt: "2026-09-05T09:00:00.000Z",
        status: "open",
      });
      const thread = await insertEmittableSlackSlice(db, {
        channelId: "C1",
        startedAt: "2026-09-05T10:00:00.000Z",
        status: "open",
        providerThreadId: "thread-1",
      });
      const items = [];
      for await (const item of emitSlackSyncedItems({ db, logger, facade: fakeFacade() })) items.push(item);
      expect(items.map((item) => item.providerFileId)).toEqual([thread.id]);
      expect(items.map((item) => item.providerFileId)).not.toContain(channel.id);

      const item = items[0];
      if (!item) throw new Error("Expected thread emission");
      await processSyncedItem({
        db,
        repo: createConnectorRepository(db),
        connectorConfigId: config.id,
        connectorType: "slack",
        item,
        existingHashes: new Map(),
      });
      const file = await db
        .selectFrom("indexed_files")
        .select("source_meta")
        .where("provider_file_id", "=", thread.id)
        .executeTakeFirstOrThrow();
      expect(readSourceMeta(file)).toEqual(item.sourceMeta);
    });

    it("does not resolve a roster or render an unchanged linked open slice", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const slice = await insertEmittableSlackSlice(db, {
        channelId: "C1",
        startedAt: "2026-09-05T10:00:00.000Z",
        messageCount: 10,
        status: "open",
      });
      await db
        .insertInto("indexed_files")
        .values({
          id: "unchanged-open-file",
          connector_config_id: config.id,
          provider_file_id: slice.id,
          file_name: "Slack open slice",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          source_updated_at: slice.ended_at,
          synced_at: slice.ended_at,
        })
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: "unchanged-open-file", denoised_message_ids: null })
        .where("id", "=", slice.id)
        .execute();
      let rosterCalls = 0;
      const listedSliceCounts: number[] = [];
      const items = [];
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade: fakeFacade({
          listChannelMembers: async () => {
            rosterCalls += 1;
            return ["U0TEAM"];
          },
        }),
        onPageListedSliceCount: (count) => listedSliceCounts.push(count),
      })) {
        items.push(item);
      }
      expect(items).toHaveLength(0);
      expect(rosterCalls).toBe(0);
      expect(listedSliceCounts).toEqual([0, 0]);
      const verdict = await db
        .selectFrom("conversation_slices")
        .select("salience_verdict")
        .where("id", "=", slice.id)
        .executeTakeFirstOrThrow();
      expect(verdict.salience_verdict).toBe("kept");
    });

    it("scopes the roster cache to each 200-row page", async () => {
      for (let index = 0; index < 201; index += 1) {
        await insertEmittableSlackSlice(db, {
          channelId: "C1",
          startedAt: new Date(Date.parse("2026-08-01T00:00:00.000Z") + index * 60_000).toISOString(),
        });
      }
      const cacheSizes: number[] = [];
      let rosterCalls = 0;
      for await (const _item of emitSlackSyncedItems({
        db,
        logger,
        facade: fakeFacade({
          listChannelMembers: async () => {
            rosterCalls += 1;
            return ["U0TEAM"];
          },
        }),
        emissionRefreshDays: 60,
        onPageRosterCacheSize: (size) => cacheSizes.push(size),
      })) {
      }
      expect(cacheSizes).toEqual([1, 1]);
      expect(rosterCalls).toBe(2);
    });

    it("archives all channel files on disconnect so stale ACLs stop granting reads", async () => {
      await ensureSlackConnectorConfig({ db, logger });
      const config = await db
        .selectFrom("connector_configs")
        .select("id")
        .where("connector_type", "=", "slack")
        .executeTakeFirstOrThrow();
      const repo = createConnectorRepository(db);
      const scopeId = await repo.upsertAccessScope(config.id, {
        scopeType: "slack_channel",
        providerScopeId: "C1",
        label: "#general",
        members: ["roopak@example.com"],
      });

      const conversations = createConversationRepository(db);
      const conversation = await conversations.getOrCreate({
        platform: "slack",
        kind: "channel",
        providerConversationId: "C1",
      });
      const slice = await createConversationSlicesRepository(db).insertIfAbsent({
        conversationId: conversation.id,
        firstMessageId: 1,
        lastMessageId: 2,
        startedAt: "2026-07-01T00:00:00.000Z",
        endedAt: "2026-07-01T01:00:00.000Z",
        messageCount: 2,
        denoisedMessageIds: [1, 2],
        flushReason: "gap",
        rosterSnapshot: "[]",
        salienceVerdict: "kept",
      });
      await db
        .insertInto("indexed_files")
        .values({
          id: "file-live",
          connector_config_id: config.id,
          provider_file_id: slice.row.id,
          file_name: "Slack: #general",
          file_type: "slack_conversation_slice",
          content_category: "document",
          source: "slack",
          access_scope_id: scopeId,
          synced_at: "2026-07-01T02:00:00.000Z",
        })
        .execute();
      await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: "file-live" })
        .where("id", "=", slice.row.id)
        .execute();

      const archived = await archiveAllSlackChannelFiles({
        db,
        logger,
        connectorConfigId: config.id,
      });
      expect(archived).toBe(1);

      const file = await db
        .selectFrom("indexed_files")
        .select(["is_archived", "access_scope_id"])
        .where("id", "=", "file-live")
        .executeTakeFirstOrThrow();
      expect(file.is_archived).toBe(1);
      expect(file.access_scope_id).toBeNull();

      const clearedSlice = await db
        .selectFrom("conversation_slices")
        .select("indexed_file_id")
        .where("id", "=", slice.row.id)
        .executeTakeFirstOrThrow();
      expect(clearedSlice.indexed_file_id).toBeNull();

      expect(
        await archiveAllSlackChannelFiles({
          db,
          logger,
          connectorConfigId: config.id,
        }),
      ).toBe(0);
    });
  });
}

runSuite("Slack indexing provisioning + ACL SQLite", createTestDb);
runSuite("Slack indexing provisioning + ACL Postgres", createTestPgDb);
