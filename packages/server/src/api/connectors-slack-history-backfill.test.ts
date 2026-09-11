import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const PASSWORD = "testpassword123";
const logger = createTestLogger();

async function seedUsers(db: Kysely<DB>): Promise<string> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  const hash = await hashPassword(PASSWORD);
  const admin = await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await users.create({
    name: "member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "member",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  return admin.id;
}

async function loginAs(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

describe("Slack history backfill API", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let connectorId: string;
  let queueCalls: number;

  beforeEach(async () => {
    db = await createTestDb();
    queueCalls = 0;
    app = createApp(db, createTestConfig(), {
      logger,
      queueSlackHistoryBackfill: async () => {
        queueCalls += 1;
        return { channelsQueued: 3, channelsSkipped: 1 };
      },
    });
    const adminId = await seedUsers(db);
    cookie = await loginAs(app, ADMIN_EMAIL);
    const connector = await createConnectorRepository(db).createConfig({
      connectorType: "slack",
      authType: "system",
      credentials: JSON.stringify({ type: "system" }),
      scopeConfig: JSON.stringify({}),
      createdBy: adminId,
    });
    connectorId = connector.id;
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("queues a backfill for an admin and reports the channel counts", async () => {
    const res = await app.request(`/api/connectors/${connectorId}/history-backfills`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ channelsQueued: 3, channelsSkipped: 1 });
    expect(queueCalls).toBe(1);
  });

  it("denies a non-admin", async () => {
    const memberCookie = await loginAs(app, MEMBER_EMAIL);
    const res = await app.request(`/api/connectors/${connectorId}/history-backfills`, {
      method: "POST",
      headers: { Cookie: memberCookie },
    });
    expect(res.status).toBe(403);
    expect(queueCalls).toBe(0);
  });

  it("accepts a history lookback inside the bounds and rejects one outside", async () => {
    const patch = (historyLookbackDays: unknown) =>
      app.request(`/api/connectors/${connectorId}/scope`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ scopeConfig: { historyLookbackDays } }),
      });

    expect((await patch(30)).status).toBe(200);
    const stored = await createConnectorRepository(db).findConfigById(connectorId);
    expect(JSON.parse(stored?.scope_config ?? "{}")).toMatchObject({ historyLookbackDays: 30 });
    expect((await patch(0)).status).toBe(400);
    expect((await patch(3651)).status).toBe(400);
    expect((await patch(1.5)).status).toBe(400);
  });
});
