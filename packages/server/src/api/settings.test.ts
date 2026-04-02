/**
 * Security tests for the settings API.
 *
 * Verifies:
 * 1. GET /api/settings/search does not return the raw gemini_api_key — should
 *    return geminiApiKeyConfigured (boolean) instead.
 * 2. PUT /api/settings/search requires admin — members get 403.
 * 3. POST /api/settings/search/run-enrichment requires admin — members get 403.
 *
 * These tests are the Phase 2 TDD red step and will fail until the fixes are applied.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const config = createTestConfig();
const logger = createTestLogger();

async function seedAdmin(db: Kysely<DB>, email = "admin@test.com", password = "testpassword123") {
  const settings = createSettingsRepository(db);
  const hash = await hashPassword(password);
  await settings.create({ adminEmail: email, adminPasswordHash: hash });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function loginAdmin(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function getMemberCookie(db: Kysely<DB>): Promise<string> {
  const users = createUserRepository(db);
  const settings = createSettingsRepository(db);
  const user = await users.create({ name: "Test Member", email: "member@test.com" });
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("JWT secret not found in test DB");
  const token = await signJwt(user.id, "member", row.jwt_secret);
  return `sketch_session=${token}`;
}

describe("Settings API — security", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedAdmin(db);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  describe("GET /api/settings/search — API key masking", () => {
    it("does not expose the raw gemini_api_key when one is set", async () => {
      const settings = createSettingsRepository(db);
      await settings.update({ geminiApiKey: "AIza-super-secret-key-12345" });

      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/settings/search", {
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      // The raw key must not appear anywhere in the response
      expect(body.geminiApiKey).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("AIza-super-secret-key-12345");
      // Instead, a boolean flag indicating whether a key is configured
      expect(typeof body.geminiApiKeyConfigured).toBe("boolean");
      expect(body.geminiApiKeyConfigured).toBe(true);
    });

    it("returns geminiApiKeyConfigured: false when no key is set", async () => {
      const app = createApp(db, config, { logger });
      const adminCookie = await loginAdmin(app);

      const res = await app.request("/api/settings/search", {
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.geminiApiKey).toBeUndefined();
      expect(body.geminiApiKeyConfigured).toBe(false);
    });
  });

  describe("PUT /api/settings/search — admin guard", () => {
    it("returns 403 for member role", async () => {
      const app = createApp(db, config, { logger });
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/settings/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ geminiApiKey: "new-key", enrichmentEnabled: true }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });

  describe("POST /api/settings/search/enrichments — admin guard", () => {
    it("returns 403 for member role", async () => {
      const app = createApp(db, config, { logger });
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/settings/search/enrichments", {
        method: "POST",
        headers: { Cookie: memberCookie },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });
});
