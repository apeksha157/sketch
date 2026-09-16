import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentOutputRepository } from "../../db/repositories/agent-outputs";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import type { QueueManager } from "../../queue";
import { createTestDb, createTestLogger } from "../../test-utils";
import { DAILY_BRIEF_AGENT_KEY, DAILY_BRIEF_AGENT_VERSION } from "../definitions/daily-brief";
import { AgentOutputRunQueue } from "./queue";
import { NOW, OUTPUT_DATE, createPausedQueueManager } from "./test-helpers";

describe("AgentOutputRunQueue liveness", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.destroy();
  });

  it("keeps liveness continuous while a scheduled run is promoted", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const output = (
      await createAgentOutputRepository(db).createRunning({
        agentKey: DAILY_BRIEF_AGENT_KEY,
        agentVersion: DAILY_BRIEF_AGENT_VERSION,
        userId: user.id,
        outputDate: OUTPUT_DATE,
        timezone: "UTC",
        triggerType: "scheduled",
      })
    ).row;
    let releasePromotion!: () => void;
    const promotionGate = new Promise<void>((resolve) => {
      releasePromotion = resolve;
    });
    let releaseManualRun!: () => void;
    const manualRunGate = new Promise<void>((resolve) => {
      releaseManualRun = resolve;
    });
    let manualRunStarted = false;
    const queue = new AgentOutputRunQueue({
      logger: createTestLogger(),
      queueManager: createPausedQueueManager(tasks),
      repo: {
        findById: vi.fn(async () => output),
        promoteRunningToManual: vi.fn(async () => {
          await promotionGate;
          return { ...output, trigger_type: "manual" };
        }),
      },
      run: vi.fn(async ({ scheduledAdmission }) => {
        if (scheduledAdmission?.controller.signal.aborted) return;
        manualRunStarted = true;
        await manualRunGate;
      }),
    });

    expect(
      queue.enqueue({
        agentKey: DAILY_BRIEF_AGENT_KEY,
        outputId: output.id,
        userId: user.id,
        triggerType: "scheduled",
      }),
    ).toBe(true);
    const promotion = queue.promoteScheduledToManual({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      output,
      userId: user.id,
    });

    expect(tasks).toHaveLength(2);
    expect(queue.hasLiveRun(output.id)).toBe(true);

    await tasks[0]();
    expect(queue.hasLiveRun(output.id)).toBe(true);

    releasePromotion();
    await promotion;
    const manualTask = tasks[1]();
    await vi.waitFor(() => expect(manualRunStarted).toBe(true));
    expect(queue.hasLiveRun(output.id)).toBe(true);

    releaseManualRun();
    await manualTask;
    expect(queue.hasLiveRun(output.id)).toBe(false);
  });

  it("keeps restored scheduled work live when manual promotion fails", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const output = (
      await createAgentOutputRepository(db).createRunning({
        agentKey: DAILY_BRIEF_AGENT_KEY,
        agentVersion: DAILY_BRIEF_AGENT_VERSION,
        userId: user.id,
        outputDate: OUTPUT_DATE,
        timezone: "UTC",
        triggerType: "scheduled",
      })
    ).row;
    let rejectPromotion!: (error: Error) => void;
    const promotionGate = new Promise<never>((_resolve, reject) => {
      rejectPromotion = reject;
    });
    const run = vi.fn(async () => {});
    const queue = new AgentOutputRunQueue({
      logger: createTestLogger(),
      queueManager: createPausedQueueManager(tasks),
      repo: {
        findById: vi.fn(async () => output),
        promoteRunningToManual: vi.fn(() => promotionGate),
      },
      run,
    });

    queue.enqueue({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      outputId: output.id,
      userId: user.id,
      triggerType: "scheduled",
    });
    const promotion = queue.promoteScheduledToManual({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      output,
      userId: user.id,
    });

    await tasks[0]();
    expect(queue.hasLiveRun(output.id)).toBe(true);

    rejectPromotion(new Error("promotion failed"));
    await expect(promotion).rejects.toThrow("promotion failed");
    expect(tasks).toHaveLength(3);

    await tasks[1]();
    expect(queue.hasLiveRun(output.id)).toBe(true);

    await tasks[2]();
    expect(queue.hasLiveRun(output.id)).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps a cancelled but still-executing scheduled task live until it settles", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const users = createUserRepository(db);
    const user = await users.create({ name: "Agent User", email: "user@example.com" });
    const output = (
      await createAgentOutputRepository(db).createRunning({
        agentKey: DAILY_BRIEF_AGENT_KEY,
        agentVersion: DAILY_BRIEF_AGENT_VERSION,
        userId: user.id,
        outputDate: OUTPUT_DATE,
        timezone: "UTC",
        triggerType: "scheduled",
      })
    ).row;
    let releaseScheduledRun!: () => void;
    const scheduledRunGate = new Promise<void>((resolve) => {
      releaseScheduledRun = resolve;
    });
    let scheduledRunStarted = false;
    const queue = new AgentOutputRunQueue({
      logger: createTestLogger(),
      queueManager: createPausedQueueManager(tasks),
      repo: {
        findById: vi.fn(async () => output),
        promoteRunningToManual: vi.fn(async () => ({ ...output, trigger_type: "manual" })),
      },
      run: vi.fn(async ({ scheduledAdmission }) => {
        if (!scheduledAdmission) return;
        scheduledRunStarted = true;
        await scheduledRunGate;
      }),
    });

    queue.enqueue({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      outputId: output.id,
      userId: user.id,
      triggerType: "scheduled",
    });
    await queue.promoteScheduledToManual({ agentKey: DAILY_BRIEF_AGENT_KEY, output, userId: user.id });
    expect(queue.hasLiveRun(output.id)).toBe(true);

    const cancelledRun = tasks[0]();
    await vi.waitFor(() => expect(scheduledRunStarted).toBe(true));
    expect(queue.hasLiveRun(output.id)).toBe(true);

    releaseScheduledRun();
    await cancelledRun;
    expect(queue.hasLiveRun(output.id)).toBe(true);

    await tasks[1]();
    expect(queue.hasLiveRun(output.id)).toBe(false);
  });

  it("releases liveness when the queue rejects a run", () => {
    const outputId = "rejected-output";
    const queue = new AgentOutputRunQueue({
      logger: createTestLogger(),
      queueManager: {
        getQueue: () => ({ enqueue: () => false }),
      } as unknown as QueueManager,
      repo: {
        findById: vi.fn(),
        promoteRunningToManual: vi.fn(),
      },
      run: vi.fn(),
    });

    expect(
      queue.enqueue({
        agentKey: DAILY_BRIEF_AGENT_KEY,
        outputId,
        userId: "user-id",
        triggerType: "manual",
      }),
    ).toBe(false);
    expect(queue.hasLiveRun(outputId)).toBe(false);
  });
});
