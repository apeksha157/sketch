import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { createBenchmarkEnvironment } from "./environment";
import { benchmarkExecutionProvider } from "./execution-binding";
import { createBenchmarkRepository } from "./repository";
import { testBenchmarkConnection, testBenchmarkProvider } from "./test-fixtures";

describe("shared benchmark connection lifecycle", () => {
  let db: Kysely<DB>;
  let userId: string;
  beforeEach(async () => {
    db = await createTestDb();
    const user = await createUserRepository(db).create({
      name: "Shared",
      email: "shared@example.com",
      authRole: "admin",
    });
    userId = user.id;
    await db
      .updateTable("benchmark_environment")
      .set({
        user_id: userId,
        bindings_json: JSON.stringify({
          github: { accountId: "github-account", target: { id: "owner/test", name: "Test repository" } },
        }),
      })
      .execute();
  });
  afterEach(async () => {
    await db.destroy();
  });
  it("uses connections shared with the configured identity and detects access revisions", async () => {
    const connection = testBenchmarkConnection("github");
    const list = vi.fn(async () => [connection]);
    const provider = testBenchmarkProvider(list);
    const environment = createBenchmarkEnvironment(db, async () => provider);
    expect((await environment.overview()).connections.find((entry) => entry.integration === "github")).toMatchObject({
      status: "ready",
      accountId: connection.id,
    });
    const original = await environment.binding("github");
    expect(list).toHaveBeenCalledWith("shared@example.com", "Shared", { workspaceId: "test-provider", userId });
    connection.accessRevision = 2;
    await expect(environment.validate(original)).rejects.toThrow("changed");
  });
  it("distinguishes lookup failure from disconnected and keeps core independent", async () => {
    const environment = createBenchmarkEnvironment(db, async () => {
      throw new Error("Provider failed");
    });
    const state = await environment.overview();
    expect(state.connections.every((entry) => entry.status === "unavailable")).toBe(true);
    expect(await environment.binding("none")).toMatchObject({ userId, integration: "none" });
    const disconnected = createBenchmarkEnvironment(db, async () => testBenchmarkProvider());
    expect((await disconnected.overview()).connections.every((entry) => entry.status === "disconnected")).toBe(true);
  });
  it("never reuses the old target when an account is replaced", async () => {
    const environment = createBenchmarkEnvironment(db, async () =>
      testBenchmarkProvider(async () => [testBenchmarkConnection("github", "replacement")]),
    );
    const github = (await environment.overview()).connections.find((entry) => entry.integration === "github");
    expect(github).toMatchObject({ status: "choose_target", accountId: "replacement" });
    expect(github?.target).toBeUndefined();
    await expect(environment.binding("github")).rejects.toThrow("test area");
  });
  it("pins agent credentials and refuses new calls after account replacement or cancellation", async () => {
    let connection = testBenchmarkConnection("github");
    const auth = vi.fn(async () => ({ accessToken: "opaque-test-token" }));
    const provider = { ...testBenchmarkProvider(async () => [connection]), getGithubAccessToken: auth };
    const environment = createBenchmarkEnvironment(db, async () => provider);
    const binding = await environment.binding("github");
    const repository = createBenchmarkRepository(db);
    const enrollment = await repository.enroll({ ...binding, id: randomUUID() });
    const id = randomUUID();
    await repository.insert({
      id,
      enrollmentId: enrollment.id,
      suiteId: "integrations",
      version: "v2",
      workspaceVersion: 2,
      model: { provider: "test", modelId: "test", fingerprint: "test" },
      createdAt: new Date().toISOString(),
      status: "running",
      cancelRequested: false,
      cases: [],
    });
    await db
      .insertInto("benchmark_contexts")
      .values({ conversation_id: "benchmark-test", task_id: null, run_id: id, binding_json: JSON.stringify(binding) })
      .execute();
    const loader = await benchmarkExecutionProvider({
      db,
      enabled: true,
      userId,
      conversationId: "benchmark-test",
      loadProvider: async () => provider,
    });
    const scoped = await loader();
    await scoped?.getGithubAccessToken?.({ userEmail: "ignored@example.com" });
    expect(auth).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "github-account", userEmail: "shared@example.com" }),
    );
    await expect(
      scoped?.getGithubAccessToken?.({ userEmail: "shared@example.com", accountId: "another" }),
    ).rejects.toThrow("switch accounts");
    connection = testBenchmarkConnection("github", "replacement");
    await expect(scoped?.getGithubAccessToken?.({ userEmail: "shared@example.com" })).rejects.toThrow("test area");
    expect(auth).toHaveBeenCalledTimes(1);
    await expect(
      benchmarkExecutionProvider({
        db,
        enabled: true,
        userId: "other",
        conversationId: "benchmark-test",
        loadProvider: async () => provider,
      }),
    ).rejects.toThrow("identity");
    connection = testBenchmarkConnection("github");
    await repository.cancel(id, enrollment.id);
    await expect(scoped?.getGithubAccessToken?.({ userEmail: "shared@example.com" })).rejects.toThrow("stopped");
  });
});
