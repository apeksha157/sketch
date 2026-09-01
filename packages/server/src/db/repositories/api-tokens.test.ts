import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateOAuthAccessToken,
  generateOAuthRefreshToken,
  getApiTokenDisplayPrefix,
  hashApiToken,
} from "../../auth/api-token";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createApiTokenRepository } from "./api-tokens";
import { createUserRepository } from "./users";

let db: Kysely<DB>;
let apiTokens: ReturnType<typeof createApiTokenRepository>;
let users: ReturnType<typeof createUserRepository>;

beforeEach(async () => {
  db = await createTestDb();
  apiTokens = createApiTokenRepository(db);
  users = createUserRepository(db);
});

afterEach(async () => {
  await db.destroy();
});

async function createOAuthToken(userId: string, name = "Claude") {
  const accessToken = generateOAuthAccessToken();
  const refreshToken = generateOAuthRefreshToken();
  const row = await apiTokens.createOAuth({
    userId,
    name,
    tokenHash: hashApiToken(accessToken),
    prefix: getApiTokenDisplayPrefix(accessToken),
    clientId: `client-${randomUUID()}`,
    scopes: ["mcp:read"],
    refreshTokenHash: hashApiToken(refreshToken),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  return { accessToken, refreshToken, row };
}

describe("api token repository", () => {
  it("stores only token hashes and finds active tokens by hash", async () => {
    const user = await users.create({ name: "Token User", email: "token@example.com", emailVerified: true });
    const { accessToken, row } = await createOAuthToken(user.id, "Laptop");

    expect(row.token_hash).toBe(hashApiToken(accessToken));
    expect(row.token_hash).not.toBe(accessToken);
    expect(row.prefix).toBe("sko_".concat(accessToken.slice(4, 8)));

    const found = await apiTokens.findByHash(hashApiToken(accessToken));
    expect(found?.id).toBe(row.id);
  });

  it("does not find revoked tokens", async () => {
    const user = await users.create({ name: "Revoked User", email: "revoked@example.com", emailVerified: true });
    const { accessToken, row } = await createOAuthToken(user.id, "Old Laptop");

    await apiTokens.revoke(user.id, row.id);

    const found = await apiTokens.findByHash(hashApiToken(accessToken));
    expect(found).toBeUndefined();
  });

  it("does not find expired tokens", async () => {
    const user = await users.create({ name: "Expired User", email: "expired@example.com", emailVerified: true });
    const { accessToken, row } = await createOAuthToken(user.id, "Old CLI");

    await db
      .updateTable("api_tokens")
      .set({ expires_at: "2026-01-01T00:00:00.000Z" })
      .where("id", "=", row.id)
      .execute();

    const found = await apiTokens.findByHash(hashApiToken(accessToken), new Date("2026-01-01T00:00:01.000Z"));
    expect(found).toBeUndefined();
  });

  it("lists live OAuth connections without PATs or revoked tokens", async () => {
    const user = await users.create({ name: "Mixed User", email: "mixed@example.com", emailVerified: true });
    await db
      .insertInto("api_tokens")
      .values({
        id: randomUUID(),
        user_id: user.id,
        name: "CLI",
        token_hash: hashApiToken("skp_test"),
        prefix: "skp_test",
        kind: "pat",
      })
      .execute();
    await createOAuthToken(user.id, "Claude");
    const expired = await createOAuthToken(user.id, "Expired access token");
    await db
      .updateTable("api_tokens")
      .set({ expires_at: "2026-01-01T00:00:00.000Z" })
      .where("id", "=", expired.row.id)
      .execute();
    const revoked = await createOAuthToken(user.id, "Revoked OAuth");
    await apiTokens.revoke(user.id, revoked.row.id);

    const rows = await apiTokens.listForUser(user.id);
    expect(rows.map((row) => row.name).sort()).toEqual(["Claude", "Expired access token"]);
  });

  it("rejects OAuth refresh rotation when the presented refresh token is stale", async () => {
    const user = await users.create({ name: "OAuth User", email: "oauth@example.com", emailVerified: true });
    const row = await apiTokens.createOAuth({
      userId: user.id,
      name: "Claude",
      tokenHash: hashApiToken("sko_old"),
      prefix: "sko_old",
      clientId: "client",
      scopes: ["mcp:read"],
      refreshTokenHash: hashApiToken("skr_old"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const rotated = await apiTokens.rotateOAuthToken(row.id, {
      previousRefreshTokenHash: hashApiToken("skr_old"),
      tokenHash: hashApiToken("sko_new"),
      prefix: "sko_new",
      refreshTokenHash: hashApiToken("skr_new"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(rotated?.refresh_token_hash).toBe(hashApiToken("skr_new"));

    const staleRotation = await apiTokens.rotateOAuthToken(row.id, {
      previousRefreshTokenHash: hashApiToken("skr_old"),
      tokenHash: hashApiToken("sko_race"),
      prefix: "sko_race",
      refreshTokenHash: hashApiToken("skr_race"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(staleRotation).toBeUndefined();

    const stored = await apiTokens.findByRefreshHash(hashApiToken("skr_new"));
    expect(stored?.token_hash).toBe(hashApiToken("sko_new"));
  });

  it("throttles last_used_at updates", async () => {
    const user = await users.create({ name: "Touched User", email: "touched@example.com", emailVerified: true });
    const { row } = await createOAuthToken(user.id, "Claude");

    const first = new Date("2026-01-01T00:00:00.000Z");
    const second = new Date("2026-01-01T00:00:30.000Z");
    const third = new Date("2026-01-01T00:01:01.000Z");

    expect(await apiTokens.touchLastUsed(row.id, first)).toBe(true);
    expect(await apiTokens.touchLastUsed(row.id, second)).toBe(false);
    expect(await apiTokens.touchLastUsed(row.id, third)).toBe(true);
  });
});
