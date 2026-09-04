import { configSchema } from "../config";
import { resolveSlackChunkEngineKnobs } from "./slack-chunk-adapters";
import { runSlackChunkEngine } from "./slack-chunk-engine-runner";
import {
  SLACK_EMISSION_REFRESH_DAYS,
  archiveAllSlackChannelFiles,
  emitSlackSyncedItems,
  reconcileSlackChannelAcls,
} from "./slack-salience";
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

      const config = configSchema.parse(appConfig ?? {});
      const knobs = resolveSlackChunkEngineKnobs(config);
      await runSlackChunkEngine({
        db,
        logger,
        generate: slackChunkerGenerate,
        channelKnobs: knobs.channel,
        threadKnobs: knobs.thread,
        discoveryPageRows: config.SLACK_DISCOVERY_PAGE_ROWS,
        discoveryMaxPages: config.SLACK_DISCOVERY_MAX_PAGES,
      });

      let emitted = 0;
      let skippedNoScope = 0;
      for await (const item of emitSlackSyncedItems({
        db,
        logger,
        facade: slackIndexing,
        emissionRefreshDays: SLACK_EMISSION_REFRESH_DAYS,
        onSkippedNoScope: () => {
          skippedNoScope += 1;
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
      logger.info({ emitted, skippedNoScope }, "Completed Slack indexing sync");
    },

    async getCursor(): Promise<string | null> {
      return null;
    },
  };
}
