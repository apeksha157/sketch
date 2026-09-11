import type { Kysely } from "kysely";
import { type ConversationMessageInsert, createConversationRepository } from "../db/repositories/conversations";
import {
  type SlackBackfillRangeKind,
  type SlackBackfillRangeRow,
  createSlackBackfillRangeRepository,
} from "../db/repositories/slack-backfill-ranges";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";
import { SYSTEM_MESSAGE_SUBTYPES } from "./bot";
import { loadSlackHistoryLookbackDays } from "./history-lookback";
import type { SlackHistoryMessage, SlackIndexingFacade } from "./indexing-facade";
import { isSlackConversationControlMessage, mapSlackBotReplyToInsert, mapSlackMessageToInsert } from "./message-mapper";

export const SLACK_BACKFILL_TICK_MS = 5_000;
export const SLACK_BACKFILL_PAGE_LIMIT = 200;
export const SLACK_BACKFILL_RETRY_BASE_MS = 30_000;
export const SLACK_BACKFILL_GRAPH_SYNC_INTERVAL_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Slack terminal failures: the channel is gone or Sketch is no longer in it. */
const FATAL_SLACK_ERRORS = new Set(["channel_not_found", "not_in_channel", "is_archived"]);

export interface SlackBackfillWorkerOptions {
  db: Kysely<DB>;
  logger: Logger;
  facade: SlackIndexingFacade;
  getBotUserId?: () => string | null;
  requestSlackSync?: () => Promise<void>;
  now?: () => number;
  tickMs?: number;
  pageLimit?: number;
}

export function slackTsFromMs(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(6);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
  const code = data?.error ?? record.code;
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCapturableHistoryMessage(message: SlackHistoryMessage): boolean {
  if (message.subtype && SYSTEM_MESSAGE_SUBTYPES.has(message.subtype)) return false;
  if (isSlackConversationControlMessage(message.text)) return false;
  return message.text.trim().length > 0 || message.hasFiles;
}

export class SlackBackfillWorker {
  private readonly ranges;
  private readonly conversations;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private rerun = false;
  private running = false;
  private lastGraphSyncRequestAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: SlackBackfillWorkerOptions) {
    this.ranges = createSlackBackfillRangeRepository(options.db);
    this.conversations = createConversationRepository(options.db);
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.kick(), this.options.tickMs ?? SLACK_BACKFILL_TICK_MS);
    this.timer.unref?.();
    void this.reconcile()
      .catch((error) => this.options.logger.warn({ error }, "Slack history backfill reconciliation failed"))
      .then(() => this.kick());
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }

  async kick(): Promise<void> {
    if (!this.running) return;
    if (this.active) {
      this.rerun = true;
      await this.active;
      return;
    }
    this.active = this.drain().catch((error) => {
      this.options.logger.error({ error }, "Slack history backfill worker failed");
    });
    const current = this.active;
    await current;
    this.active = null;
    if (this.rerun) {
      this.rerun = false;
      await this.kick();
    }
  }

  /**
   * Startup reconciliation is the single owner of range creation for state the
   * app could not observe live: a join or a re-add that happened while it was
   * down. Channels that have rows but no range are the retrospective case and
   * are left for the admin's "Index history now" button.
   */
  async reconcile(): Promise<{ initial: number; gap: number; rearmed: number }> {
    const nowIso = new Date(this.now()).toISOString();
    const rearmed = await this.ranges.rearmExhausted(nowIso);
    const window = await this.lookbackWindow();
    if (!window) {
      this.options.logger.info({ rearmed }, "Slack history backfill reconciled; lookback is 0 days");
      return { initial: 0, gap: 0, rearmed };
    }
    const channels = await this.options.facade.listMemberChannels();
    const channelNames = new Map(channels.map((channel) => [channel.id, channel.name]));
    const summaries = await this.ranges.summarizeChannels(channels.map((channel) => channel.id));
    let initial = 0;
    let gap = 0;
    for (const summary of summaries) {
      const channelName = channelNames.get(summary.channelId);
      if (summary.ranges === 0 && summary.storedRows === 0) {
        await this.createRange({ channelId: summary.channelId, channelName, kind: "initial", rangeKey: "initial" }, [
          window.lowerTs,
          window.upperTs,
        ]);
        initial += 1;
        continue;
      }
      if (summary.ranges > 0 && summary.nonTerminalRanges === 0) {
        const lowerTs = summary.newestStoredTs ?? window.lowerTs;
        if (lowerTs >= window.upperTs) continue;
        await this.createRange(
          { channelId: summary.channelId, channelName, kind: "gap", rangeKey: `gap:${window.upperTs}` },
          [lowerTs, window.upperTs],
        );
        gap += 1;
      }
    }
    this.options.logger.info({ initial, gap, rearmed, channels: channels.length }, "Slack history backfill reconciled");
    return { initial, gap, rearmed };
  }

  /**
   * A join into a channel Sketch has never stored anything for takes the full
   * lookback window; a re-add only needs the gap since the newest stored row.
   * Every join ends in one Slack sync: with a range, the drain requests it once
   * the range is fetched so the history is included; without one, right away.
   */
  async handleBotJoinedChannel(channelId: string): Promise<SlackBackfillRangeRow | null> {
    const range = await this.createJoinRange(channelId);
    if (range) void this.kick();
    else this.requestSync();
    return range;
  }

  private async createJoinRange(channelId: string): Promise<SlackBackfillRangeRow | null> {
    const [summary] = await this.ranges.summarizeChannels([channelId]);
    const window = await this.lookbackWindow();
    if (!summary || !window) return null;
    const isInitial = summary.ranges === 0 && summary.storedRows === 0;
    const lowerTs =
      !isInitial && summary.newestStoredTs && summary.newestStoredTs > window.lowerTs
        ? summary.newestStoredTs
        : window.lowerTs;
    if (lowerTs >= window.upperTs) return null;
    return this.createRange(
      {
        channelId,
        channelName: await this.findChannelName(channelId),
        kind: isInitial ? "initial" : "gap",
        rangeKey: isInitial ? "initial" : `gap:${window.upperTs}`,
      },
      [lowerTs, window.upperTs],
    );
  }

  /**
   * Queues `[now - lookback, now)` for every member channel without a running
   * range. Dedup makes this safe to press at any time: rows already captured
   * live are not re-inserted.
   */
  async queueManualBackfill(): Promise<{ channelsQueued: number; channelsSkipped: number }> {
    const window = await this.lookbackWindow();
    if (!window) return { channelsQueued: 0, channelsSkipped: 0 };
    const channels = await this.options.facade.listMemberChannels();
    let channelsQueued = 0;
    let channelsSkipped = 0;
    for (const channel of channels) {
      if (await this.ranges.hasNonTerminalRange(channel.id)) {
        channelsSkipped += 1;
        continue;
      }
      await this.createRange(
        { channelId: channel.id, channelName: channel.name, kind: "manual", rangeKey: `manual:${window.upperTs}` },
        [window.lowerTs, window.upperTs],
      );
      channelsQueued += 1;
    }
    void this.kick();
    return { channelsQueued, channelsSkipped };
  }

  /** `null` when the admin set the lookback to 0 days: no history is fetched. */
  private async lookbackWindow(): Promise<{ lowerTs: string; upperTs: string } | null> {
    const lookbackDays = await loadSlackHistoryLookbackDays(this.options.db);
    if (lookbackDays === 0) return null;
    return {
      lowerTs: slackTsFromMs(this.now() - lookbackDays * DAY_MS),
      upperTs: slackTsFromMs(this.now()),
    };
  }

  private async findChannelName(channelId: string): Promise<string | undefined> {
    for await (const channel of this.options.facade.iterateChannels()) {
      if (channel.id === channelId) return channel.name;
    }
    return undefined;
  }

  /**
   * The channel name is stored only when the range creates the conversation,
   * so the first files carry `#name` instead of the raw channel id. An existing
   * conversation keeps its name: renames go through the ACL pass, which also
   * re-emits the channel's files under the new name.
   */
  private async createRange(
    input: { channelId: string; channelName: string | undefined; kind: SlackBackfillRangeKind; rangeKey: string },
    bounds: [string, string],
  ): Promise<SlackBackfillRangeRow> {
    const ref = { platform: "slack", kind: "channel", providerConversationId: input.channelId };
    const conversation =
      (await this.conversations.find(ref)) ?? (await this.conversations.getOrCreate(ref, input.channelName));
    const { row, created } = await this.ranges.ensureRange({
      channelId: input.channelId,
      conversationId: conversation.id,
      kind: input.kind,
      rangeKey: input.rangeKey,
      lowerTs: bounds[0],
      upperTs: bounds[1],
    });
    if (created) {
      this.options.logger.info(
        { channelId: input.channelId, kind: input.kind, rangeKey: input.rangeKey, rangeId: row.id },
        "Created Slack history backfill range",
      );
    }
    return row;
  }

  private async drain(): Promise<void> {
    while (this.running) {
      const range = await this.ranges.findNextFetchable(new Date(this.now()).toISOString());
      if (!range) break;
      const advanced = await this.stepRange(range);
      if (!advanced) break;
    }
    await this.requestGraphSyncIfPending();
  }

  /**
   * Fetched history only becomes chunks and files inside a Slack sync, so a
   * range waiting for graph admission asks for one instead of sitting until
   * the 30-minute scheduler. Throttled because a sync that is held back by
   * pipeline backpressure admits nothing, and back-to-back retries would only
   * repeat Slack API calls.
   */
  private async requestGraphSyncIfPending(): Promise<void> {
    if (!this.options.requestSlackSync) return;
    if (this.now() - this.lastGraphSyncRequestAt < SLACK_BACKFILL_GRAPH_SYNC_INTERVAL_MS) return;
    if (!(await this.ranges.findNextGraphCandidate({ excludedConversationIds: [] }))) return;
    this.requestSync();
  }

  private requestSync(): void {
    const request = this.options.requestSlackSync;
    if (!request) return;
    this.lastGraphSyncRequestAt = this.now();
    void request().catch((error) => this.options.logger.warn({ error }, "Slack sync request failed"));
  }

  /**
   * Sketch's own past posts only map to the live identity (`sender_jid='bot'`)
   * once the bot user id is known, so a range waits for the Slack connection
   * rather than inserting duplicate rows under the raw user id.
   */
  private async stepRange(range: SlackBackfillRangeRow): Promise<boolean> {
    if (this.options.getBotUserId && this.options.getBotUserId() === null) {
      this.options.logger.debug(
        { rangeId: range.id, channelId: range.channel_id },
        "Deferred Slack backfill range until the Slack bot user id is known",
      );
      return false;
    }
    const nowIso = new Date(this.now()).toISOString();
    try {
      if (range.phase === "pending") {
        await this.ranges.setPhase(range.id, "fetching_history", nowIso);
        return true;
      }
      if (range.phase === "fetching_history") return await this.stepHistoryPage(range, nowIso);
      if (range.phase === "fetching_threads") return await this.stepThreadPage(range, nowIso);
      return false;
    } catch (error) {
      const code = errorCode(error);
      if (code && FATAL_SLACK_ERRORS.has(code)) {
        await this.ranges.markFailed(range.id, code, nowIso);
        this.options.logger.warn(
          { rangeId: range.id, channelId: range.channel_id, code },
          "Slack backfill range failed",
        );
        return true;
      }
      const phase = await this.ranges.recordFailure({
        id: range.id,
        error: errorMessage(error),
        now: nowIso,
        retryAt: new Date(this.now() + SLACK_BACKFILL_RETRY_BASE_MS * (range.attempts + 1)).toISOString(),
      });
      this.options.logger.warn(
        { error, rangeId: range.id, channelId: range.channel_id, phase },
        "Slack backfill page failed",
      );
      return false;
    }
  }

  private async stepHistoryPage(range: SlackBackfillRangeRow, nowIso: string): Promise<boolean> {
    const listHistory = this.options.facade.listChannelHistoryPage;
    if (!listHistory) {
      this.options.logger.warn(
        { rangeId: range.id, channelId: range.channel_id },
        "Slack indexing facade cannot page channel history",
      );
      return false;
    }
    const page = await listHistory(range.channel_id, {
      oldest: range.lower_ts,
      latest: range.upper_ts,
      limit: this.options.pageLimit ?? SLACK_BACKFILL_PAGE_LIMIT,
      ...(range.history_cursor ? { cursor: range.history_cursor } : {}),
    });
    const inserts = await this.buildInserts(range, page.items, null);
    const threadTss = page.items.filter((message) => message.replyCount > 0).map((message) => message.ts);
    await this.options.db.transaction().execute(async (trx) => {
      const captured = await this.insertAll(trx, inserts);
      const ranges = createSlackBackfillRangeRepository(trx);
      await ranges.queueThreads(range.id, threadTss, nowIso);
      await ranges.advanceHistoryCursor({ id: range.id, cursor: page.nextCursor, fetched: captured, now: nowIso });
      if (!page.nextCursor) await ranges.setPhase(range.id, "fetching_threads", nowIso);
    });
    return true;
  }

  private async stepThreadPage(range: SlackBackfillRangeRow, nowIso: string): Promise<boolean> {
    const thread = await this.ranges.nextPendingThread(range.id);
    if (!thread) {
      await this.ranges.setPhase(range.id, "fetched", nowIso);
      this.options.logger.info(
        { rangeId: range.id, channelId: range.channel_id, messagesFetched: range.messages_fetched },
        "Slack history backfill range fetched",
      );
      return true;
    }
    const listReplies = this.options.facade.listThreadRepliesPage;
    if (!listReplies) {
      this.options.logger.warn(
        { rangeId: range.id, channelId: range.channel_id },
        "Slack indexing facade cannot page thread replies",
      );
      return false;
    }
    const page = await listReplies(range.channel_id, thread.thread_ts, {
      oldest: range.lower_ts,
      limit: this.options.pageLimit ?? SLACK_BACKFILL_PAGE_LIMIT,
      ...(thread.reply_cursor ? { cursor: thread.reply_cursor } : {}),
    });
    const replies = page.items.filter((message) => message.ts !== thread.thread_ts && message.ts < range.upper_ts);
    const inserts = await this.buildInserts(range, replies, thread.thread_ts);
    await this.options.db.transaction().execute(async (trx) => {
      const captured = await this.insertAll(trx, inserts);
      const ranges = createSlackBackfillRangeRepository(trx);
      await ranges.advanceHistoryCursor({ id: range.id, cursor: range.history_cursor, fetched: captured, now: nowIso });
      if (page.nextCursor) await ranges.advanceThreadCursor({ id: thread.id, cursor: page.nextCursor, now: nowIso });
      else await ranges.completeThread(thread.id, nowIso);
    });
    return true;
  }

  /**
   * Sender-name resolution hits the Slack API, so the whole page is mapped
   * before the write transaction opens and the transaction stays local.
   *
   * `conversations.history` echoes `thread_ts === ts` on a thread parent; that
   * is a top-level row, so the parent's own ts is dropped and only real replies
   * carry a thread id.
   */
  private async buildInserts(
    range: SlackBackfillRangeRow,
    messages: SlackHistoryMessage[],
    threadTs: string | null,
  ): Promise<ConversationMessageInsert[]> {
    const botUserId = this.options.getBotUserId?.() ?? null;
    const inserts: ConversationMessageInsert[] = [];
    for (const message of messages) {
      if (!isCapturableHistoryMessage(message)) continue;
      const messageThreadTs = threadTs ?? (message.threadTs === message.ts ? null : message.threadTs) ?? null;
      const insert =
        botUserId !== null && message.userId === botUserId
          ? mapSlackBotReplyToInsert({
              conversationId: range.conversation_id,
              messageRef: message.ts,
              text: message.text,
              threadTs: messageThreadTs,
              source: "history",
              backfillRangeId: range.id,
            })
          : mapSlackMessageToInsert(
              {
                ts: message.ts,
                userId: message.userId,
                botId: message.botId,
                text: message.text,
                threadTs: messageThreadTs,
              },
              {
                conversationId: range.conversation_id,
                senderName: await this.resolveSenderName(message),
                addressedToSketch: false,
                hasAttachments: message.hasFiles,
                source: "history",
                backfillRangeId: range.id,
              },
            );
      inserts.push(insert);
    }
    return inserts;
  }

  private async insertAll(
    trx: Parameters<typeof createConversationRepository>[0],
    inserts: ConversationMessageInsert[],
  ) {
    const conversations = createConversationRepository(trx);
    let captured = 0;
    for (const insert of inserts) {
      const result = await conversations.insertMessage(insert);
      if (result.inserted) captured += 1;
    }
    return captured;
  }

  private async resolveSenderName(message: SlackHistoryMessage): Promise<string> {
    if (!message.userId) return message.botId ?? "unknown";
    try {
      const user = await this.options.facade.getUserInfo(message.userId);
      return user.displayName || user.realName || user.name;
    } catch {
      return message.userId;
    }
  }
}
