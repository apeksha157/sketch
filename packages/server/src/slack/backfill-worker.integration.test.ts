import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationRepository } from "../db/repositories/conversations";
import { createSlackBackfillRangeRepository } from "../db/repositories/slack-backfill-ranges";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { SlackBackfillWorker, slackTsFromMs } from "./backfill-worker";
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
  const facade = {
    isConfigured: async () => true,
    iterateUsers: async function* () {},
    iterateChannels: async function* () {},
    iterateChannelMembers: async function* () {},
    listUsers: async () => [],
    listChannels: async () => [],
    listMemberChannels: async () => (input.channels ?? [CHANNEL]).map((id) => ({ id, name: id, isMember: true })),
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

function createWorker(db: Kysely<DB>, facade: SlackIndexingFacade): SlackBackfillWorker {
  return new SlackBackfillWorker({
    db,
    logger: createTestLogger(),
    facade,
    now: () => NOW_MS,
    tickMs: 1_000_000,
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
});
