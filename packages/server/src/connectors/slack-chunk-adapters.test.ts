import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../config";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { runChunkingPass } from "./chunk-engine";
import {
  createSlackChannelChunkAdapter,
  createSlackThreadChunkAdapter,
  renderSlackChunkMessageText,
  resolveSlackChunkEngineKnobs,
} from "./slack-chunk-adapters";
import { isIndexableSlackChunkMessage } from "./slack-chunk-messages";

const baseKnobs = {
  windowMessages: 250,
  windowTokens: 7500,
  minMessages: 1,
  targetMessages: 40,
  maxMessages: 80,
  maxTokens: 1500,
  tickMinutes: 30,
  idleCloseHours: 96,
  provisionalRefreshMessages: 20,
  model: null,
  reasoningEffort: "high" as const,
  burstThresholdMessages: null,
  topicRegistryCap: 30,
  groupWorkerPool: 4,
  maxWindowsPerRun: 8,
};

describe("Slack chunk adapters", () => {
  let db!: Kysely<DB>;
  let conversationId!: number;

  beforeEach(async () => {
    db = await createTestDb();
    const conversation = await createConversationRepository(db).getOrCreate({
      platform: "slack",
      kind: "channel",
      providerConversationId: "C-adapter",
    });
    conversationId = conversation.id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seed(count: number, threadTs?: string, timestamps?: string[]): Promise<void> {
    const repo = createConversationRepository(db);
    for (let index = 0; index < count; index += 1) {
      const timestamp =
        timestamps?.[index] ?? new Date(Date.parse("2026-09-01T09:00:00.000Z") + index * 60_000).toISOString();
      await repo.insertMessage({
        conversationId,
        providerMessageId: `${threadTs ?? "channel"}-${index}`,
        senderJid: `U${index}`,
        senderName: `Sender ${index}`,
        text: `message ${index}`,
        providerThreadId: threadTs ?? null,
        providerParentMessageId: threadTs ?? null,
        isThreadReply: Boolean(threadTs),
        providerTimestamp: timestamp,
        receivedAt: timestamp,
      });
    }
  }

  async function runThread(threadTs: string, maxMessages = 80) {
    const generate = vi.fn().mockRejectedValue(new Error("thread generation must not run"));
    const adapter = createSlackThreadChunkAdapter({
      conversationId,
      threadTs,
      knobs: { ...baseKnobs, maxMessages },
    });
    const result = await runChunkingPass(
      { db, logger: createTestLogger(), generate },
      { adapter, mode: "live", maxWindows: 1 },
    );
    return { result, generate };
  }

  it("keeps one- and multi-message threads as one open slice without generation", async () => {
    await seed(1, "thread-one");
    const one = await runThread("thread-one");
    await seed(3, "thread-many");
    const many = await runThread("thread-many");

    const slices = await db
      .selectFrom("conversation_slices")
      .select(["provider_thread_id", "first_message_id", "last_message_id", "message_count", "status"])
      .where("conversation_id", "=", conversationId)
      .orderBy("first_message_id")
      .execute();
    expect(one.generate).not.toHaveBeenCalled();
    expect(many.generate).not.toHaveBeenCalled();
    expect(one.result.windowsProcessed).toBe(1);
    expect(many.result.windowsProcessed).toBe(1);
    expect(slices).toEqual([
      expect.objectContaining({ provider_thread_id: "thread-one", message_count: 1, status: "open" }),
      expect.objectContaining({ provider_thread_id: "thread-many", message_count: 3, status: "open" }),
    ]);
  });

  it("force-splits a long thread into consecutive max-size slices", async () => {
    await seed(5, "thread-long");
    await runThread("thread-long", 2);

    const slices = await db
      .selectFrom("conversation_slices")
      .select(["provider_thread_id", "first_message_id", "last_message_id", "message_count", "flush_reason"])
      .where("conversation_id", "=", conversationId)
      .orderBy("first_message_id")
      .execute();
    expect(slices).toHaveLength(3);
    expect(slices.map((row) => row.provider_thread_id)).toEqual(["thread-long", "thread-long", "thread-long"]);
    expect(slices.map((row) => row.message_count)).toEqual([2, 2, 1]);
    expect(slices.map((row) => row.flush_reason)).toEqual(["max_size", "max_size", "gap"]);
    expect(slices[0]?.last_message_id).toBeLessThan(slices[1]?.first_message_id ?? 0);
    expect(slices[1]?.last_message_id).toBeLessThan(slices[2]?.first_message_id ?? 0);
  });

  it("uses min/max time for channel rows and scopes overlap checks by stream", async () => {
    await seed(3, undefined, ["2026-09-01T09:05:00.000Z", "2026-09-01T09:03:00.000Z", "2026-09-01T09:04:00.000Z"]);
    const generate = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ segments: [{ start: 1, end: 3, threads: ["topic"] }] }));
    const channel = createSlackChannelChunkAdapter({ conversationId, knobs: baseKnobs });
    await runChunkingPass(
      { db, logger: createTestLogger(), generate },
      { adapter: channel, mode: "live", maxWindows: 1 },
    );
    const channelSlice = await db
      .selectFrom("conversation_slices")
      .select(["started_at", "ended_at"])
      .where("conversation_id", "=", conversationId)
      .where("provider_thread_id", "is", null)
      .executeTakeFirstOrThrow();
    expect(channelSlice).toEqual({
      started_at: "2026-09-01T09:03:00.000Z",
      ended_at: "2026-09-01T09:05:00.000Z",
    });

    await seed(2, "thread-overlap");
    await db
      .updateTable("conversation_slices")
      .set({ last_message_id: 6 })
      .where("conversation_id", "=", conversationId)
      .where("provider_thread_id", "is", null)
      .execute();
    const ignored = await runThread("thread-overlap");
    expect(ignored.result.skippedReason).toBeUndefined();
    await db
      .updateTable("conversation_slice_stream_cursors")
      .set({ last_message_id: null })
      .where("conversation_id", "=", conversationId)
      .where("stream_key", "=", "thread-overlap")
      .execute();
    await db
      .updateTable("conversation_slices")
      .set({ status: "closed", last_message_id: 4, message_count: 1, denoised_message_ids: "[4]" })
      .where("conversation_id", "=", conversationId)
      .where("provider_thread_id", "=", "thread-overlap")
      .execute();
    const rejected = await runThread("thread-overlap");
    expect(rejected.result.skippedReason).toBe("overlap_guard");
  });

  it("bounds channel loading and renders attachment placeholders as shared files", async () => {
    for (let start = 0; start < 3000; start += 200) {
      await db
        .insertInto("conversation_messages")
        .values(
          Array.from({ length: 200 }, (_, offset) => ({
            conversation_id: conversationId,
            provider_message_id: `bulk-${start + offset}`,
            sender_name: "Bulk sender",
            text: `bulk message ${start + offset}`,
            received_at: "2026-09-01T09:00:00.000Z",
            source: "live",
            is_thread_reply: 0,
          })),
        )
        .execute();
    }
    const adapter = createSlackChannelChunkAdapter({ conversationId, knobs: baseKnobs });
    const loaded = await adapter.loadOpenAndPending(
      db,
      undefined,
      { lastEffectiveAt: null, lastMessageId: null, claimToken: null },
      100,
      { mode: "live" },
    );
    expect(loaded.pendingRaw).toHaveLength(150);
    expect(loaded.pageFull).toBe(true);
    const bounded = await adapter.loadOpenAndPending(
      db,
      undefined,
      { lastEffectiveAt: null, lastMessageId: null, claimToken: null },
      100,
      { mode: "live", pendingUntil: { effectiveAt: "ignored", id: 120 } },
    );
    expect(bounded.pendingRaw.at(-1)?.id).toBeLessThanOrEqual(120);

    const attachments = JSON.stringify([{ originalName: "roadmap.pdf", mimeType: "application/pdf" }]);
    const message = {
      id: 1,
      effectiveAt: "2026-09-01T09:00:00.000Z",
      text: "see attached files.",
      attachments,
      isBot: false,
    };
    expect(isIndexableSlackChunkMessage(message)).toBe(true);
    expect(renderSlackChunkMessageText(message.text, attachments)).toBe("[shared file: roadmap.pdf]");
    expect(renderSlackChunkMessageText(message.text, JSON.stringify([{ mimeType: "application/pdf" }]))).toBe(
      "[shared file]",
    );
  });

  it("renders attachment placeholders in channel boundary prompts", async () => {
    const repo = createConversationRepository(db);
    await repo.insertMessage({
      conversationId,
      providerMessageId: "channel-file",
      senderJid: "U-file",
      senderName: "File sender",
      text: "see attached files.",
      attachments: [
        { originalName: "roadmap.pdf", mimeType: "application/pdf", localPath: "/tmp/roadmap.pdf", sizeBytes: 1 },
      ],
      providerTimestamp: "2026-09-01T09:00:00.000Z",
      receivedAt: "2026-09-01T09:00:00.000Z",
    });
    await repo.insertMessage({
      conversationId,
      providerMessageId: "channel-text",
      senderJid: "U-text",
      senderName: "Text sender",
      text: "Please review the file",
      providerTimestamp: "2026-09-01T09:01:00.000Z",
      receivedAt: "2026-09-01T09:01:00.000Z",
    });
    const generate = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ segments: [{ start: 1, end: 2, threads: ["roadmap"] }] }));
    const channel = createSlackChannelChunkAdapter({ conversationId, knobs: baseKnobs });

    await runChunkingPass(
      { db, logger: createTestLogger(), generate },
      { adapter: channel, mode: "live", maxWindows: 1 },
    );

    expect(generate.mock.calls[0]?.[0]).toContain("[shared file: roadmap.pdf]");
    expect(generate.mock.calls[0]?.[0]).not.toContain("see attached files.");
  });

  it("keeps channel and thread slices open in the same conversation", async () => {
    await seed(1);
    await seed(1, "coexisting-thread");
    const channel = createSlackChannelChunkAdapter({ conversationId, knobs: baseKnobs });
    await runChunkingPass(
      {
        db,
        logger: createTestLogger(),
        generate: async () => JSON.stringify({ segments: [{ start: 1, end: 1, threads: ["channel"] }] }),
      },
      { adapter: channel, mode: "live", maxWindows: 1 },
    );
    await runThread("coexisting-thread");

    const rows = await db
      .selectFrom("conversation_slices")
      .select(["provider_thread_id", "status"])
      .where("conversation_id", "=", conversationId)
      .orderBy("provider_thread_id")
      .execute();
    expect(rows).toEqual([
      { provider_thread_id: null, status: "open" },
      { provider_thread_id: "coexisting-thread", status: "open" },
    ]);
  });

  it("resolves channel and thread knobs from environment config", () => {
    const config = configSchema.parse({
      SLACK_CHUNK_WINDOW_MESSAGES: 250,
      SLACK_CHUNK_WINDOW_TOKENS: 7500,
      SLACK_CHUNK_MIN_MESSAGES: 10,
      SLACK_CHUNK_TARGET_MESSAGES: 40,
      SLACK_CHUNK_MAX_MESSAGES: 80,
      SLACK_CHUNK_MAX_TOKENS: 1500,
      SLACK_THREAD_MIN_MESSAGES: 1,
      SLACK_CHUNK_TICK_MINUTES: 30,
      SLACK_CHUNK_IDLE_CLOSE_HOURS: 96,
      SLACK_CHUNK_PROVISIONAL_REFRESH_MESSAGES: 20,
      SLACK_CHUNK_MODEL: null,
      SLACK_CHUNK_REASONING_EFFORT: "high",
      SLACK_CHUNK_BURST_THRESHOLD_MESSAGES: null,
      SLACK_CHUNK_TOPIC_REGISTRY_CAP: 30,
      SLACK_CHUNK_CHANNEL_WORKER_POOL: 4,
      SLACK_CHUNK_MAX_WINDOWS_PER_RUN: 8,
    });
    const resolved = resolveSlackChunkEngineKnobs(config);
    expect(resolved.channel.minMessages).toBe(10);
    expect(resolved.thread.minMessages).toBe(1);
    expect(resolved.thread.maxMessages).toBe(80);
  });
});
