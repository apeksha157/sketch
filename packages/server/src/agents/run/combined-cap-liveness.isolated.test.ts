import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunLimiter } from "../../agent/concurrency-limiter";
import {
  GeminiHttpError,
  GeminiUnavailableError,
  resetGeminiControlsForTests,
  runGeminiRequest,
} from "../../connectors/gemini-control";
import type { QueueManager } from "../../queue";
import { createTestLogger } from "../../test-utils";
import { AgentOutputRunQueue } from "./queue";
import { NOW } from "./test-helpers";

const MONTHLY_SPENDING_CAP_BODY = JSON.stringify({
  error: {
    code: 429,
    message: "Your project has exceeded its monthly spending cap.",
    status: "RESOURCE_EXHAUSTED",
  },
});

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * Queue/limiter component of the combined saturated-pool scenario: a shared
 * scheduled pool of capped briefs stays locally owned past the stale
 * threshold, stops provider traffic after one discovery, and admits a short
 * agent once the pool drains. The actual `AgentRunService` stale-check/reuse
 * and replacement path is covered by `queues.isolated.test.ts` and
 * `lifecycle.isolated.test.ts`.
 */
describe("combined capped-provider and live-output queue/limiter scenario", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetGeminiControlsForTests();
  });

  it("keeps capped briefs locally owned past the stale threshold and admits the short agent without amplification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetGeminiControlsForTests();

    const limiter = createAgentRunLimiter({ limit: 20, queue: "scheduled", logger: createTestLogger() });
    let clock = 0;
    let networkAttempts = 0;
    let shortAgentRan = false;
    let releaseCap!: () => void;
    let releaseSleeps!: () => void;
    const capGate = new Promise<void>((resolve) => {
      releaseCap = resolve;
    });
    const sleepGate = new Promise<void>((resolve) => {
      releaseSleeps = resolve;
    });

    const geminiOptions = {
      maxRpm: 60,
      maxRetries: 4,
      quotaIdentity: "q-combined",
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
        await sleepGate;
      },
    };

    const tasks: Array<() => Promise<void>> = [];
    const queue = new AgentOutputRunQueue({
      logger: createTestLogger(),
      queueManager: {
        getQueue: () => ({
          enqueue: (task: () => Promise<void>) => {
            tasks.push(() => limiter.run(task));
            return true;
          },
        }),
      } as unknown as QueueManager,
      repo: {
        findById: vi.fn(),
        promoteRunningToManual: vi.fn(),
      },
      run: async ({ outputId }) => {
        if (outputId === "short-output") {
          shortAgentRan = true;
          return;
        }
        await runGeminiRequest(
          "key-a",
          async () => {
            networkAttempts++;
            await capGate;
            throw new GeminiHttpError(429, MONTHLY_SPENDING_CAP_BODY);
          },
          geminiOptions,
        );
      },
    });

    const briefIds = Array.from({ length: 20 }, (_, index) => `brief-${index}`);
    for (const outputId of briefIds) {
      expect(
        queue.enqueue({
          agentKey: "daily-brief",
          outputId,
          userId: "user-1",
          triggerType: "scheduled",
        }),
      ).toBe(true);
    }
    expect(
      queue.enqueue({
        agentKey: "peer-review",
        outputId: "short-output",
        userId: "user-1",
        triggerType: "scheduled",
      }),
    ).toBe(true);
    expect(tasks).toHaveLength(21);

    const running = tasks.map((task) => task());
    await vi.waitFor(() => expect(networkAttempts).toBe(1));

    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60 * 1000));
    for (const outputId of briefIds) {
      expect(queue.hasLiveRun(outputId)).toBe(true);
    }
    expect(shortAgentRan).toBe(false);

    releaseCap();
    await flushMicrotasks();
    releaseSleeps();
    const results = await Promise.allSettled(running);

    const briefResults = results.slice(0, 20);
    const capDiscoveries = briefResults.filter(
      (result) => result.status === "rejected" && result.reason instanceof GeminiHttpError,
    );
    const cachedRefusals = briefResults.filter(
      (result) => result.status === "rejected" && result.reason instanceof GeminiUnavailableError,
    );
    expect(capDiscoveries).toHaveLength(1);
    expect(cachedRefusals).toHaveLength(19);
    expect(networkAttempts).toBe(1);
    expect(shortAgentRan).toBe(true);

    for (const outputId of [...briefIds, "short-output"]) {
      expect(queue.hasLiveRun(outputId)).toBe(false);
    }
    expect(limiter.snapshot()).toEqual({ limit: 20, active: 0, waiting: 0 });
  });
});
