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

      const knobs = resolveSlackChunkEngineKnobs(appConfig);
      await runSlackChunkEngine({
        db,
        logger,
        generate: slackChunkerGenerate,
        channelKnobs: knobs.channel,
        threadKnobs: knobs.thread,
        discoveryPageRows: appConfig?.SLACK_DISCOVERY_PAGE_ROWS ?? configDefault("SLACK_DISCOVERY_PAGE_ROWS"),
        discoveryMaxPages: appConfig?.SLACK_DISCOVERY_MAX_PAGES ?? configDefault("SLACK_DISCOVERY_MAX_PAGES"),
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
          configDefault("SLACK_CHUNK_PROVISIONAL_REFRESH_MAX_MINUTES"),
        legacyPerRun: appConfig?.SLACK_EMISSION_LEGACY_PER_RUN ?? configDefault("SLACK_EMISSION_LEGACY_PER_RUN"),
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
