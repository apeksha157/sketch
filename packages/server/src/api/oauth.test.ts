/**
 * Security tests for the OAuth API.
 *
 * Verifies that POST /api/oauth/google/configure requires admin role.
 * Members must receive 403.
 *
 * Phase 2 TDD red step — will fail until requireAdmin() is added to the route.
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

async function getMemberCookie(db: Kysely<DB>): Promise<string> {
  const users = createUserRepository(db);
  const settings = createSettingsRepository(db);
  const user = await users.create({ name: "Test Member", email: "member@test.com" });
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("JWT secret not found in test DB");
  const token = await signJwt(user.id, "member", row.jwt_secret);
  return `sketch_session=${token}`;
}

describe("OAuth API — auth guard", () => {
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

  describe("PUT /api/oauth/google/config — save OAuth client credentials", () => {
    it("returns 403 for member role", async () => {
      const app = createApp(db, config, { logger });
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/oauth/google/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          clientId: "client-id.apps.googleusercontent.com",
          clientSecret: "GOCSPX-supersecretvalue",
        }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });
});
