import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import type { DB } from "../db/schema";
import { type ChunkCursorState, type ChunkEngineKnobs, evaluateIdleClose, runChunkingPass } from "./chunk-engine";
import type { ChunkGenerate } from "./chunk-generate";
import { createSlackChannelChunkAdapter, createSlackThreadChunkAdapter } from "./slack-chunk-adapters";
import { discoverSlackChunkStreams } from "./slack-chunk-discovery";
import { SLACK_CHANNEL_STREAM_KEY, SLACK_ROUTER_STREAM_KEY } from "./slack-chunker";
import { runWithConcurrency } from "./sync-utils";

const BURST_SCAN_MAX_PAGES = 4;

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

async function countPendingIndexable(options: RunSlackChunkStreamOptions, threshold: number): Promise<number> {
  const adapter = adapterFor(options);
  const row = await createConversationSlicesRepository(options.db).getStreamCursor(
    options.conversationId,
    options.streamKey,
  );
  if (!row) return 0;
  let cursor: ChunkCursorState = {
    lastEffectiveAt: null,
    lastMessageId: row.last_message_id,
    claimToken: row.claim_token,
    pendingSince: row.pending_since,
  };
  let count = 0;
  for (let page = 0; page < BURST_SCAN_MAX_PAGES; page += 1) {
    const loaded = await adapter.loadOpenAndPending(options.db, undefined, cursor, threshold, { mode: "live" });
    count += loaded.pendingRaw.filter((message) => adapter.isIndexable(message)).length;
    if (count >= threshold || !loaded.pageFull) break;
    const tail = loaded.pendingRaw.at(-1);
    if (!tail) break;
    cursor = { ...cursor, lastMessageId: tail.id };
  }
  return count;
}

async function burstThreshold(options: RunSlackChunkStreamOptions): Promise<number> {
  if (options.knobs.burstThresholdMessages !== null) return Math.max(1, options.knobs.burstThresholdMessages);
  const open = await createConversationSlicesRepository(options.db).getOpenSlice(options.conversationId, null);
  return Math.max(1, options.knobs.windowMessages - (open?.message_count ?? 0));
}

export async function runSlackChunkStream(options: RunSlackChunkStreamOptions): Promise<SlackChunkStreamRunResult> {
  const adapter = adapterFor(options);
  if (options.streamKey === SLACK_CHANNEL_STREAM_KEY) {
    if (!options.generate) {
      return {
        windowsProcessed: 0,
        slicesClosed: 0,
        pendingRemaining: true,
        tickSkipped: false,
        skippedReason: "no_generator",
      };
    }
    const cursor = await createConversationSlicesRepository(options.db).getStreamCursor(
      options.conversationId,
      options.streamKey,
    );
    const lastAttemptMs = cursor?.llm_last_attempt_at ? Date.parse(cursor.llm_last_attempt_at) : Number.NaN;
    const insideTick =
      Number.isFinite(lastAttemptMs) && options.now.getTime() - lastAttemptMs < options.knobs.tickMinutes * 60_000;
    if (insideTick) {
      const threshold = await burstThreshold(options);
      const pendingCount = await countPendingIndexable(options, threshold);
      if (pendingCount < threshold) {
        return { windowsProcessed: 0, slicesClosed: 0, pendingRemaining: true, tickSkipped: true };
      }
    }
  }

  const generate: ChunkGenerate =
    options.generate ?? (async () => Promise.reject(new Error("Slack thread boundary generation must not run")));
  const result = await runChunkingPass(
    { db: options.db, logger: options.logger, generate, now: () => options.now.getTime() },
    {
      adapter,
      mode: "live",
      maxWindows: options.knobs.maxWindowsPerRun,
      onPassClaimed: async ({ claimToken }) => {
        if (options.streamKey !== SLACK_CHANNEL_STREAM_KEY) return;
        await options.db
          .updateTable("conversation_slice_stream_cursors")
          .set({ llm_last_attempt_at: options.now.toISOString(), updated_at: options.now.toISOString() })
          .where("conversation_id", "=", options.conversationId)
          .where("stream_key", "=", options.streamKey)
          .where("claim_token", "=", claimToken)
          .execute();
      },
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
    },
  );
  return { ...result, tickSkipped: false };
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
      try {
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
      } catch (err) {
        summary.streamFailures += 1;
        options.logger.warn({ err, conversationId, streamKey }, "Slack chunk stream failed");
      }
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
