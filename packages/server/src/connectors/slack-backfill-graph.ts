import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createSlackBackfillRangeRepository } from "../db/repositories/slack-backfill-ranges";
import type { SlackBackfillRangeRow } from "../db/repositories/slack-backfill-ranges";
import type { DB } from "../db/schema";
import { type ChunkEngineKnobs, runChunkingPass } from "./chunk-engine";
import type { ChunkGenerate } from "./chunk-generate";
import { createSlackHistoryChunkAdapter } from "./slack-chunk-adapters";
import { SLACK_CHANNEL_STREAM_KEY } from "./slack-chunk-messages";
import {
  type WhatsAppBackfillGraphKnobs,
  exceedsWhatsAppBackfillGraphPressure,
  readWhatsAppBackfillGraphBacklog,
  resolveWhatsAppBackfillGraphKnobs,
} from "./whatsapp-chunker";

export interface AdmitSlackBackfillGraphOptions {
  db: Kysely<DB>;
  logger: Logger;
  generate: ChunkGenerate | undefined;
  channelKnobs: ChunkEngineKnobs;
  threadKnobs: ChunkEngineKnobs;
  backfillGraphKnobs?: Partial<WhatsAppBackfillGraphKnobs>;
  now?: Date;
}

export interface SlackBackfillGraphSummary {
  rangesServed: number;
  messagesRead: number;
  slicesClosed: number;
  rangesCompleted: number;
  rangesHalted: number;
  skippedForPressure: boolean;
}

interface HistoryRow {
  id: number;
  effective_at: string;
  is_thread_reply: number;
  provider_thread_id: string | null;
}

async function readPage(db: Kysely<DB>, range: SlackBackfillRangeRow, limit: number): Promise<HistoryRow[]> {
  let query = db
    .selectFrom("conversation_messages")
    .select(["id", "effective_at", "is_thread_reply", "provider_thread_id"])
    .where("conversation_id", "=", range.conversation_id)
    .where("source", "=", "history")
    .where("backfill_range_id", "=", range.id)
    .where("effective_at", "is not", null);
  if (range.graph_cursor_effective_at !== null && range.graph_cursor_id !== null) {
    const cursorEffectiveAt = range.graph_cursor_effective_at;
    const cursorId = range.graph_cursor_id;
    query = query.where((eb) =>
      eb.or([
        eb("effective_at", ">", cursorEffectiveAt),
        eb.and([eb("effective_at", "=", cursorEffectiveAt), eb("id", ">", cursorId)]),
      ]),
    );
  }
  const rows = await query.orderBy("effective_at", "asc").orderBy("id", "asc").limit(limit).execute();
  return rows.map((row) => ({ ...row, effective_at: row.effective_at as string }));
}

function streamKeyOf(row: HistoryRow): string {
  return row.is_thread_reply === 1 && row.provider_thread_id ? row.provider_thread_id : SLACK_CHANNEL_STREAM_KEY;
}

/**
 * Admits one page of a fetched Slack backfill range into the context graph:
 * the same chunk engine the live path runs, driven by the history adapter in
 * `backfill` mode so slices land with `origin='history'` and never touch the
 * live open slice. Runs before the live pass on every Slack sync.
 *
 * A range that returns an empty page is fully sliced: its open history slices
 * are flushed and the range is stamped complete, because history is a finite
 * set with nothing left to wait for. Only live streams keep an open chunk.
 */
export async function admitSlackBackfillGraphPages(
  options: AdmitSlackBackfillGraphOptions,
): Promise<SlackBackfillGraphSummary> {
  const knobs = resolveWhatsAppBackfillGraphKnobs(options.backfillGraphKnobs);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const ranges = createSlackBackfillRangeRepository(options.db);
  const slices = createConversationSlicesRepository(options.db);
  const servedConversationIds: number[] = [];
  const summary: SlackBackfillGraphSummary = {
    rangesServed: 0,
    messagesRead: 0,
    slicesClosed: 0,
    rangesCompleted: 0,
    rangesHalted: 0,
    skippedForPressure: false,
  };

  while (summary.messagesRead < knobs.cycleMessages) {
    const range = await ranges.findNextGraphCandidate({ excludedConversationIds: servedConversationIds });
    if (!range) break;
    const backlog = await readWhatsAppBackfillGraphBacklog(options.db);
    if (exceedsWhatsAppBackfillGraphPressure(backlog, knobs)) {
      summary.skippedForPressure = true;
      options.logger.info({ ...backlog }, "Skipped Slack backfill graph admission under pipeline backpressure");
      break;
    }
    servedConversationIds.push(range.conversation_id);
    const pageLimit = Math.min(knobs.pageMessages, knobs.cycleMessages - summary.messagesRead);
    const rows = await readPage(options.db, range, pageLimit);

    if (rows.length === 0) {
      for (const open of await slices.listOpenSlices(range.conversation_id, "history")) {
        await slices.closeOpenSlice(open.id, "gap");
        summary.slicesClosed += 1;
      }
      if (await ranges.completeGraph(range.id, nowIso)) summary.rangesCompleted += 1;
      continue;
    }

    const byStream = new Map<string, HistoryRow[]>();
    for (const row of rows) {
      const key = streamKeyOf(row);
      const bucket = byStream.get(key) ?? [];
      bucket.push(row);
      byStream.set(key, bucket);
    }

    let halted = false;
    for (const [streamKey, streamRows] of byStream) {
      const last = streamRows[streamRows.length - 1];
      if (!last) continue;
      const isChannel = streamKey === SLACK_CHANNEL_STREAM_KEY;
      const result = await runChunkingPass(
        {
          db: options.db,
          logger: options.logger,
          generate:
            options.generate ??
            (async () => Promise.reject(new Error("Slack history boundary generation must not run"))),
          now: () => now.getTime(),
        },
        {
          adapter: createSlackHistoryChunkAdapter({
            conversationId: range.conversation_id,
            threadTs: isChannel ? null : streamKey,
            rangeId: range.id,
            knobs: isChannel ? options.channelKnobs : options.threadKnobs,
          }),
          mode: "backfill",
          pendingUntil: { effectiveAt: last.effective_at, id: last.id },
        },
      );
      summary.slicesClosed += result.slicesClosed;
      if (result.skippedReason === "overlap_guard") {
        await ranges.haltGraph(range.id, "Slack history boundary overlapped existing slice membership", nowIso);
        options.logger.error(
          { rangeId: range.id, channelId: range.channel_id, conversationId: range.conversation_id, streamKey },
          "Halted Slack backfill graph admission after invariant failure",
        );
        summary.rangesHalted += 1;
        halted = true;
        break;
      }
    }
    if (halted) continue;

    const tail = rows[rows.length - 1];
    if (tail) {
      await ranges.advanceGraphCursor({
        id: range.id,
        effectiveAt: tail.effective_at,
        messageId: tail.id,
        now: nowIso,
      });
    }
    summary.messagesRead += rows.length;
    summary.rangesServed += 1;
  }

  return summary;
}
