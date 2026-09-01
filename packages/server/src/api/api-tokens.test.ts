import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateOAuthAccessToken,
  generateOAuthRefreshToken,
  getApiTokenDisplayPrefix,
  hashApiToken,
} from "../auth/api-token";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createApiTokenRepository } from "../db/repositories/api-tokens";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const BASE_URL = "https://sketch.test";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const CODE_VERIFIER = "test-code-verifier-with-enough-entropy-for-pkce";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

async function setupSession(email: string) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  if (!(await settings.get())) {
    await settings.create();
  }
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const user = await users.create({
    name: email.split("@")[0] ?? "user",
    email,
    emailVerified: true,
    passwordHash: await hashPassword("testpassword123"),
    authRole: "member",
  });
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("Missing jwt secret");
  return {
    user,
    cookie: `sketch_session=${await signJwt(user.id, "member", row.jwt_secret)}`,
  };
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function mcpHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Protocol-Version": "2025-03-26",
  };
}

async function createOAuthGrant(app: ReturnType<typeof createApp>, cookie: string) {
  const registerRes = await app.request("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:read",
      client_name: "Claude Desktop",
    }),
  });
  expect(registerRes.status).toBe(201);
  const client = (await registerRes.json()) as { client_id: string; client_secret: string };

  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: codeChallenge(CODE_VERIFIER),
    code_challenge_method: "S256",
    state: "test-state",
    scope: "mcp:read",
    resource: `${BASE_URL}/mcp`,
  });
  const consent = await app.request(`/oauth/authorize?${params.toString()}`, { headers: { Cookie: cookie } });
  expect(consent.status).toBe(200);

  const approve = await app.request("/oauth/authorize", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE_URL,
    },
    body: new URLSearchParams({
      decision: "approve",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: codeChallenge(CODE_VERIFIER),
      scope: "mcp:read",
      state: "test-state",
      resource: `${BASE_URL}/mcp`,
    }).toString(),
  });
  expect(approve.status).toBe(302);
  const redirect = new URL(approve.headers.get("location") ?? REDIRECT_URI);
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("Missing authorization code");

  const tokenRes = await app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: CODE_VERIFIER,
    }).toString(),
  });
  expect(tokenRes.status).toBe(200);
  return (await tokenRes.json()) as { access_token: string; refresh_token: string };
}

async function createOAuthTokenForUser(userId: string) {
  const plaintext = generateOAuthAccessToken();
  const refreshToken = generateOAuthRefreshToken();
  const row = await createApiTokenRepository(db).createOAuth({
    userId,
    name: "Alice Laptop",
    tokenHash: hashApiToken(plaintext),
    prefix: getApiTokenDisplayPrefix(plaintext),
    clientId: "test-client",
    scopes: ["mcp:read"],
    refreshTokenHash: hashApiToken(refreshToken),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  return { plaintext, row };
}

describe("API token routes", () => {
  it("lists OAuth connections with the existing token response shape and does not issue PATs", async () => {
    const { cookie } = await setupSession("alice@example.com");
    const app = createApp(db, createTestConfig({ BASE_URL }), {
      logger: createTestLogger(),
    });

    const createRes = await app.request("/api/api-tokens", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice Laptop" }),
    });
    expect(createRes.status).toBe(404);

    await createOAuthGrant(app, cookie);

    const listRes = await app.request("/api/api-tokens", { headers: { Cookie: cookie } });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      tokens: Array<{ id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }>;
      mcpUrl: string;
    };
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens[0]).toMatchObject({
      name: "Claude Desktop",
      prefix: expect.stringMatching(/^sko_/),
      createdAt: expect.any(String),
      lastUsedAt: null,
    });
    expect(listed.mcpUrl).toBe(`${BASE_URL}/mcp`);
  });

  it("does not let one user revoke another user's token", async () => {
    const alice = await setupSession("alice@example.com");
    const bob = await setupSession("bob@example.com");
    const { plaintext, row } = await createOAuthTokenForUser(alice.user.id);
    const app = createApp(db, createTestConfig({}), { logger: createTestLogger() });

    const res = await app.request(`/api/api-tokens/${row.id}`, {
      method: "DELETE",
      headers: { Cookie: bob.cookie },
    });

    expect(res.status).toBe(404);
    expect(await createApiTokenRepository(db).findByHash(hashApiToken(plaintext))).toBeDefined();
  });

  it("revokes an OAuth connection and blocks subsequent MCP access with that token", async () => {
    const { cookie } = await setupSession("alice@example.com");
    const app = createApp(db, createTestConfig({ BASE_URL }), { logger: createTestLogger() });
    const tokenBody = await createOAuthGrant(app, cookie);
    const listRes = await app.request("/api/api-tokens", { headers: { Cookie: cookie } });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { tokens: Array<{ id: string; name: string }> };
    expect(listed.tokens).toEqual([expect.objectContaining({ name: "Claude Desktop" })]);
    const tokenId = listed.tokens[0]?.id;
    if (!tokenId) throw new Error("Missing listed OAuth token");

    const beforeRevoke = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(tokenBody.access_token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(beforeRevoke.status).toBe(200);

    const revokeRes = await app.request(`/api/api-tokens/${tokenId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(revokeRes.status).toBe(200);

    const afterRevoke = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(tokenBody.access_token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(afterRevoke.status).toBe(401);
  });
});
