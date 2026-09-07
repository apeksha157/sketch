import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { ChunkEngineKnobs, ChunkStreamAdapter } from "./chunk-engine";
import { runStreamTick } from "./chunk-engine-runner";
import { createSlackChannelChunkAdapter } from "./slack-chunk-adapters";

const now = new Date("2026-09-07T02:00:00.000Z");
const insideTickAttempt = "2026-09-07T01:50:00.000Z";
const knobs: ChunkEngineKnobs = {
  windowMessages: 2,
  windowTokens: 7_500,
  minMessages: 1,
  targetMessages: 2,
  maxMessages: 10,
  maxTokens: 1_500,
  tickMinutes: 30,
  idleCloseHours: 96,
  provisionalRefreshMessages: 20,
  model: null,
  reasoningEffort: "high",
  burstThresholdMessages: 2,
  topicRegistryCap: 30,
  groupWorkerPool: 2,
  maxWindowsPerRun: 1,
};

describe("shared chunk stream tick", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedStream(input: { providerId: string; messages: number; lastAttemptAt?: string }): Promise<number> {
    const repo = createConversationRepository(db);
    const conversation = await repo.getOrCreate({
      platform: "slack",
      kind: "channel",
      providerConversationId: input.providerId,
    });
    for (let index = 0; index < input.messages; index += 1) {
      await repo.insertMessage({
        conversationId: conversation.id,
        providerMessageId: `${input.providerId}-${index}`,
        senderJid: `U${index}`,
        senderName: `Sender ${index}`,
        text: `message ${index}`,
        providerThreadId: `${input.providerId}-${index}`,
        providerTimestamp: new Date(now.getTime() + index * 60_000).toISOString(),
        receivedAt: new Date(now.getTime() + index * 60_000).toISOString(),
      });
    }
    await db
      .insertInto("conversation_slice_stream_cursors")
      .values({
        conversation_id: conversation.id,
        stream_key: "channel",
        pending_since: "2026-09-07T01:00:00.000Z",
        llm_last_attempt_at: input.lastAttemptAt ?? null,
      })
      .execute();
    return conversation.id;
  }

  function tickOptions(
    conversationId: number,
    overrides: {
      generate: () => Promise<string>;
      hasGenerator?: boolean;
      readLastAttempt?: () => Promise<string | null>;
      stampAttempt?: (claim: { claimToken: string | null }) => Promise<void>;
    },
  ) {
    return {
      db,
      logger: createTestLogger(),
      now,
      adapter: createSlackChannelChunkAdapter({ conversationId, knobs }),
      generate: overrides.generate,
      llmGated: true,
      hasGenerator: overrides.hasGenerator ?? true,
      maxWindows: knobs.maxWindowsPerRun,
      readLastAttempt: overrides.readLastAttempt ?? (async () => null),
      stampAttempt: overrides.stampAttempt ?? (async () => {}),
      stampWhen: "on_claim" as const,
      logContext: { conversationId },
      failureMessage: "test chunk stream failed",
      backoffMessage: "test chunk provider backoff",
    };
  }

  const validBoundary = async () => JSON.stringify({ segments: [{ start: 1, end: 2, threads: ["topic"] }] });

  it("skips inside the tick window when the burst threshold is not met", async () => {
    const conversationId = await seedStream({ providerId: "C-gate", messages: 1 });
    const generate = vi.fn(validBoundary);
    const stampAttempt = vi.fn(async () => {});

    const result = await runStreamTick(
      tickOptions(conversationId, {
        generate,
        readLastAttempt: async () => insideTickAttempt,
        stampAttempt,
      }),
    );

    expect(result.tickSkipped).toBe(true);
    expect(result.pendingRemaining).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(stampAttempt).not.toHaveBeenCalled();
  });

  it("runs inside the tick window once the burst threshold is met", async () => {
    const conversationId = await seedStream({ providerId: "C-burst", messages: 2 });
    const generate = vi.fn(validBoundary);
    const stampAttempt = vi.fn(async () => {});

    const result = await runStreamTick(
      tickOptions(conversationId, {
        generate,
        readLastAttempt: async () => insideTickAttempt,
        stampAttempt,
      }),
    );

    expect(result.tickSkipped).toBe(false);
    expect(result.failed).toBe(false);
    expect(generate).toHaveBeenCalled();
    expect(stampAttempt).toHaveBeenCalledTimes(1);
  });

  it("never stamps an attempt without a generator", async () => {
    const conversationId = await seedStream({ providerId: "C-no-generator", messages: 2 });
    const generate = vi.fn(validBoundary);
    const stampAttempt = vi.fn(async () => {});

    const result = await runStreamTick(tickOptions(conversationId, { generate, hasGenerator: false, stampAttempt }));

    expect(result.skippedReason).toBe("no_generator");
    expect(result.pendingRemaining).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(stampAttempt).not.toHaveBeenCalled();
  });

  function failingAdapter(
    conversationId: number,
    failures: number,
  ): { adapter: ChunkStreamAdapter; calls: () => number } {
    const adapter = createSlackChannelChunkAdapter({ conversationId, knobs });
    let calls = 0;
    return {
      adapter: {
        ...adapter,
        loadOpenAndPending: async (...args) => {
          calls += 1;
          if (calls <= failures) throw new Error("rate limit exceeded");
          return adapter.loadOpenAndPending(...args);
        },
      },
      calls: () => calls,
    };
  }

  it("retries a transient provider error and then succeeds", async () => {
    const conversationId = await seedStream({ providerId: "C-retry", messages: 2 });
    const failing = failingAdapter(conversationId, 1);
    const generate = vi.fn(validBoundary);

    const result = await runStreamTick({ ...tickOptions(conversationId, { generate }), adapter: failing.adapter });

    expect(failing.calls()).toBe(2);
    expect(result.failed).toBe(false);
    expect(result.windowsProcessed).toBeGreaterThan(0);
  });

  it("counts an exhausted provider backoff as one stream failure", async () => {
    const conversationId = await seedStream({ providerId: "C-exhausted", messages: 2 });
    const failing = failingAdapter(conversationId, Number.POSITIVE_INFINITY);
    const generate = vi.fn(validBoundary);

    const result = await runStreamTick({ ...tickOptions(conversationId, { generate }), adapter: failing.adapter });

    expect(failing.calls()).toBe(3);
    expect(result.failed).toBe(true);
    expect(result.windowsProcessed).toBe(0);
    expect(result.pendingRemaining).toBe(true);
  });

  it("counts a gate failure once instead of letting it escape the tick", async () => {
    const conversationId = await seedStream({ providerId: "C-gate-fault", messages: 2 });
    const failing = failingAdapter(conversationId, Number.POSITIVE_INFINITY);
    const generate = vi.fn(validBoundary);
    const stampAttempt = vi.fn(async () => {});

    const result = await runStreamTick({
      ...tickOptions(conversationId, {
        generate,
        readLastAttempt: async () => insideTickAttempt,
        stampAttempt,
      }),
      adapter: failing.adapter,
    });

    expect(failing.calls()).toBe(1);
    expect(result.failed).toBe(true);
    expect(result.tickSkipped).toBe(false);
    expect(result.pendingRemaining).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(stampAttempt).not.toHaveBeenCalled();
  });
});
