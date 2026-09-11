import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createConversationRepository } from "../db/repositories/conversations";
import { createSlackBackfillRangeRepository } from "../db/repositories/slack-backfill-ranges";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";
import { createTestDb, createTestLogger } from "../test-utils";
import { SLACK_BACKFILL_GRAPH_SYNC_INTERVAL_MS, SlackBackfillWorker, slackTsFromMs } from "./backfill-worker";
import type { SlackHistoryMessage, SlackIndexingFacade, SlackIndexingPage } from "./indexing-facade";

const NOW_MS = Date.parse("2026-09-11T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;
const CHANNEL = "C500";

function tsDaysAgo(days: number): string {
  return slackTsFromMs(NOW_MS - days * DAY_MS);
}

function historyMessage(overrides: Partial<SlackHistoryMessage> & { ts: string }): SlackHistoryMessage {
  return {
    userId: "U1",
    botId: null,
    text: `message ${overrides.ts}`,
    threadTs: null,
    subtype: null,
    replyCount: 0,
    hasFiles: false,
    ...overrides,
  };
}

interface FakeSlack {
  facade: SlackIndexingFacade;
  historyCalls: Array<{ cursor?: string }>;
  replyCalls: Array<{ threadTs: string; cursor?: string }>;
}

function createFakeSlack(input: {
  historyPages: Array<SlackIndexingPage<SlackHistoryMessage>>;
  replyPages?: Record<string, Array<SlackIndexingPage<SlackHistoryMessage>>>;
  channels?: string[];
  failHistoryAfter?: number;
}): FakeSlack {
  const historyCalls: Array<{ cursor?: string }> = [];
  const replyCalls: Array<{ threadTs: string; cursor?: string }> = [];
  let historyIndex = 0;
  const replyIndex = new Map<string, number>();
  const channels = (input.channels ?? [CHANNEL]).map((id) => ({ id, name: `name-${id}`, isMember: true }));
  const facade = {
    isConfigured: async () => true,
    iterateUsers: async function* () {},
    iterateChannels: async function* () {
      yield* channels;
    },
    iterateChannelMembers: async function* () {},
    listUsers: async () => [],
    listChannels: async () => channels,
    listMemberChannels: async () => channels,
    listChannelMembers: async () => [],
    getUserInfo: async (userId: string) => ({
      slackUserId: userId,
      name: userId,
      realName: userId,
      displayName: `User ${userId}`,
      email: null,
      phone: null,
      isBot: false,
    }),
    listChannelHistoryPage: async (_channelId: string, options: { cursor?: string }) => {
      if (input.failHistoryAfter !== undefined && historyCalls.length >= input.failHistoryAfter) {
        throw new Error("slack_unavailable");
      }
      historyCalls.push({ ...(options.cursor ? { cursor: options.cursor } : {}) });
      const page = input.historyPages[historyIndex] ?? { items: [], nextCursor: null };
      historyIndex += 1;
      return page;
    },
    listThreadRepliesPage: async (_channelId: string, threadTs: string, options: { cursor?: string }) => {
      replyCalls.push({ threadTs, ...(options.cursor ? { cursor: options.cursor } : {}) });
      const pages = input.replyPages?.[threadTs] ?? [];
      const index = replyIndex.get(threadTs) ?? 0;
      replyIndex.set(threadTs, index + 1);
      return pages[index] ?? { items: [], nextCursor: null };
    },
  } as unknown as SlackIndexingFacade;
  return { facade, historyCalls, replyCalls };
}

function createWorker(
  db: Kysely<DB>,
  facade: SlackIndexingFacade,
  overrides: {
    getBotUserId?: () => string | null;
    logger?: Logger;
    requestSlackSync?: () => Promise<void>;
    now?: () => number;
  } = {},
): SlackBackfillWorker {
  return new SlackBackfillWorker({
    db,
    logger: overrides.logger ?? createTestLogger(),
    facade,
    now: overrides.now ?? (() => NOW_MS),
    tickMs: 1_000_000,
    ...(overrides.getBotUserId ? { getBotUserId: overrides.getBotUserId } : {}),
    ...(overrides.requestSlackSync ? { requestSlackSync: overrides.requestSlackSync } : {}),
  });
}

async function setLookbackDays(db: Kysely<DB>, historyLookbackDays: number): Promise<void> {
  const admin = await createUserRepository(db).create({ name: "admin", email: "admin@test.com", authRole: "admin" });
  await createConnectorRepository(db).createConfig({
    connectorType: "slack",
    authType: "system",
    credentials: JSON.stringify({ type: "system" }),
    scopeConfig: JSON.stringify({ historyLookbackDays }),
    createdBy: admin.id,
  });
}

describe("Slack history backfill worker", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  }, 30_000);

  afterEach(async () => {
    await db.destroy();
  });

  it("pages history, queues threads, skips the parent echo and post-upper replies", async () => {
    const parent = tsDaysAgo(10);
    const slack = createFakeSlack({
      historyPages: [
        { items: [historyMessage({ ts: tsDaysAgo(3) })], nextCursor: "cursor-1" },
        { items: [historyMessage({ ts: parent, replyCount: 2 })], nextCursor: null },
      ],
      replyPages: {
        [parent]: [
          {
            items: [
              historyMessage({ ts: parent, replyCount: 2 }),
              historyMessage({ ts: tsDaysAgo(9), threadTs: parent }),
              historyMessage({ ts: slackTsFromMs(NOW_MS + 60_000), threadTs: parent }),
            ],
            nextCursor: null,
          },
        ],
      },
    });
    const worker = createWorker(db, slack.facade);
    worker.start();
    await worker.reconcile();
    await worker.kick();
    await worker.stop();

    const ranges = createSlackBackfillRangeRepository(db);
    const [range] = await db.selectFrom("slack_backfill_ranges").selectAll().execute();
    expect(range?.kind).toEqual("initial");
    expect(range?.phase).toEqual("fetched");
    expect(slack.historyCalls).toEqual([{}, { cursor: "cursor-1" }]);
    expect(slack.replyCalls).toEqual([{ threadTs: parent }]);

    const rows = await db
      .selectFrom("conversation_messages")
      .select(["provider_message_id", "source", "backfill_range_id", "addressed_to_sketch"])
      .orderBy("provider_message_id")
      .execute();
    expect(rows.map((row) => row.provider_message_id).sort()).toEqual([parent, tsDaysAgo(9), tsDaysAgo(3)].sort());
    expect(rows.every((row) => row.source === "history" && row.backfill_range_id === range?.id)).toBe(true);
    expect(rows.every((row) => row.addressed_to_sketch === 0)).toBe(true);
    expect(await ranges.nextPendingThread(range?.id ?? "")).toBeUndefined();
  });

  it("resumes from the last committed page after a crash mid-fetch", async () => {
    const failing = createFakeSlack({
      historyPages: [
        { items: [historyMessage({ ts: tsDaysAgo(3) })], nextCursor: "cursor-1" },
        { items: [], nextCursor: null },
      ],
      failHistoryAfter: 1,
    });
    const first = createWorker(db, failing.facade);
    first.start();
    await first.reconcile();
    await first.kick();
    await first.stop();

    const midway = await db.selectFrom("slack_backfill_ranges").selectAll().executeTakeFirstOrThrow();
    expect(midway.history_cursor).toEqual("cursor-1");
    expect(midway.phase).toEqual("fetching_history");
    expect(midway.attempts).toEqual(1);

    await db.updateTable("slack_backfill_ranges").set({ next_retry_at: null }).execute();
    const resuming = createFakeSlack({
      historyPages: [{ items: [historyMessage({ ts: tsDaysAgo(5) })], nextCursor: null }],
    });
    const second = createWorker(db, resuming.facade);
    second.start();
    await second.kick();
    await second.stop();

    expect(resuming.historyCalls).toEqual([{ cursor: "cursor-1" }]);
    const rows = await db.selectFrom("conversation_messages").select("provider_message_id").execute();
    expect(rows.map((row) => row.provider_message_id).sort()).toEqual([tsDaysAgo(5), tsDaysAgo(3)].sort());
    const final = await db.selectFrom("slack_backfill_ranges").selectAll().executeTakeFirstOrThrow();
    expect(final.phase).toEqual("fetched");
  });

  it("derives initial bounds on first join and gap bounds on a rejoin without duplicating rows", async () => {
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "slack",
      kind: "channel",
      providerConversationId: CHANNEL,
    });
    const liveTs = tsDaysAgo(10);
    await createConversationRepository(db).insertMessage({
      conversationId: conversation.id,
      providerMessageId: liveTs,
      senderJid: "U1",
      senderName: "Asha",
      text: "captured live",
      providerThreadId: liveTs,
      providerTimestamp: new Date(Number(liveTs) * 1000).toISOString(),
    });

    const slack = createFakeSlack({
      historyPages: [
        {
          items: [historyMessage({ ts: liveTs, text: "captured live" }), historyMessage({ ts: tsDaysAgo(4) })],
          nextCursor: null,
        },
      ],
    });
    const worker = createWorker(db, slack.facade);
    const range = await worker.handleBotJoinedChannel(CHANNEL);
    expect(range?.kind).toEqual("gap");
    expect(range?.lower_ts).toEqual(liveTs);
    expect(range?.upper_ts).toEqual(slackTsFromMs(NOW_MS));

    worker.start();
    await worker.reconcile();
    await worker.kick();
    await worker.stop();

    const rows = await db
      .selectFrom("conversation_messages")
      .select(["provider_message_id", "source"])
      .orderBy("provider_message_id")
      .execute();
    expect(rows.sort((a, b) => a.provider_message_id.localeCompare(b.provider_message_id))).toEqual(
      [
        { provider_message_id: liveTs, source: "live" },
        { provider_message_id: tsDaysAgo(4), source: "history" },
      ].sort((a, b) => a.provider_message_id.localeCompare(b.provider_message_id)),
    );
  });

  it("creates an initial range at startup only for a member channel with no rows and no ranges", async () => {
    const withRows = "C-with-rows";
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "slack",
      kind: "channel",
      providerConversationId: withRows,
    });
    await createConversationRepository(db).insertMessage({
      conversationId: conversation.id,
      providerMessageId: tsDaysAgo(10),
      senderJid: "U1",
      senderName: "Asha",
      text: "pre-existing",
    });
    const slack = createFakeSlack({ historyPages: [], channels: [CHANNEL, withRows] });
    const worker = createWorker(db, slack.facade);
    const result = await worker.reconcile();
    expect(result).toMatchObject({ initial: 1, gap: 0 });
    const ranges = await db.selectFrom("slack_backfill_ranges").select(["channel_id", "kind", "lower_ts"]).execute();
    expect(ranges).toEqual([
      {
        channel_id: CHANNEL,
        kind: "initial",
        lower_ts: slackTsFromMs(NOW_MS - 365 * 24 * 60 * 60_000),
      },
    ]);
  });

  it("waits for the Slack bot user id before stepping a range, then maps Sketch's own post to the bot identity", async () => {
    const botUserId = "UBOT";
    let currentBotUserId: string | null = null;
    const slack = createFakeSlack({
      historyPages: [
        {
          items: [historyMessage({ ts: tsDaysAgo(3), userId: botUserId, text: "Sketch said this" })],
          nextCursor: null,
        },
      ],
    });
    const worker = createWorker(db, slack.facade, { getBotUserId: () => currentBotUserId });
    worker.start();
    await worker.reconcile();
    await worker.kick();

    const deferred = await db.selectFrom("slack_backfill_ranges").selectAll().executeTakeFirstOrThrow();
    expect(deferred.phase).toEqual("pending");
    expect(slack.historyCalls).toEqual([]);
    expect(await db.selectFrom("conversation_messages").selectAll().execute()).toEqual([]);

    currentBotUserId = botUserId;
    await worker.kick();
    await worker.stop();

    const rows = await db.selectFrom("conversation_messages").select(["sender_jid", "is_bot"]).execute();
    expect(rows).toEqual([{ sender_jid: "bot", is_bot: 1 }]);
  });

  it("treats a history thread parent as a channel row, not a reply", async () => {
    const parent = tsDaysAgo(6);
    const slack = createFakeSlack({
      historyPages: [{ items: [historyMessage({ ts: parent, threadTs: parent, replyCount: 0 })], nextCursor: null }],
    });
    const worker = createWorker(db, slack.facade);
    worker.start();
    await worker.reconcile();
    await worker.kick();
    await worker.stop();

    const rows = await db
      .selectFrom("conversation_messages")
      .select(["provider_message_id", "is_thread_reply", "provider_thread_id"])
      .execute();
    expect(rows).toEqual([{ provider_message_id: parent, is_thread_reply: 0, provider_thread_id: parent }]);
  });

  it("warns with no content when the indexing facade cannot page channel history", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (payload: Record<string, unknown>) => warnings.push(payload),
      error: () => {},
    } as unknown as Logger;
    const slack = createFakeSlack({ historyPages: [] });
    const facade = { ...slack.facade, listChannelHistoryPage: undefined } as unknown as SlackIndexingFacade;
    const worker = createWorker(db, facade, { logger });
    worker.start();
    await worker.reconcile();
    await worker.kick();
    await worker.stop();

    const range = await db.selectFrom("slack_backfill_ranges").selectAll().executeTakeFirstOrThrow();
    expect(warnings.length).toBeGreaterThan(0);
    expect(
      warnings.every((entry) => JSON.stringify(entry) === JSON.stringify({ rangeId: range.id, channelId: CHANNEL })),
    ).toBe(true);
  });

  it("queues a manual range per member channel and skips channels with a running range", async () => {
    const other = "C-other";
    const slack = createFakeSlack({ historyPages: [], channels: [CHANNEL, other] });
    const worker = createWorker(db, slack.facade);
    await worker.handleBotJoinedChannel(CHANNEL);
    const queued = await worker.queueManualBackfill();
    expect(queued).toEqual({ channelsQueued: 1, channelsSkipped: 1 });
    const manual = await db
      .selectFrom("slack_backfill_ranges")
      .select(["channel_id", "kind"])
      .where("kind", "=", "manual")
      .execute();
    expect(manual).toEqual([{ channel_id: other, kind: "manual" }]);
  });

  it("creates no ranges anywhere when the lookback is 0 days, and a join still requests one sync", async () => {
    await setLookbackDays(db, 0);
    let syncRequests = 0;
    const slack = createFakeSlack({ historyPages: [], channels: [CHANNEL, "C-other"] });
    const worker = createWorker(db, slack.facade, {
      requestSlackSync: async () => {
        syncRequests += 1;
      },
    });

    expect(await worker.reconcile()).toMatchObject({ initial: 0, gap: 0 });
    expect(await worker.handleBotJoinedChannel(CHANNEL)).toBeNull();
    expect(await worker.queueManualBackfill()).toEqual({ channelsQueued: 0, channelsSkipped: 0 });

    expect(await db.selectFrom("slack_backfill_ranges").selectAll().execute()).toEqual([]);
    expect(syncRequests).toBe(1);
  });

  it("stores the channel name when a join creates the conversation, and never renames an existing one", async () => {
    const slack = createFakeSlack({ historyPages: [], channels: [CHANNEL, "C-known"] });
    await createConversationRepository(db).getOrCreate(
      { platform: "slack", kind: "channel", providerConversationId: "C-known" },
      "old-name",
    );
    const worker = createWorker(db, slack.facade);

    await worker.handleBotJoinedChannel(CHANNEL);
    await worker.handleBotJoinedChannel("C-known");

    const names = await db
      .selectFrom("conversations")
      .select(["provider_conversation_id", "display_name"])
      .orderBy("provider_conversation_id")
      .execute();
    expect(names).toEqual([
      { provider_conversation_id: "C-known", display_name: "old-name" },
      { provider_conversation_id: CHANNEL, display_name: `name-${CHANNEL}` },
    ]);
  });

  it("requests a Slack sync once a joined channel's range is fetched, at most once per interval", async () => {
    let nowMs = NOW_MS;
    let syncRequests = 0;
    const slack = createFakeSlack({
      historyPages: [{ items: [historyMessage({ ts: tsDaysAgo(3) })], nextCursor: null }],
    });
    const worker = createWorker(db, slack.facade, {
      now: () => nowMs,
      requestSlackSync: async () => {
        syncRequests += 1;
      },
    });
    worker.start();
    await worker.handleBotJoinedChannel(CHANNEL);
    await worker.kick();
    const range = await db.selectFrom("slack_backfill_ranges").selectAll().executeTakeFirstOrThrow();
    expect(range.phase).toEqual("fetched");
    expect(syncRequests).toBe(1);

    await worker.kick();
    expect(syncRequests).toBe(1);

    nowMs += SLACK_BACKFILL_GRAPH_SYNC_INTERVAL_MS;
    await worker.kick();
    await worker.stop();
    expect(syncRequests).toBe(2);
  });
});
