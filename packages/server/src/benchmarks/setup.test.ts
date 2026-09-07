import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestConfig, createTestDb } from "../test-utils";
import { createBenchmarkRepository } from "./repository";
import { benchmarkSetupRoutes, createSetupLink } from "./setup";

describe("shared-team benchmark enrollment", () => {
  let db: Kysely<DB>;
  let userId: string;
  const config = createTestConfig({ BENCHMARKS_ENABLED: true, BASE_URL: "https://e2e-test.example" });
  beforeEach(async () => {
    db = await createTestDb();
    userId = (await createUserRepository(db).create({ name: "Test owner", email: "owner@example.com" })).id;
  });
  afterEach(async () => {
    await db.destroy();
  });
  function app(subject?: string, provider: Parameters<typeof benchmarkSetupRoutes>[0]["provider"] = async () => null) {
    const app = new Hono();
    app.use("*", async (c, next) => {
      if (subject) c.set("sub", subject);
      await next();
    });
    app.route("/setup", benchmarkSetupRoutes({ db, config, provider }));
    return app;
  }
  function post(server: Hono, path: string, value: unknown) {
    return server.request(`/setup/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  }
  async function grant() {
    const link = await createSetupLink(db, config);
    return new URLSearchParams(new URL(link.url).hash.slice(1)).get("token");
  }
  const enrollment = {
    integration: "none",
    accountId: "sketch",
    teamId: "0",
    spaceId: "0",
    secondSpaceId: "0",
    dedicatedTestAccount: true,
    sharedWithBenchmarkTeam: true,
  };

  it("does not turn a setup URL into authentication", async () => {
    const token = await grant();
    expect((await post(app(), "context", { token })).status).toBe(401);
  });
  it("uses the real Sketch owner, requires explicit consent and consumes the link once", async () => {
    const token = await grant();
    const server = app(userId);
    expect(
      (await post(server, "enrollment", { token, enrollment: { ...enrollment, sharedWithBenchmarkTeam: false } }))
        .status,
    ).toBe(400);
    expect((await post(server, "enrollment", { token, enrollment })).status).toBe(200);
    const profile = await createBenchmarkRepository(db).enrollmentFor(userId);
    expect(profile?.email).toBe("owner@example.com");
    expect(profile?.sharedWithBenchmarkTeam).toBe(true);
    expect((await post(server, "enrollment", { token, enrollment })).status).toBe(400);
  });
  it("allows core setup during a provider outage without weakening token validation", async () => {
    const provider = vi.fn().mockRejectedValue(new Error("Provider outage"));
    const server = app(userId, provider);
    const token = await grant();
    const response = await post(server, "context", { token });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connections: [] });
    provider.mockClear();
    expect((await post(server, "enrollment", { token, enrollment })).status).toBe(200);
    expect(provider).not.toHaveBeenCalled();
    expect((await post(server, "context", { token })).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
    const clickup = await post(server, "enrollment", {
      token: await grant(),
      enrollment: { ...enrollment, integration: "clickup", accountId: "clickup" },
    });
    expect(clickup.status).toBe(400);
    expect(await clickup.text()).toContain("ClickUp is unavailable");
  });
  it("rejects expired and forged setup tokens", async () => {
    const token = await grant();
    await db.updateTable("benchmark_setup_links").set({ expires_at: "2000-01-01T00:00:00.000Z" }).execute();
    expect((await post(app(userId), "context", { token })).status).toBe(400);
    expect((await post(app(userId), "context", { token: "a".repeat(64) })).status).toBe(400);
  });
});
