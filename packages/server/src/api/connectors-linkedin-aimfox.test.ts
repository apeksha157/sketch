import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import { resetRpmPacerForTests } from "../connectors/rpm-pacer";
import { runConnectorSync } from "../connectors/sync";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const EMAIL = "member@example.com";
const ADMIN_EMAIL = "admin@example.com";
const PASSWORD = "testpassword123";

function aimfoxAccountsResponse(accounts: Array<{ id: string }>): Response {
  return new Response(
    JSON.stringify({
      status: "ok",
      accounts: accounts.map((account) => ({
        id: account.id,
        urn: `urn:li:${account.id}`,
        full_name: account.id,
        public_identifier: account.id,
        picture_url: "",
        state: "active",
        disabled: false,
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function seedUser(db: Kysely<DB>): Promise<string> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await users.create({
    name: "Admin",
    email: "admin@example.com",
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
  });
  const user = await users.create({
    name: "Member",
    email: EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "member",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  return user.id;
}

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed ${res.status}: ${await res.text()}`);
  }
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("login did not set a cookie");
  return cookie;
}

describe("LinkedIn Aimfox connector API", () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    resetRpmPacerForTests();
    db = await createTestDb();
    userId = await seedUser(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("connects with a workspace Aimfox key and stores discovered account ids in scope_config", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(aimfoxAccountsResponse([{ id: "acct-1" }, { id: "acct-2" }]));
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const res = await app.request("/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        connectorType: "linkedin_aimfox",
        authType: "api_key",
        credentials: { api_key: "aimfox-key" },
        scopeConfig: { maxConversations: 12, visibility: "workspace" },
      }),
    });

    expect(res.status).toBe(201);
    const configs = await createConnectorRepository(db).findConfigsByType("linkedin_aimfox");
    expect(configs).toHaveLength(1);
    expect(JSON.parse(configs[0].credentials)).toEqual({ type: "api_key", api_key: "aimfox-key" });
    expect(JSON.parse(configs[0].scope_config)).toEqual({
      accountIds: ["acct-1", "acct-2"],
      maxConversations: 12,
      visibility: "workspace",
    });
  });

  it("rejects LinkedIn Aimfox create without a visibility choice", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(aimfoxAccountsResponse([{ id: "acct-1" }]));
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const res = await app.request("/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        connectorType: "linkedin_aimfox",
        authType: "api_key",
        credentials: { api_key: "aimfox-key" },
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.message).toBe("LinkedIn visibility is required");
  });

  it("rejects invalid LinkedIn Aimfox visibility on create", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(aimfoxAccountsResponse([{ id: "acct-1" }]));
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const res = await app.request("/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        connectorType: "linkedin_aimfox",
        authType: "api_key",
        credentials: { api_key: "aimfox-key" },
        scopeConfig: { visibility: "team" },
      }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects Aimfox keys with no connected LinkedIn accounts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(aimfoxAccountsResponse([]));
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const res = await app.request("/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        connectorType: "linkedin_aimfox",
        authType: "api_key",
        credentials: { api_key: "aimfox-key" },
        scopeConfig: { visibility: "workspace" },
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("NO_ACCOUNTS");
  });

  it("rediscovers account scope when rotating the key and preserves visibility", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(aimfoxAccountsResponse([{ id: "acct-2" }, { id: "acct-3" }]));
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "stored-key" }),
      scopeConfig: JSON.stringify({ accountIds: ["acct-2"], visibility: "workspace" }),
      createdBy: userId,
    });
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const res = await app.request(`/api/connectors/${config.id}/rotate-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ api_key: "rotated-key" }),
    });

    expect(res.status).toBe(200);
    const updated = await repo.findConfigById(config.id);
    expect(JSON.parse(updated?.scope_config ?? "{}")).toEqual({
      accountIds: ["acct-2", "acct-3"],
      visibility: "workspace",
    });
    expect(JSON.parse(updated?.credentials ?? "{}")).toEqual({ type: "api_key", api_key: "rotated-key" });
  });

  it("allows disconnecting and reconnecting the workspace connector", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => aimfoxAccountsResponse([{ id: "acct-1" }]));
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);
    const connectBody = JSON.stringify({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: { api_key: "aimfox-key" },
      scopeConfig: { visibility: "workspace" },
    });

    const first = await app.request("/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: connectBody,
    });
    const firstBody = await first.json();
    const disconnected = await app.request(`/api/connectors/${firstBody.connector.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const second = await app.request("/api/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: connectBody,
    });

    expect(first.status).toBe(201);
    expect(disconnected.status).toBe(200);
    expect(second.status).toBe(201);
  });

  it("rejects visibility changes through the scope PATCH", async () => {
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "stored-key" }),
      scopeConfig: JSON.stringify({ accountIds: ["acct-1"], visibility: "owner" }),
      createdBy: userId,
    });
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const res = await app.request(`/api/connectors/${config.id}/scope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ scopeConfig: { visibility: "workspace" } }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.message).toBe("LinkedIn visibility must be changed with PUT /api/connectors/:id/visibility");
  });

  it("flips LinkedIn visibility in both directions and reconciles grants without touching the cursor", async () => {
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "stored-key" }),
      scopeConfig: JSON.stringify({ accountIds: ["acct-1"], visibility: "owner" }),
      syncStatus: "active",
      createdBy: userId,
    });
    await repo.updateConfig(config.id, { syncCursor: "cursor-v1" });
    await seedLinkedinFiles(db, config.id, ["member@example.com"]);
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const workspace = await app.request(`/api/connectors/${config.id}/visibility`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ visibility: "workspace" }),
    });
    const owner = await app.request(`/api/connectors/${config.id}/visibility`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ visibility: "owner" }),
    });

    expect(workspace.status).toBe(200);
    expect(owner.status).toBe(200);
    expect(await linkedinGrantValues(db, config.id)).toEqual(["member@example.com", "member@example.com"]);
    const updated = await repo.findConfigById(config.id);
    expect(JSON.parse(updated?.scope_config ?? "{}")).toMatchObject({ visibility: "owner" });
    expect(updated?.sync_cursor).toBe("cursor-v1");
  });

  it("same-mode LinkedIn visibility flip removes stale principals and stray access scopes", async () => {
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "stored-key" }),
      scopeConfig: JSON.stringify({ accountIds: ["acct-1"], visibility: "owner" }),
      createdBy: userId,
    });
    await seedLinkedinFiles(db, config.id, ["member@example.com", "other@example.com"], "linkedin-stray-scope");
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const res = await app.request(`/api/connectors/${config.id}/visibility`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ visibility: "owner" }),
    });

    expect(res.status).toBe(200);
    expect(await linkedinGrantValues(db, config.id)).toEqual(["member@example.com", "member@example.com"]);
    const scoped = await db
      .selectFrom("indexed_files")
      .select("access_scope_id")
      .where("connector_config_id", "=", config.id)
      .execute();
    expect(scoped.map((file) => file.access_scope_id)).toEqual([null, null]);
  });

  it("returns 409 and leaves rows unchanged when owner email is unavailable", async () => {
    await db.insertInto("users").values({ id: "missing-owner-email", name: "No Email", email: null }).execute();
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "stored-key" }),
      scopeConfig: JSON.stringify({ accountIds: ["acct-1"], visibility: "owner" }),
      createdBy: "missing-owner-email",
    });
    await seedLinkedinFiles(db, config.id, ["member@example.com"]);
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const res = await app.request(`/api/connectors/${config.id}/visibility`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ visibility: "workspace" }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("OWNER_EMAIL_UNAVAILABLE");
    expect(JSON.parse((await repo.findConfigById(config.id))?.scope_config ?? "{}")).toMatchObject({
      visibility: "owner",
    });
    expect(await linkedinGrantValues(db, config.id)).toEqual(["member@example.com", "member@example.com"]);
  });

  it("returns 409 and leaves rows unchanged while LinkedIn is syncing", async () => {
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "stored-key" }),
      scopeConfig: JSON.stringify({ accountIds: ["acct-1"], visibility: "owner" }),
      syncStatus: "syncing",
      createdBy: userId,
    });
    await seedLinkedinFiles(db, config.id, ["member@example.com"]);
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const res = await app.request(`/api/connectors/${config.id}/visibility`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ visibility: "workspace" }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SYNC_IN_PROGRESS");
    expect(JSON.parse((await repo.findConfigById(config.id))?.scope_config ?? "{}")).toMatchObject({
      visibility: "owner",
    });
    expect(await linkedinGrantValues(db, config.id)).toEqual(["member@example.com", "member@example.com"]);
  });

  it("updates only the enrichment block and leaves the sync cursor alone", async () => {
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "stored-key" }),
      scopeConfig: JSON.stringify({
        accountIds: ["acct-1"],
        visibility: "workspace",
        maxConversations: 12,
        enrichment: { enabled: true, batch: 20 },
      }),
      syncStatus: "active",
      createdBy: userId,
    });
    await repo.updateConfig(config.id, { syncCursor: "cursor-v1" });
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const res = await app.request(`/api/connectors/${config.id}/enrichment`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ enabled: false, dailyCap: 10, autoMerge: true }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.connector.scopeConfig).toEqual({
      accountIds: ["acct-1"],
      visibility: "workspace",
      maxConversations: 12,
      enrichment: { enabled: false, dailyCap: 10, batch: 20, autoMerge: true },
    });
    const updated = await repo.findConfigById(config.id);
    expect(JSON.parse(updated?.scope_config ?? "{}")).toEqual(body.connector.scopeConfig);
    expect(updated?.sync_cursor).toBe("cursor-v1");
  });

  it("rejects a negative daily cap and keeps the stored enrichment block", async () => {
    const repo = createConnectorRepository(db);
    const stored = { accountIds: ["acct-1"], visibility: "owner", enrichment: { enabled: true, dailyCap: 25 } };
    const config = await repo.createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "stored-key" }),
      scopeConfig: JSON.stringify(stored),
      syncStatus: "active",
      createdBy: userId,
    });
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const res = await app.request(`/api/connectors/${config.id}/enrichment`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ enabled: true, dailyCap: -1, autoMerge: false }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const updated = await repo.findConfigById(config.id);
    expect(JSON.parse(updated?.scope_config ?? "{}")).toEqual(stored);
  });

  it("returns scopeConfig on /mine for LinkedIn rows only", async () => {
    const repo = createConnectorRepository(db);
    const admin = await createUserRepository(db).findByEmail(ADMIN_EMAIL);
    if (!admin) throw new Error("admin user missing");
    await repo.createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "stored-key" }),
      scopeConfig: JSON.stringify({ accountIds: ["acct-1"], visibility: "owner", enrichment: { enabled: true } }),
      syncStatus: "active",
      createdBy: admin.id,
    });
    await repo.createConfig({
      connectorType: "fireflies",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "ff-key" }),
      scopeConfig: JSON.stringify({ initialDays: 30 }),
      syncStatus: "active",
      createdBy: admin.id,
    });
    const app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    const cookie = await login(app);

    const res = await app.request("/api/connectors/mine", { headers: { Cookie: cookie } });
    const body = await res.json();

    expect(res.status).toBe(200);
    const byType = Object.fromEntries(
      body.connectors.map((row: { connectorType: string; scopeConfig?: unknown }) => [row.connectorType, row]),
    );
    expect(byType.linkedin_aimfox.scopeConfig).toEqual({
      accountIds: ["acct-1"],
      visibility: "owner",
      enrichment: { enabled: true },
    });
    expect(byType.fireflies).not.toHaveProperty("scopeConfig");
  });

  it("conversation sync completes active with no conversations", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ status: "ok", accounts: [], conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "stored-key" }),
      scopeConfig: JSON.stringify({ accountIds: ["acct-1"], maxRpm: 100_000 }),
      createdBy: userId,
    });

    const result = await runConnectorSync(db, config.id, createTestLogger());
    const updated = await repo.findConfigById(config.id);

    expect(result).toMatchObject({ itemsProcessed: 0, itemsCreated: 0, itemsUpdated: 0, errors: [] });
    expect(updated?.sync_status).toBe("active");
    expect(
      await db.selectFrom("indexed_files").select("id").where("connector_config_id", "=", config.id).execute(),
    ).toEqual([]);
  });

  it("records a lead detail error and continues the sync", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/conversations?")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            conversations: [
              {
                unread_count: 0,
                connected: true,
                last_activity_at: 1_779_912_000_000,
                conversation_urn: "urn:conversation:ok",
                last_message: null,
                participants: [{ id: "lead-ok", full_name: "Alice Smith" }],
                owner: "acct-1",
                source: "linkedin",
              },
              {
                unread_count: 0,
                connected: true,
                last_activity_at: 1_779_912_000_000,
                conversation_urn: "urn:conversation:missing",
                last_message: null,
                participants: [{ id: "lead-missing", full_name: "Missing Lead" }],
                owner: "acct-1",
                source: "linkedin",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/leads/lead-missing")) return new Response("missing", { status: 404 });
      if (url.includes("/accounts/acct-1/conversations/")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            messages: [
              {
                body: "Hello",
                sender: { id: "lead-ok", full_name: "Alice Smith" },
                created_at: 1_779_912_000_000,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ status: "ok", lead: aimfoxLead("lead-ok", "Alice Smith", "alice-smith") }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "stored-key" }),
      scopeConfig: JSON.stringify({ accountIds: ["acct-1"], maxRpm: 100_000 }),
      createdBy: userId,
    });

    const result = await runConnectorSync(db, config.id, createTestLogger());
    const updated = await repo.findConfigById(config.id);

    expect(result.itemsProcessed).toBe(2);
    expect(result.itemsCreated).toBe(2);
    expect(result.errors).toEqual([]);
    expect(updated?.sync_cursor).toContain("2026-05-27T20:00:00.000Z");
    expect(updated?.sync_status).toBe("active");
  });

  it("keeps profile and message file sync idempotent across re-runs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/conversations?")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            conversations: [
              {
                unread_count: 0,
                connected: true,
                last_activity_at: 1_779_912_000_000,
                conversation_urn: "urn:conversation:idempotent",
                last_message: null,
                participants: [{ id: "lead-idempotent", full_name: "Alice Smith" }],
                owner: "acct-1",
                source: "linkedin",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/accounts/acct-1/conversations/")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            messages: [
              {
                id: "msg-1",
                body: "Hello",
                sender: { id: "lead-idempotent", full_name: "Alice Smith" },
                created_at: 1_779_912_000_000,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          status: "ok",
          lead: aimfoxLead("lead-idempotent", "Alice Smith", "alice-smith", "alice@example.com"),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    const repo = createConnectorRepository(db);
    const config = await repo.createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "stored-key" }),
      scopeConfig: JSON.stringify({ accountIds: ["acct-1"], maxRpm: 100_000 }),
      createdBy: userId,
    });

    const first = await runConnectorSync(db, config.id, createTestLogger());
    const hashAfterFirst = await db
      .selectFrom("indexed_files")
      .select(["provider_file_id", "content_hash"])
      .where("connector_config_id", "=", config.id)
      .orderBy("provider_file_id")
      .execute();
    const second = await runConnectorSync(db, config.id, createTestLogger());
    const files = await db
      .selectFrom("indexed_files")
      .select(["provider_file_id", "content_hash"])
      .where("connector_config_id", "=", config.id)
      .orderBy("provider_file_id")
      .execute();

    expect(first).toMatchObject({ itemsProcessed: 2, itemsCreated: 2, itemsUpdated: 0, errors: [] });
    expect(second).toMatchObject({ itemsProcessed: 2, itemsCreated: 0, itemsUpdated: 0, errors: [] });
    expect(files).toEqual(hashAfterFirst);
    expect(files).toEqual([
      {
        provider_file_id: "linkedin:acct-1:profile:lead-idempotent",
        content_hash: expect.any(String),
      },
      {
        provider_file_id: "linkedin:acct-1:urn:conversation:idempotent:segment-0",
        content_hash: expect.any(String),
      },
    ]);
  });
});

function aimfoxLead(id: string, fullName: string, publicIdentifier: string, email?: string) {
  const [firstName = "", ...rest] = fullName.split(" ");
  return {
    id,
    urn: `urn:li:${id}`,
    first_name: firstName,
    last_name: rest.join(" "),
    full_name: fullName,
    public_identifier: publicIdentifier,
    occupation: "Founder",
    picture_url: "",
    location: null,
    about: null,
    premium: false,
    connections: 0,
    followers: 0,
    current_experience: [],
    work_experience: [],
    education: [],
    skills: [],
    certifications: [],
    languages: [],
    contact_info: {},
    phones: [],
    email,
    emails: email ? [{ address: email, type: "work" }] : [],
    labels: [],
    notes: [],
    is_lead: true,
    lead_of: [],
    origins: [],
  };
}

async function seedLinkedinFiles(
  db: Kysely<DB>,
  connectorConfigId: string,
  grantEmails: string[],
  accessScopeId?: string,
): Promise<void> {
  if (accessScopeId) {
    await db
      .insertInto("access_scopes")
      .values({
        id: accessScopeId,
        connector_config_id: connectorConfigId,
        scope_type: "linkedin",
        provider_scope_id: accessScopeId,
        label: "LinkedIn stray scope",
      })
      .execute();
  }
  const now = new Date().toISOString();
  const files = [
    {
      id: `${connectorConfigId}-profile`,
      provider_file_id: "linkedin:acct-1:profile:lead-1",
      file_name: "LinkedIn profile - Lead One",
      file_type: "linkedin_profile",
      content_category: "structured",
      content: "{}",
    },
    {
      id: `${connectorConfigId}-segment`,
      provider_file_id: "linkedin:acct-1:urn:conversation:one:segment-0",
      file_name: "LinkedIn: Owner <> Lead One",
      file_type: "linkedin_conversation",
      content_category: "document",
      content: "LinkedIn visibility sentinel",
    },
  ];
  await db
    .insertInto("indexed_files")
    .values(
      files.map((file) => ({
        ...file,
        connector_config_id: connectorConfigId,
        source: "linkedin_aimfox",
        content_category: file.content_category as "document" | "structured",
        content_hash: `hash-${file.id}`,
        source_updated_at: now,
        synced_at: now,
        access_scope_id: accessScopeId ?? null,
      })),
    )
    .execute();

  if (grantEmails.length === 0) return;
  await db
    .insertInto("file_access")
    .values(
      files.flatMap((file) =>
        grantEmails.map((email) => ({
          indexed_file_id: file.id,
          principal_type: "email" as const,
          principal_value: email,
        })),
      ),
    )
    .execute();
}

async function linkedinGrantValues(db: Kysely<DB>, connectorConfigId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("indexed_files")
    .innerJoin("file_access", "file_access.indexed_file_id", "indexed_files.id")
    .select("file_access.principal_value")
    .where("indexed_files.connector_config_id", "=", connectorConfigId)
    .where("indexed_files.source", "=", "linkedin_aimfox")
    .orderBy("file_access.principal_value")
    .orderBy("indexed_files.id")
    .execute();
  return rows.map((row) => row.principal_value);
}
