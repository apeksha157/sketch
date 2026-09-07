import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { type BenchmarkRun, type Enrollment, freezeSelection } from "./contracts";
import { createBenchmarkRepository } from "./repository";

function draft(enrollmentId: string): BenchmarkRun {
  return {
    id: randomUUID(),
    enrollmentId,
    suiteId: "automations",
    version: "automations.clickup.v1",
    status: "draft",
    createdAt: new Date().toISOString(),
    model: { provider: "openrouter", modelId: "@preset/luna", fingerprint: "frozen" },
    cases: freezeSelection(
      {
        cases: [
          { family: "new_task", variant: 0 },
          { family: "completion", variant: 0 },
          { family: "attachment", variant: 0 },
        ],
      },
      3,
    ).map((scenario) => ({
      scenario,
      verdict: "pending",
      stage: "draft",
      assertions: [],
      conversation: [],
      clarifications: 0,
      technicalQuestions: 0,
      cleanup: "pending",
      resources: [],
    })),
    cancelRequested: false,
  };
}

describe("durable benchmark ownership", () => {
  let db: Kysely<DB>;
  let enrollment: Enrollment;
  let repo: ReturnType<typeof createBenchmarkRepository>;
  beforeEach(async () => {
    db = await createTestDb();
    repo = createBenchmarkRepository(db);
    const user = await createUserRepository(db).create({ name: "Benchmark user", email: "benchmark@example.com" });
    enrollment = await repo.enroll({
      id: randomUUID(),
      userId: user.id,
      email: "benchmark@example.com",
      accountId: "account",
      teamId: "1",
      spaceId: "2",
      secondSpaceId: "3",
      dedicatedTestAccount: true,
      integration: "clickup",
      sharedWithBenchmarkTeam: true,
    });
  });
  afterEach(async () => {
    await db.destroy();
  });
  it("rejects replay and a second active batch without dropping the account lock", async () => {
    const first = draft(enrollment.id);
    const second = draft(enrollment.id);
    await repo.insert(first);
    await repo.insert(second);
    await repo.claim(first.id, enrollment.id);
    await expect(repo.claim(first.id, enrollment.id)).rejects.toThrow();
    await expect(repo.claim(second.id, enrollment.id)).rejects.toThrow();
    await expect(repo.enroll({ ...enrollment, spaceId: "99" })).rejects.toThrow();
  });
  it("does not expose or cancel another enrollment's run", async () => {
    const run = draft(enrollment.id);
    await repo.insert(run);
    await repo.claim(run.id, enrollment.id);
    expect(await repo.get(run.id, "another-enrollment")).toBeNull();
    await repo.cancel(run.id, "another-enrollment");
    expect((await repo.get(run.id, enrollment.id))?.cancelRequested).toBe(false);
    await repo.cancel(run.id, enrollment.id);
    expect((await repo.get(run.id, enrollment.id))?.cancelRequested).toBe(true);
  });
  it("fences stale workers and never replays interrupted authoring", async () => {
    const run = draft(enrollment.id);
    await repo.insert(run);
    const worker = await repo.claim(run.id, enrollment.id);
    await db
      .updateTable("benchmark_runs")
      .set({ heartbeat_at: "2000-01-01T00:00:00.000Z" })
      .where("id", "=", run.id)
      .execute();
    await repo.interruptStale();
    expect((await repo.get(run.id, enrollment.id))?.status).toBe("interrupted");
    await expect(repo.heartbeat(run.id, worker)).rejects.toThrow();
    await expect(repo.assertWorker(run.id, worker)).rejects.toThrow();
    const cleanupWorker = await repo.claimCleanup(run.id, enrollment.id);
    expect(cleanupWorker).not.toBe(worker);
    await expect(repo.save({ ...run, status: "running" }, worker)).rejects.toThrow();
  });
  it("records manual absence without converting an uncertain outcome into a pass", async () => {
    const run = draft(enrollment.id);
    const item = run.cases[0];
    if (!item) throw new Error("Missing case");
    item.resources.push({ kind: "list", key: "source", id: null, state: "intent", name: "Exact test list" });
    item.verdict = "passed";
    item.cleanup = "needs_attention";
    await repo.insert(run);
    const worker = await repo.claim(run.id, enrollment.id);
    await expect(
      repo.resolveAbsentResource(run.id, enrollment.id, item.scenario.id, "source", "ops@example.com"),
    ).rejects.toThrow("Stop the batch");
    await repo.save({ ...run, status: "completed" }, worker);
    await repo.resolveAbsentResource(run.id, enrollment.id, item.scenario.id, "source", "ops@example.com");
    const saved = await repo.get(run.id, enrollment.id);
    expect(saved?.cases[0]?.verdict).toBe("unverified");
    expect(saved?.cases[0]?.resources[0]?.state).toBe("deleted");
    expect(saved?.cases[0]?.assertions[0]?.evidence).toContain("operator attestation");
    expect(saved?.cases[0]?.cleanup).toBe("needs_attention");
  });
  it("blocks cleanup of an old batch while a new batch owns the account", async () => {
    const old = draft(enrollment.id);
    await repo.insert(old);
    const worker = await repo.claim(old.id, enrollment.id);
    old.status = "completed";
    await repo.save(old, worker);
    await repo.release(old);
    const next = draft(enrollment.id);
    await repo.insert(next);
    await repo.claim(next.id, enrollment.id);
    await expect(repo.claimCleanup(old.id, enrollment.id)).rejects.toThrow("Another batch");
  });
});
