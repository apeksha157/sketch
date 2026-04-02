/**
 * Security tests for the provider-identities API.
 *
 * Verifies that:
 * - POST /api/identities/connect requires admin — members get 403.
 * - DELETE /api/identities/user/:userId/provider/:provider requires admin — members get 403.
 *
 * Phase 2 TDD red step — will fail until requireAdmin() is added to the routes.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb } from "../test-utils";

const config = createTestConfig();

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

describe("Provider Identities API — auth guard", () => {
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

  describe("POST /api/identities — create user-to-provider identity", () => {
    it("returns 403 for member role", async () => {
      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/identities", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          userId: "some-user-id",
          provider: "google_drive",
          providerUserId: "google-uid-123",
          providerEmail: "user@gmail.com",
        }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });

  describe("DELETE /api/identities/user/:userId/provider/:provider — disconnect provider", () => {
    it("returns 403 for member role", async () => {
      const app = createApp(db, config);
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/identities/user/some-user-id/provider/google_drive", {
        method: "DELETE",
        headers: { Cookie: memberCookie },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });
});
