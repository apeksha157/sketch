import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutomationDraft } from "../automation/persistence";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestConfig, createTestDb } from "../test-utils";
import { BENCHMARK_VERSION, type BenchmarkRun } from "./contracts";
import { createBenchmarkRepository } from "./repository";
import { createBenchmarkRunner } from "./runner";

describe("interrupted benchmark recovery", () => {
  let db: Kysely<DB>;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.destroy();
  });
  it("pauses and removes local automation before deferring remote cleanup during a provider outage", async () => {
    const user = await createUserRepository(db).create({ name: "Test owner", email: "owner@example.com" });
    const repository = createBenchmarkRepository(db);
    const enrollment = await repository.enroll({
      id: randomUUID(),
      userId: user.id,
      email: "owner@example.com",
      integration: "clickup",
      accountId: "test-account",
      teamId: "1",
      spaceId: "2",
      secondSpaceId: "3",
      dedicatedTestAccount: true,
      sharedWithBenchmarkTeam: true,
    });
    const taskId = randomUUID();
    await createAutomationDraft({
      db,
      timezone: "UTC",
      context: {
        id: taskId,
        platform: "slack",
        contextType: "dm",
        deliveryTarget: user.id,
        threadTs: null,
        createdBy: user.id,
        originPlatform: "web",
        originConversationId: "benchmark-recovery",
        originProviderThreadId: null,
        originMessageId: null,
      },
    });
    await db.updateTable("scheduled_tasks").set({ status: "active" }).where("id", "=", taskId).execute();
    const manifest = { provider: "openrouter", modelId: "@preset/luna", fingerprint: "frozen" };
    const run: BenchmarkRun = {
      id: randomUUID(),
      enrollmentId: enrollment.id,
      suiteId: "automations",
      version: BENCHMARK_VERSION,
      status: "interrupted",
      createdAt: new Date().toISOString(),
      model: manifest,
      cancelRequested: false,
      cases: [
        {
          scenario: {
            id: "case",
            family: "new_task",
            variant: 0,
            title: "New work",
            prompt: "Follow up on new work.",
            version: BENCHMARK_VERSION,
          },
          verdict: "unverified",
          stage: "building",
          assertions: [],
          conversation: [],
          clarifications: 0,
          technicalQuestions: 0,
          cleanup: "needs_attention",
          resources: [
            { kind: "list", key: "source", id: "remote-list", state: "created" },
            { kind: "automation", key: "builder", id: taskId, state: "created" },
          ],
        },
      ],
    };
    await repository.insert(run);
    const worker = await repository.claimCleanup(run.id, enrollment.id);
    const calls: string[] = [];
    createBenchmarkRunner({
      db,
      config: createTestConfig({ BENCHMARKS_ENABLED: true }),
      repository,
      model: {
        manifest: async () => manifest,
        generate: async () => [],
        answer: async () => ({ text: null, technical: false }),
      },
      provider: async () => {
        throw new Error("Provider unavailable");
      },
      ownerRequest: async () => async (path, init) => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path.endsWith("/lock")) return Response.json({ lock: { generation: 1 } });
        if (path.endsWith("/pause"))
          await db.updateTable("scheduled_tasks").set({ status: "paused" }).where("id", "=", taskId).execute();
        else if (init?.method === "DELETE") await db.deleteFrom("scheduled_tasks").where("id", "=", taskId).execute();
        return Response.json({});
      },
    }).start(run, enrollment, worker, true);
    await expect.poll(async () => (await repository.get(run.id, enrollment.id))?.status).toBe("completed");
    expect(calls).toContain(`POST /api/scheduled-tasks/${taskId}/pause`);
    expect(
      await db.selectFrom("scheduled_tasks").select("id").where("id", "=", taskId).executeTakeFirst(),
    ).toBeUndefined();
    const result = await repository.get(run.id, enrollment.id);
    expect(result?.cases[0]?.cleanup).toBe("needs_attention");
    expect(
      (
        await db
          .selectFrom("benchmark_enrollments")
          .select("active_run_id")
          .where("id", "=", enrollment.id)
          .executeTakeFirst()
      )?.active_run_id,
    ).toBe(run.id);
  });
});
