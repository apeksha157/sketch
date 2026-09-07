import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import type { BenchmarkRun } from "./contracts";
import { createBenchmarkRepository } from "./repository";

describe("Postgres benchmark claims", () => {
  let db: Kysely<DB>;
  beforeAll(async () => {
    db = await createTestPgDb();
  }, 60_000);
  afterAll(async () => {
    await db.destroy();
  });
  it("uses portable transactions and protects the owner across multiple profiles", async () => {
    const user = await createUserRepository(db).create({ name: "Benchmark owner", email: "bench-pg@example.com" });
    const repo = createBenchmarkRepository(db);
    const input = {
      id: randomUUID(),
      userId: user.id,
      email: "bench-pg@example.com",
      integration: "clickup" as const,
      accountId: "first",
      teamId: "1",
      spaceId: "2",
      secondSpaceId: "3",
      dedicatedTestAccount: true as const,
      sharedWithBenchmarkTeam: true as const,
    };
    const first = await repo.enroll(input);
    const second = await repo.enroll({ ...input, id: randomUUID(), accountId: "second" });
    const run: BenchmarkRun = {
      id: randomUUID(),
      enrollmentId: first.id,
      suiteId: "automations",
      version: "automations.clickup.v1",
      status: "draft",
      createdAt: new Date().toISOString(),
      model: { provider: "openrouter", modelId: "@preset/luna", fingerprint: "frozen" },
      cases: [],
      cancelRequested: false,
    };
    const other = { ...run, id: randomUUID(), enrollmentId: second.id };
    await repo.insert(run);
    await repo.insert(other);
    const worker = await repo.claim(run.id, first.id);
    await expect(repo.claim(other.id, second.id)).rejects.toThrow("already has an active batch");
    await repo.save({ ...run, status: "completed" }, worker);
    await repo.release(run);
    expect(await repo.claim(other.id, second.id)).toBeTruthy();
  });
});
