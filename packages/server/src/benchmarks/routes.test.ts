import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestConfig, createTestDb } from "../test-utils";
import { createBenchmarkRepository } from "./repository";
import { benchmarkRoutes } from "./routes";

describe("benchmark system API boundaries", () => {
  let db: Kysely<DB>;
  let enrollmentId: string;
  const config = createTestConfig({
    BENCHMARKS_ENABLED: true,
    SYSTEM_SECRET: "test-system-secret",
    BASE_URL: "https://e2e-test.example",
  });
  beforeEach(async () => {
    db = await createTestDb();
    const user = await createUserRepository(db).create({ name: "Test owner", email: "owner@example.com" });
    const enrollment = await createBenchmarkRepository(db).enroll({
      id: randomUUID(),
      userId: user.id,
      email: "owner@example.com",
      accountId: "sketch",
      integration: "none",
      teamId: "0",
      spaceId: "0",
      secondSpaceId: "0",
      dedicatedTestAccount: true,
      sharedWithBenchmarkTeam: true,
    });
    enrollmentId = enrollment.id;
  });
  afterEach(async () => {
    await db.destroy();
  });
  function app(enabled = true) {
    return benchmarkRoutes({
      db,
      config: { ...config, BENCHMARKS_ENABLED: enabled },
      provider: async () => null,
      executionAvailable: true,
      request: async () => new Response("Unexpected owner request", { status: 500 }),
    });
  }
  function post(path: string, body: unknown, profile = enrollmentId) {
    return app().request(path, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-system-secret",
        "Content-Type": "application/json",
        "X-Benchmark-Enrollment-Id": profile,
      },
      body: JSON.stringify(body),
    });
  }
  it("requires the system credential and tenant-specific feature flag", async () => {
    expect((await app().request("/")).status).toBe(401);
    expect((await app(false).request("/", { headers: { Authorization: "Bearer test-system-secret" } })).status).toBe(
      503,
    );
  });
  it("rejects model overrides and a mismatched integration before any model call", async () => {
    expect(
      (await post("/runs", { suiteId: "automation_core", integration: "none", count: 3, model: "other-model" })).status,
    ).toBe(400);
    expect((await post("/runs", { suiteId: "automations", integration: "clickup", count: 3 })).status).toBe(409);
    expect((await post("/runs", { suiteId: "automation_core", integration: "clickup", count: 3 })).status).toBe(409);
  });
  it("requires a real selected shared profile and does not cancel unknown runs", async () => {
    expect(
      (await post("/runs", { suiteId: "automation_core", integration: "none", count: 3 }, randomUUID())).status,
    ).toBe(409);
    expect((await post(`/runs/${randomUUID()}/cancellations`, {})).status).toBe(404);
  });
});
