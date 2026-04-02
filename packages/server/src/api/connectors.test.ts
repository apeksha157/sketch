/**
 * Security tests for the connectors API.
 *
 * Verifies that all mutating routes (POST, DELETE, PATCH) require admin
 * authentication and return 403 for member-role sessions.
 *
 * These tests are intentionally written before the requireAdmin() middleware
 * is added (Phase 2 TDD red step). They will fail until the guards are in place.
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

describe("Connectors API — auth guard", () => {
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

  describe("POST /api/connectors — create connector", () => {
    it("returns 403 for member role", async () => {
      const app = createApp(db, config, { logger });
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          connectorType: "google_drive",
          authType: "oauth",
          credentials: { refresh_token: "tok" },
        }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });

  describe("DELETE /api/connectors/:id — delete connector", () => {
    it("returns 403 for member role", async () => {
      const app = createApp(db, config, { logger });
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/connectors/some-connector-id", {
        method: "DELETE",
        headers: { Cookie: memberCookie },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });

  describe("PATCH /api/connectors/:id/scope — update scope", () => {
    it("returns 403 for member role", async () => {
      const app = createApp(db, config, { logger });
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/connectors/some-connector-id/scope", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ scopeConfig: { sharedDrives: [] } }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });

  describe("POST /api/connectors/:id/syncs — trigger sync", () => {
    it("returns 403 for member role", async () => {
      const app = createApp(db, config, { logger });
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/connectors/some-connector-id/syncs", {
        method: "POST",
        headers: { Cookie: memberCookie },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });

  describe("POST /api/connectors/:id/enrichments — trigger enrichment", () => {
    it("returns 403 for member role", async () => {
      const app = createApp(db, config, { logger });
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/connectors/some-connector-id/enrichments", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({ fileIds: ["file-1"], instruction: "summarize" }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });

  describe("POST /api/connectors/files/:fileId/enrichments — enrich single file", () => {
    it("returns 403 for member role", async () => {
      const app = createApp(db, config, { logger });
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/connectors/files/some-file-id/enrichments", {
        method: "POST",
        headers: { Cookie: memberCookie },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });

  describe("POST /api/connectors/google-drive/browse — browse with raw creds", () => {
    it("returns 403 for member role", async () => {
      const app = createApp(db, config, { logger });
      const memberCookie = await getMemberCookie(db);

      const res = await app.request("/api/connectors/google-drive/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          credentials: {
            client_id: "client-id",
            client_secret: "client-secret",
            refresh_token: "refresh-token",
          },
        }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });
});
