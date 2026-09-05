import { configDefault } from "./config-default";
import { resolveSlackChunkEngineKnobs } from "./slack-chunk-adapters";
import { runSlackChunkEngine } from "./slack-chunk-engine-runner";
import {
  SLACK_EMISSION_REFRESH_DAYS,
  archiveAllSlackChannelFiles,
  emitSlackSyncedItems,
  reconcileSlackChannelAcls,
} from "./slack-emission";
import type { Connector, ConnectorCredentials, SyncedItem } from "./types";

const SLACK_CHUNK_DEFAULTS = {
  SLACK_CHUNK_WINDOW_MESSAGES: configDefault("SLACK_CHUNK_WINDOW_MESSAGES"),
  SLACK_CHUNK_WINDOW_TOKENS: configDefault("SLACK_CHUNK_WINDOW_TOKENS"),
  SLACK_CHUNK_MIN_MESSAGES: configDefault("SLACK_CHUNK_MIN_MESSAGES"),
  SLACK_CHUNK_TARGET_MESSAGES: configDefault("SLACK_CHUNK_TARGET_MESSAGES"),
  SLACK_CHUNK_MAX_MESSAGES: configDefault("SLACK_CHUNK_MAX_MESSAGES"),
  SLACK_CHUNK_MAX_TOKENS: configDefault("SLACK_CHUNK_MAX_TOKENS"),
  SLACK_THREAD_MIN_MESSAGES: configDefault("SLACK_THREAD_MIN_MESSAGES"),
  SLACK_CHUNK_TICK_MINUTES: configDefault("SLACK_CHUNK_TICK_MINUTES"),
  SLACK_CHUNK_IDLE_CLOSE_HOURS: configDefault("SLACK_CHUNK_IDLE_CLOSE_HOURS"),
  SLACK_CHUNK_PROVISIONAL_REFRESH_MESSAGES: configDefault("SLACK_CHUNK_PROVISIONAL_REFRESH_MESSAGES"),
  SLACK_CHUNK_PROVISIONAL_REFRESH_MAX_MINUTES: configDefault("SLACK_CHUNK_PROVISIONAL_REFRESH_MAX_MINUTES"),
  SLACK_CHUNK_MODEL: configDefault("SLACK_CHUNK_MODEL"),
  SLACK_CHUNK_REASONING_EFFORT: configDefault("SLACK_CHUNK_REASONING_EFFORT"),
  SLACK_CHUNK_BURST_THRESHOLD_MESSAGES: configDefault("SLACK_CHUNK_BURST_THRESHOLD_MESSAGES"),
  SLACK_CHUNK_TOPIC_REGISTRY_CAP: configDefault("SLACK_CHUNK_TOPIC_REGISTRY_CAP"),
  SLACK_CHUNK_CHANNEL_WORKER_POOL: configDefault("SLACK_CHUNK_CHANNEL_WORKER_POOL"),
  SLACK_CHUNK_MAX_WINDOWS_PER_RUN: configDefault("SLACK_CHUNK_MAX_WINDOWS_PER_RUN"),
  SLACK_DISCOVERY_PAGE_ROWS: configDefault("SLACK_DISCOVERY_PAGE_ROWS"),
  SLACK_DISCOVERY_MAX_PAGES: configDefault("SLACK_DISCOVERY_MAX_PAGES"),
  SLACK_EMISSION_LEGACY_PER_RUN: configDefault("SLACK_EMISSION_LEGACY_PER_RUN"),
};

function assertSystemCredentials(credentials: ConnectorCredentials): void {
  if (credentials.type !== "system") {
    throw new Error("Slack indexing connector requires system credentials");
  }
}

/**
 * Indexes Slack channels Sketch is a member of into the knowledge graph:
 * discover and chunk captured messages into per-stream slices, emit kept
 * slices as indexed files, then reconcile channel ACLs
 * independent of emission. Membership is the opt-in — there is no per-channel
 * flag or registry.
 */
export function createSlackIndexingConnector(): Connector {
  return {
    type: "slack",
    perUserAuth: false,
    requiresOAuthClientSetup: false,
    syncIsCompleteSnapshot: false,

    async validateCredentials(credentials: ConnectorCredentials): Promise<void> {
      assertSystemCredentials(credentials);
    },

    async *sync({
      db,
      connectorConfigId,
      credentials,
      logger,
      appConfig,
      slackChunkerGenerate,
      slackIndexing,
    }): AsyncGenerator<SyncedItem> {
      assertSystemCredentials(credentials);
      if (!db) throw new Error("Slack indexing connector requires database access");
      if (!connectorConfigId) throw new Error("Slack indexing connector requires its connector config id");
      if (!slackIndexing || !(await slackIndexing.isConfigured())) {
        await archiveAllSlackChannelFiles({
          db,
          logger,
          connectorConfigId,
          slackEntitySyncEnabled: appConfig?.SLACK_ENTITY_SYNC ?? true,
        });
        logger.warn("Slack indexing skipped: no Slack bot token configured");
        return;
      }

      const knobs = resolveSlackChunkEngineKnobs({
        SLACK_CHUNK_WINDOW_MESSAGES:
          appConfig?.SLACK_CHUNK_WINDOW_MESSAGES ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_WINDOW_MESSAGES,
        SLACK_CHUNK_WINDOW_TOKENS:
          appConfig?.SLACK_CHUNK_WINDOW_TOKENS ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_WINDOW_TOKENS,
        SLACK_CHUNK_MIN_MESSAGES: appConfig?.SLACK_CHUNK_MIN_MESSAGES ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_MIN_MESSAGES,
        SLACK_CHUNK_TARGET_MESSAGES:
          appConfig?.SLACK_CHUNK_TARGET_MESSAGES ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_TARGET_MESSAGES,
        SLACK_CHUNK_MAX_MESSAGES: appConfig?.SLACK_CHUNK_MAX_MESSAGES ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_MAX_MESSAGES,
        SLACK_CHUNK_MAX_TOKENS: appConfig?.SLACK_CHUNK_MAX_TOKENS ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_MAX_TOKENS,
        SLACK_THREAD_MIN_MESSAGES:
          appConfig?.SLACK_THREAD_MIN_MESSAGES ?? SLACK_CHUNK_DEFAULTS.SLACK_THREAD_MIN_MESSAGES,
        SLACK_CHUNK_TICK_MINUTES: appConfig?.SLACK_CHUNK_TICK_MINUTES ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_TICK_MINUTES,
        SLACK_CHUNK_IDLE_CLOSE_HOURS:
          appConfig?.SLACK_CHUNK_IDLE_CLOSE_HOURS ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_IDLE_CLOSE_HOURS,
        SLACK_CHUNK_PROVISIONAL_REFRESH_MESSAGES:
          appConfig?.SLACK_CHUNK_PROVISIONAL_REFRESH_MESSAGES ??
          SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_PROVISIONAL_REFRESH_MESSAGES,
        SLACK_CHUNK_MODEL: appConfig?.SLACK_CHUNK_MODEL ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_MODEL,
        SLACK_CHUNK_REASONING_EFFORT:
          appConfig?.SLACK_CHUNK_REASONING_EFFORT ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_REASONING_EFFORT,
        SLACK_CHUNK_BURST_THRESHOLD_MESSAGES:
          appConfig?.SLACK_CHUNK_BURST_THRESHOLD_MESSAGES ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_BURST_THRESHOLD_MESSAGES,
        SLACK_CHUNK_TOPIC_REGISTRY_CAP:
          appConfig?.SLACK_CHUNK_TOPIC_REGISTRY_CAP ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_TOPIC_REGISTRY_CAP,
        SLACK_CHUNK_CHANNEL_WORKER_POOL:
          appConfig?.SLACK_CHUNK_CHANNEL_WORKER_POOL ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_CHANNEL_WORKER_POOL,
        SLACK_CHUNK_MAX_WINDOWS_PER_RUN:
          appConfig?.SLACK_CHUNK_MAX_WINDOWS_PER_RUN ?? SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_MAX_WINDOWS_PER_RUN,
      });
      await runSlackChunkEngine({
        db,
        logger,
        generate: slackChunkerGenerate,
        channelKnobs: knobs.channel,
        threadKnobs: knobs.thread,
        discoveryPageRows: appConfig?.SLACK_DISCOVERY_PAGE_ROWS ?? SLACK_CHUNK_DEFAULTS.SLACK_DISCOVERY_PAGE_ROWS,
        discoveryMaxPages: appConfig?.SLACK_DISCOVERY_MAX_PAGES ?? SLACK_CHUNK_DEFAULTS.SLACK_DISCOVERY_MAX_PAGES,
      });

      let emitted = 0;
      let skippedNoScope = 0;
      let emissionSummary = {
        tier1Emits: 0,
        tier2Emits: 0,
        legacyDrained: 0,
        legacyRemaining: 0,
        rosterFailures: 0,
      };
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade: slackIndexing,
        emissionRefreshDays: SLACK_EMISSION_REFRESH_DAYS,
        minMessages: knobs.channel.minMessages,
        threadMinMessages: knobs.thread.minMessages,
        provisionalRefreshMessages: knobs.channel.provisionalRefreshMessages,
        provisionalRefreshMaxMinutes:
          appConfig?.SLACK_CHUNK_PROVISIONAL_REFRESH_MAX_MINUTES ??
          SLACK_CHUNK_DEFAULTS.SLACK_CHUNK_PROVISIONAL_REFRESH_MAX_MINUTES,
        legacyPerRun: appConfig?.SLACK_EMISSION_LEGACY_PER_RUN ?? SLACK_CHUNK_DEFAULTS.SLACK_EMISSION_LEGACY_PER_RUN,
        onSkippedNoScope: () => {
          skippedNoScope += 1;
        },
        onSummary: (summary) => {
          emissionSummary = summary;
        },
        slackEntitySyncEnabled: appConfig?.SLACK_ENTITY_SYNC ?? true,
      })) {
        emitted += 1;
        yield item;
      }

      await reconcileSlackChannelAcls({
        db,
        logger,
        facade: slackIndexing,
        connectorConfigId,
        slackEntitySyncEnabled: appConfig?.SLACK_ENTITY_SYNC ?? true,
      });
      logger.info({ emitted, skippedNoScope, ...emissionSummary }, "Completed Slack indexing sync");
    },

    async getCursor(): Promise<string | null> {
      return null;
    },
  };
}
