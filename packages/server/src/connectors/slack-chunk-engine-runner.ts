import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import type { DB } from "../db/schema";
import { type ChunkEngineKnobs, evaluateIdleClose } from "./chunk-engine";
import { runStreamTick } from "./chunk-engine-runner";
import type { ChunkGenerate } from "./chunk-generate";
import { createSlackChannelChunkAdapter, createSlackThreadChunkAdapter } from "./slack-chunk-adapters";
import { discoverSlackChunkStreams } from "./slack-chunk-discovery";
import { SLACK_CHANNEL_STREAM_KEY, SLACK_ROUTER_STREAM_KEY } from "./slack-chunk-messages";
import { runWithConcurrency } from "./sync-utils";

export interface RunSlackChunkStreamOptions {
  db: Kysely<DB>;
  logger: Logger;
  now: Date;
  conversationId: number;
  streamKey: string;
  knobs: ChunkEngineKnobs;
  generate: ChunkGenerate | undefined;
}

export interface SlackChunkStreamRunResult {
  windowsProcessed: number;
  slicesClosed: number;
  pendingRemaining: boolean;
  tickSkipped: boolean;
  failed: boolean;
  skippedReason?: string;
}

export interface SlackChunkEngineRunOptions {
  db: Kysely<DB>;
  logger: Logger;
  generate: ChunkGenerate | undefined;
  channelKnobs: ChunkEngineKnobs;
  threadKnobs: ChunkEngineKnobs;
  discoveryPageRows: number;
  discoveryMaxPages: number;
  now?: Date;
}

export interface SlackChunkEngineRunSummary {
  streamsPending: number;
  windowsRun: number;
  slicesClosed: number;
  idleCloses: number;
  tickSkips: number;
  discoveryPages: number;
  streamFailures: number;
}

function adapterFor(options: RunSlackChunkStreamOptions) {
  return options.streamKey === SLACK_CHANNEL_STREAM_KEY
    ? createSlackChannelChunkAdapter({ conversationId: options.conversationId, knobs: options.knobs })
    : createSlackThreadChunkAdapter({
        conversationId: options.conversationId,
        threadTs: options.streamKey,
        knobs: options.knobs,
      });
}

/**
 * Thread streams never call the LLM for boundaries, so a missing generator is
 * only fatal if the engine tries to use it anyway.
 */
export async function runSlackChunkStream(options: RunSlackChunkStreamOptions): Promise<SlackChunkStreamRunResult> {
  const repo = createConversationSlicesRepository(options.db);
  const isChannelStream = options.streamKey === SLACK_CHANNEL_STREAM_KEY;
  const result = await runStreamTick({
    db: options.db,
    logger: options.logger,
    now: options.now,
    adapter: adapterFor(options),
    generate:
      options.generate ?? (async () => Promise.reject(new Error("Slack thread boundary generation must not run"))),
    llmGated: isChannelStream,
    hasGenerator: options.generate !== undefined,
    maxWindows: options.knobs.maxWindowsPerRun,
    readLastAttempt: async () =>
      (await repo.getStreamCursor(options.conversationId, options.streamKey))?.llm_last_attempt_at ?? null,
    stampAttempt: async ({ claimToken }) => {
      if (claimToken === null) return;
      await options.db
        .updateTable("conversation_slice_stream_cursors")
        .set({ llm_last_attempt_at: options.now.toISOString(), updated_at: options.now.toISOString() })
        .where("conversation_id", "=", options.conversationId)
        .where("stream_key", "=", options.streamKey)
        .where("claim_token", "=", claimToken)
        .execute();
    },
    stampWhen: "on_claim",
    onPassComplete: async (completion) => {
      if (completion.pendingRemaining || completion.skippedReason || completion.pendingSinceAtClaim === null) return;
      await options.db
        .updateTable("conversation_slice_stream_cursors")
        .set({ pending_since: null, updated_at: options.now.toISOString() })
        .where("conversation_id", "=", options.conversationId)
        .where("stream_key", "=", options.streamKey)
        .where("claim_token", "=", completion.claimToken)
        .where("pending_since", "=", completion.pendingSinceAtClaim)
        .execute();
    },
    logContext: { conversationId: options.conversationId, streamKey: options.streamKey },
    failureMessage: "Slack chunk stream failed",
    backoffMessage: "Slack chunk provider backoff",
  });
  return {
    windowsProcessed: result.windowsProcessed,
    slicesClosed: result.slicesClosed,
    pendingRemaining: result.pendingRemaining,
    tickSkipped: result.tickSkipped,
    failed: result.failed,
    ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
  };
}

interface StreamWork {
  conversation_id: number;
  stream_key: string;
}

function groupByConversation(rows: StreamWork[]): Map<number, string[]> {
  const grouped = new Map<number, string[]>();
  for (const row of rows) {
    const streams = grouped.get(row.conversation_id) ?? [];
    streams.push(row.stream_key);
    grouped.set(row.conversation_id, streams);
  }
  return grouped;
}

export function slackIdleCloseCandidatesQuery(db: Kysely<DB>, idleBefore: string) {
  return db
    .selectFrom("conversation_slices")
    .select(["conversation_slices.conversation_id", "conversation_slices.provider_thread_id"])
    .where("conversation_slices.status", "=", "open")
    .where("conversation_slices.ended_at", "<", idleBefore)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("conversations")
          .select("conversations.id")
          .whereRef("conversations.id", "=", "conversation_slices.conversation_id")
          .where("conversations.platform", "=", "slack")
          .where("conversations.kind", "=", "channel"),
      ),
    )
    .orderBy("conversation_slices.ended_at");
}

export async function runSlackChunkEngine(options: SlackChunkEngineRunOptions): Promise<SlackChunkEngineRunSummary> {
  const now = options.now ?? new Date();
  const discovery = await discoverSlackChunkStreams({
    db: options.db,
    now,
    pageRows: options.discoveryPageRows,
    maxPages: options.discoveryMaxPages,
  });
  const pending = await options.db
    .selectFrom("conversation_slice_stream_cursors")
    .innerJoin("conversations", "conversations.id", "conversation_slice_stream_cursors.conversation_id")
    .select(["conversation_slice_stream_cursors.conversation_id", "conversation_slice_stream_cursors.stream_key"])
    .where("conversations.platform", "=", "slack")
    .where("conversations.kind", "=", "channel")
    .where("conversation_slice_stream_cursors.pending_since", "is not", null)
    .where("conversation_slice_stream_cursors.stream_key", "<>", SLACK_ROUTER_STREAM_KEY)
    .orderBy("conversation_slice_stream_cursors.conversation_id")
    .orderBy("conversation_slice_stream_cursors.stream_key")
    .execute();
  const summary: SlackChunkEngineRunSummary = {
    streamsPending: pending.length,
    windowsRun: 0,
    slicesClosed: 0,
    idleCloses: 0,
    tickSkips: 0,
    discoveryPages: discovery.pages,
    streamFailures: 0,
  };
  const pendingGroups = [...groupByConversation(pending).entries()];
  await runWithConcurrency(pendingGroups, options.channelKnobs.groupWorkerPool, async ([conversationId, streams]) => {
    for (const streamKey of streams) {
      const result = await runSlackChunkStream({
        db: options.db,
        logger: options.logger,
        now,
        conversationId,
        streamKey,
        knobs: streamKey === SLACK_CHANNEL_STREAM_KEY ? options.channelKnobs : options.threadKnobs,
        generate: options.generate,
      });
      summary.windowsRun += result.windowsProcessed;
      summary.slicesClosed += result.slicesClosed;
      if (result.tickSkipped) summary.tickSkips += 1;
      if (result.failed) summary.streamFailures += 1;
    }
  });

  const idleBefore = new Date(now.getTime() - options.channelKnobs.idleCloseHours * 60 * 60_000).toISOString();
  const idleCandidates = await slackIdleCloseCandidatesQuery(options.db, idleBefore).execute();
  const idleWork = idleCandidates.map((row) => ({
    conversation_id: row.conversation_id,
    stream_key: row.provider_thread_id ?? SLACK_CHANNEL_STREAM_KEY,
  }));
  const idleGroups = [...groupByConversation(idleWork).entries()];
  await runWithConcurrency(idleGroups, options.channelKnobs.groupWorkerPool, async ([conversationId, streams]) => {
    for (const streamKey of streams) {
      try {
        const knobs = streamKey === SLACK_CHANNEL_STREAM_KEY ? options.channelKnobs : options.threadKnobs;
        const adapter = adapterFor({
          db: options.db,
          logger: options.logger,
          now,
          conversationId,
          streamKey,
          knobs,
          generate: options.generate,
        });
        if (
          await evaluateIdleClose(
            {
              db: options.db,
              logger: options.logger,
              generate:
                options.generate ??
                (async () => Promise.reject(new Error("Slack idle close boundary generation must not run"))),
              now: () => now.getTime(),
            },
            { adapter, mode: "live" },
          )
        ) {
          summary.idleCloses += 1;
        }
      } catch (err) {
        summary.streamFailures += 1;
        options.logger.warn({ err, conversationId, streamKey }, "Slack idle-close stream failed");
      }
    }
  });
  options.logger.info(summary, "Completed Slack chunk engine run");
  return summary;
}
