import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import { LINKEDIN_CONVERSATION_FILE_TYPE } from "../connectors/linkedin-emission";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const ADMIN_EMAIL = "admin@example.com";
const MEMBER_EMAIL = "member@example.com";
const PASSWORD = "testpassword123";
const ACCOUNT_ID = "acct-1";

async function seedUsers(db: Kysely<DB>): Promise<string> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  const admin = await users.create({
    name: "Admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
  });
  await users.create({
    name: "Member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "member",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  return admin.id;
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error(`login failed ${res.status}: ${await res.text()}`);
  return cookie;
}

/** One pre-engine conversation: three legacy segments hanging off one profile file. */
async function seedLegacyConversation(
  db: Kysely<DB>,
  connectorConfigId: string,
  conversationUrn: string,
  leadId: string,
): Promise<void> {
  const repo = createConnectorRepository(db);
  const profileProviderFileId = `linkedin:${ACCOUNT_ID}:profile:${leadId}`;
  for (let segmentIndex = 0; segmentIndex < 3; segmentIndex++) {
    await repo.upsertFile({
      source: "linkedin_aimfox",
      providerFileId: `linkedin:${ACCOUNT_ID}:${conversationUrn}:segment-${segmentIndex}`,
      threadId: `${ACCOUNT_ID}:${conversationUrn}`,
      providerUrl: null,
      fileName: `LinkedIn conversation ${segmentIndex}`,
      fileType: LINKEDIN_CONVERSATION_FILE_TYPE,
      contentCategory: "document",
      content: "Hello",
      sourcePath: "LinkedIn / Priya Nair",
      contentHash: `hash-${conversationUrn}-${segmentIndex}`,
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      connectorConfigId,
      rollupGroupId: profileProviderFileId,
    });
  }
}

describe("LinkedIn reindex API", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let connectorConfigId: string;
  let queued: string[];

  async function createConnector(scopeConfig: Record<string, unknown>, ownerId: string): Promise<string> {
    const config = await createConnectorRepository(db).createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "key" }),
      scopeConfig: JSON.stringify({ accountIds: [ACCOUNT_ID], ...scopeConfig }),
      createdBy: ownerId,
    });
    return config.id;
  }

  beforeEach(async () => {
    db = await createTestDb();
    const adminId = await seedUsers(db);
    queued = [];
    app = createApp(db, createTestConfig(), {
      logger: createTestLogger(),
      queueLinkedinReindex: async (id) => {
        queued.push(id);
        return { conversationsQueued: 2, conversationsSkipped: 1, conversationsRearmed: 3 };
      },
    });
    connectorConfigId = await createConnector({ chunkEngine: true }, adminId);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("reports the conversations still on the old chunker and zeroed phase counts", async () => {
    await seedLegacyConversation(db, connectorConfigId, "urn:conversation:1", "lead-1");
    await seedLegacyConversation(db, connectorConfigId, "urn:conversation:2", "lead-2");
    const cookie = await login(app, ADMIN_EMAIL);

    const res = await app.request(`/api/connectors/${connectorConfigId}/reindexes/current`, { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      chunkEngineEnabled: true,
      phases: { pending: 0, fetched: 0, complete: 0, failed: 0, exhausted: 0 },
      legacyConversations: 2,
    });
  });

  it("queues a reindex and answers 202 with what it took on", async () => {
    const cookie = await login(app, ADMIN_EMAIL);

    const res = await app.request(`/api/connectors/${connectorConfigId}/reindexes`, {
      method: "POST",
      headers: { cookie },
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ conversationsQueued: 2, conversationsSkipped: 1, conversationsRearmed: 3 });
    expect(queued).toEqual([connectorConfigId]);
  });

  it("rejects a reindex with 409 while the engine is off, since nothing would drain", async () => {
    const adminId = (await createUserRepository(db).findByEmail(ADMIN_EMAIL))?.id ?? "";
    const disabledId = await createConnector({ chunkEngine: false }, adminId);
    const cookie = await login(app, ADMIN_EMAIL);

    const res = await app.request(`/api/connectors/${disabledId}/reindexes`, { method: "POST", headers: { cookie } });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CHUNK_ENGINE_DISABLED");
    expect(queued).toEqual([]);
  });

  it("takes the connector's stored switch over the deployment default in both directions", async () => {
    const adminId = (await createUserRepository(db).findByEmail(ADMIN_EMAIL))?.id ?? "";
    const engineOnByDefault = createApp(
      db,
      { ...createTestConfig(), LINKEDIN_CHUNK_ENGINE_ENABLED: true },
      {
        logger: createTestLogger(),
      },
    );
    const unsetId = await createConnector({}, adminId);
    const offId = await createConnector({ chunkEngine: false }, adminId);
    const cookie = await login(engineOnByDefault, ADMIN_EMAIL);

    const unset = await engineOnByDefault.request(`/api/connectors/${unsetId}/reindexes/current`, {
      headers: { cookie },
    });
    const off = await engineOnByDefault.request(`/api/connectors/${offId}/reindexes/current`, { headers: { cookie } });

    expect((await unset.json()).chunkEngineEnabled).toBe(true);
    expect((await off.json()).chunkEngineEnabled).toBe(false);
  });

  it("stores the switch without touching the rest of the scope config or the sync cursor", async () => {
    const repo = createConnectorRepository(db);
    await repo.updateConfig(connectorConfigId, { syncCursor: JSON.stringify({ version: 2, accounts: {} }) });
    const cookie = await login(app, ADMIN_EMAIL);

    const res = await app.request(`/api/connectors/${connectorConfigId}/chunk-engine`, {
      method: "PUT",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chunkEngineEnabled: false });
    const stored = await repo.findConfigById(connectorConfigId);
    expect(JSON.parse(stored?.scope_config ?? "{}")).toEqual({ accountIds: [ACCOUNT_ID], chunkEngine: false });
    expect(stored?.sync_cursor).toBe(JSON.stringify({ version: 2, accounts: {} }));
  });

  it("keeps every reindex route admin-only", async () => {
    const cookie = await login(app, MEMBER_EMAIL);

    const status = await app.request(`/api/connectors/${connectorConfigId}/reindexes/current`, { headers: { cookie } });
    const queue = await app.request(`/api/connectors/${connectorConfigId}/reindexes`, {
      method: "POST",
      headers: { cookie },
    });
    const toggle = await app.request(`/api/connectors/${connectorConfigId}/chunk-engine`, {
      method: "PUT",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect([status.status, queue.status, toggle.status]).toEqual([403, 403, 403]);
    expect(queued).toEqual([]);
  });

  it("404s for a connector that is not LinkedIn", async () => {
    const adminId = (await createUserRepository(db).findByEmail(ADMIN_EMAIL))?.id ?? "";
    const other = await createConnectorRepository(db).createConfig({
      connectorType: "fireflies",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "key" }),
      createdBy: adminId,
    });
    const cookie = await login(app, ADMIN_EMAIL);

    const res = await app.request(`/api/connectors/${other.id}/reindexes/current`, { headers: { cookie } });

    expect(res.status).toBe(404);
  });
});
