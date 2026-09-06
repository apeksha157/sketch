/**
 * SalesQL allowance is an admin-only operational read beside the manual run
 * trigger; the provider stays behind EnrichmentSweepService so the route only
 * maps service state to HTTP status and response shape.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { EnrichmentSweepService } from "../entities/enrichment-sweep";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const PASSWORD = "testpassword123";
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";

async function seedUsers(db: Kysely<DB>): Promise<void> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
  });
  await users.create({
    name: "member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "member",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

function allowanceService(): EnrichmentSweepService {
  return {
    allowance: async () => ({ remainingCalls: 17, resetsAt: "2026-10-01T00:00:00.000Z" }),
    runOnce: async () => {
      throw new Error("runOnce should not be called");
    },
    tryRunManual: () => {
      throw new Error("tryRunManual should not be called");
    },
  };
}

describe("GET /api/enrichment/allowance", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns allowance for admins, rejects members, and reports unavailable SalesQL service", async () => {
    const app = createApp(db, createTestConfig({}), {
      logger: createTestLogger(),
      enrichmentSweep: allowanceService(),
    });
    const adminCookie = await login(app, ADMIN_EMAIL);
    const memberCookie = await login(app, MEMBER_EMAIL);

    const admin = await app.request("/api/enrichment/allowance", { headers: { Cookie: adminCookie } });
    expect(admin.status).toBe(200);
    await expect(admin.json()).resolves.toEqual({ remaining: 17, resetsAt: "2026-10-01T00:00:00.000Z" });

    const member = await app.request("/api/enrichment/allowance", { headers: { Cookie: memberCookie } });
    expect(member.status).toBe(403);

    const unavailableApp = createApp(db, createTestConfig({}), { logger: createTestLogger(), enrichmentSweep: null });
    const unavailableAdminCookie = await login(unavailableApp, ADMIN_EMAIL);
    const unavailable = await unavailableApp.request("/api/enrichment/allowance", {
      headers: { Cookie: unavailableAdminCookie },
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      error: { code: "ENRICHMENT_SWEEP_UNAVAILABLE", message: "SalesQL enrichment is not running in this process" },
    });
  });
});
