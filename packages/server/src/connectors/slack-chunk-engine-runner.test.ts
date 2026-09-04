import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { ChunkEngineKnobs } from "./chunk-engine";
import { runSlackChunkStream } from "./slack-chunk-engine-runner";

const now = new Date("2026-09-05T02:00:00.000Z");
const channelKnobs: ChunkEngineKnobs = {
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

describe("Slack chunk engine runner", () => {
  let db!: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedStream(input: {
    providerId: string;
    messages: number;
    pendingSince?: string;
    lastAttemptAt?: string | null;
  }): Promise<number> {
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
        pending_since: input.pendingSince ?? "2026-09-05T01:00:00.000Z",
        llm_last_attempt_at: input.lastAttemptAt ?? null,
      })
      .execute();
    return conversation.id;
  }

  const validBoundary = async () => JSON.stringify({ segments: [{ start: 1, end: 2, threads: ["topic"] }] });

  it("skips inside the tick, runs on burst, and never timestamps without a generator", async () => {
    const recent = "2026-09-05T01:50:00.000Z";
    const skippedId = await seedStream({ providerId: "C-skip", messages: 1, lastAttemptAt: recent });
    const skippedGenerate = vi.fn(validBoundary);
    const skipped = await runSlackChunkStream({
      db,
      logger: createTestLogger(),
      now,
      conversationId: skippedId,
      streamKey: "channel",
      knobs: channelKnobs,
      generate: skippedGenerate,
    });
    expect(skipped.tickSkipped).toBe(true);
    expect(skippedGenerate).not.toHaveBeenCalled();

    const burstId = await seedStream({ providerId: "C-burst", messages: 2, lastAttemptAt: recent });
    const burstGenerate = vi.fn(validBoundary);
    const burst = await runSlackChunkStream({
      db,
      logger: createTestLogger(),
      now,
      conversationId: burstId,
      streamKey: "channel",
      knobs: channelKnobs,
      generate: burstGenerate,
    });
    expect(burst.tickSkipped).toBe(false);
    expect(burstGenerate).toHaveBeenCalled();
    expect(
      (
        await db
          .selectFrom("conversation_slice_stream_cursors")
          .select("llm_last_attempt_at")
          .where("conversation_id", "=", burstId)
          .where("stream_key", "=", "channel")
          .executeTakeFirstOrThrow()
      ).llm_last_attempt_at,
    ).toBe(now.toISOString());

    const disabledId = await seedStream({ providerId: "C-disabled", messages: 2 });
    const disabled = await runSlackChunkStream({
      db,
      logger: createTestLogger(),
      now,
      conversationId: disabledId,
      streamKey: "channel",
      knobs: channelKnobs,
      generate: undefined,
    });
    const disabledCursor = await db
      .selectFrom("conversation_slice_stream_cursors")
      .select(["pending_since", "llm_last_attempt_at"])
      .where("conversation_id", "=", disabledId)
      .where("stream_key", "=", "channel")
      .executeTakeFirstOrThrow();
    expect(disabled.skippedReason).toBe("no_generator");
    expect(disabledCursor.llm_last_attempt_at).toBeNull();
    expect(disabledCursor.pending_since).not.toBeNull();
  });

  it("clears only a drained pass and keeps pending work on failure or budget exhaustion", async () => {
    const drainedId = await seedStream({ providerId: "C-drained", messages: 0 });
    await runSlackChunkStream({
      db,
      logger: createTestLogger(),
      now,
      conversationId: drainedId,
      streamKey: "channel",
      knobs: channelKnobs,
      generate: validBoundary,
    });
    const drained = await db
      .selectFrom("conversation_slice_stream_cursors")
      .select("pending_since")
      .where("conversation_id", "=", drainedId)
      .where("stream_key", "=", "channel")
      .executeTakeFirstOrThrow();
    expect(drained.pending_since).toBeNull();

    const failedId = await seedStream({ providerId: "C-failed", messages: 2 });
    const failed = await runSlackChunkStream({
      db,
      logger: createTestLogger(),
      now,
      conversationId: failedId,
      streamKey: "channel",
      knobs: channelKnobs,
      generate: async () => "invalid",
    });
    expect(failed.skippedReason).toBe("boundary_validation_failed");

    const budgetId = await seedStream({ providerId: "C-budget", messages: 3 });
    const budget = await runSlackChunkStream({
      db,
      logger: createTestLogger(),
      now,
      conversationId: budgetId,
      streamKey: "channel",
      knobs: channelKnobs,
      generate: validBoundary,
    });
    const retained = await db
      .selectFrom("conversation_slice_stream_cursors")
      .select(["conversation_id", "pending_since"])
      .where("conversation_id", "in", [failedId, budgetId])
      .orderBy("conversation_id")
      .execute();
    expect(budget.pendingRemaining).toBe(true);
    expect(retained.every((row) => row.pending_since !== null)).toBe(true);
  });

  it("preserves pending_since when discovery resets it during the pass", async () => {
    const conversationId = await seedStream({ providerId: "C-reset", messages: 2 });
    const resetAt = "2026-09-05T02:01:00.000Z";

    await runSlackChunkStream({
      db,
      logger: createTestLogger(),
      now,
      conversationId,
      streamKey: "channel",
      knobs: { ...channelKnobs, maxWindowsPerRun: 2 },
      generate: async () => {
        await db
          .updateTable("conversation_slice_stream_cursors")
          .set({ pending_since: resetAt })
          .where("conversation_id", "=", conversationId)
          .where("stream_key", "=", "channel")
          .execute();
        return validBoundary();
      },
    });

    const cursor = await db
      .selectFrom("conversation_slice_stream_cursors")
      .select("pending_since")
      .where("conversation_id", "=", conversationId)
      .where("stream_key", "=", "channel")
      .executeTakeFirstOrThrow();
    expect(cursor.pending_since).toBe(resetAt);
  });
});
