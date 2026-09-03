import type { ManagedIntegrationAppId } from "@sketch/shared";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentEnvironmentVariableRepository } from "../../db/repositories/agent-environment-variables";
import type { DB } from "../../db/schema";
import { createTestDb } from "../../test-utils";
import { createCliIntegrationService } from "./service";

const {
  assertGithubCliAvailableMock,
  validateGithubTokenInputMock,
  verifyGithubTokenMock,
  validateLinearApiKeyInputMock,
  verifyLinearApiKeyMock,
} = vi.hoisted(() => ({
  assertGithubCliAvailableMock: vi.fn(),
  validateGithubTokenInputMock: vi.fn(),
  verifyGithubTokenMock: vi.fn(),
  validateLinearApiKeyInputMock: vi.fn(),
  verifyLinearApiKeyMock: vi.fn(),
}));

vi.mock("./github", () => ({
  assertGithubCliAvailable: assertGithubCliAvailableMock,
  validateGithubTokenInput: validateGithubTokenInputMock,
  verifyGithubToken: verifyGithubTokenMock,
}));

vi.mock("./linear", () => ({
  validateLinearApiKeyInput: validateLinearApiKeyInputMock,
  verifyLinearApiKey: verifyLinearApiKeyMock,
}));

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("CLI integration service", () => {
  let db: Kysely<DB>;
  let service: ReturnType<typeof createCliIntegrationService>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await createTestDb();
    await db
      .insertInto("users")
      .values([
        { id: "owner", name: "Owner", email: "owner@example.com", type: "human" },
        { id: "recipient", name: "Recipient", email: "recipient@example.com", type: "human" },
        { id: "external", name: "External", email: "external@example.com", type: "external" },
      ])
      .execute();
    assertGithubCliAvailableMock.mockResolvedValue(undefined);
    verifyGithubTokenMock.mockResolvedValue({
      externalId: "123",
      login: "octocat",
      avatarUrl: "https://github.com/octocat.png",
      accountType: "User",
    });
    verifyLinearApiKeyMock.mockResolvedValue({
      externalId: "usr_123",
      login: "Ada Lovelace",
      name: "Ada Lovelace",
      email: "ada@example.com",
      avatarUrl: "https://linear.app/avatar.png",
      accountType: "User",
    });
    service = createCliIntegrationService({
      db,
      encryptionKey: ENCRYPTION_KEY,
      environmentVariables: createAgentEnvironmentVariableRepository(db, ENCRYPTION_KEY),
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates an encrypted connection, updates access, and disconnects atomically", async () => {
    const connection = await service.connectGitHub("owner", "  ghp_old  ");

    expect(connection).toMatchObject({
      appId: "github",
      executionMode: "cli",
      accountLogin: "octocat",
      status: "active",
      shares: [],
    });
    expect(JSON.stringify(connection)).not.toContain("ghp_old");

    const variable = await db
      .selectFrom("agent_environment_variables")
      .select(["id", "value"])
      .where("id", "=", connection.id)
      .executeTakeFirst();
    const linkedVariable = await db
      .selectFrom("agent_environment_variables")
      .select(["id", "value"])
      .where("name", "=", "GH_TOKEN")
      .where("user_id", "=", "owner")
      .executeTakeFirstOrThrow();
    expect(variable).toBeUndefined();
    expect(linkedVariable.value.startsWith("enc:")).toBe(true);

    const updated = await service.replaceShares("owner", connection.id, [
      { type: "user", id: "recipient" },
      { type: "org", id: "default" },
    ]);
    expect(updated.shares).toEqual([
      { type: "org", id: "default" },
      { type: "user", id: "recipient" },
    ]);

    const recipientConnections = await service.listConnections("recipient");
    expect(recipientConnections[0]).toMatchObject({ isOwnedByViewer: false, canUse: true, canManage: false });

    const runtimeEnv = await service.filterRuntimeEnvironment(
      {
        currentUserId: "recipient",
        contextType: "channel_mention",
        allowOrgSharedEnv: true,
        taskContext: {
          platform: "slack",
          contextType: "channel",
          deliveryTarget: "C123",
          createdBy: "recipient",
        },
      },
      { GH_TOKEN: "ghp_old" },
    );
    expect(runtimeEnv).toEqual({});

    await service.disconnect("owner", connection.id);
    expect(await db.selectFrom("cli_integration_connections").selectAll().execute()).toEqual([]);
    expect(
      await db.selectFrom("agent_environment_variables").selectAll().where("name", "=", "GH_TOKEN").execute(),
    ).toEqual([]);
    expect(await db.selectFrom("agent_environment_variable_shares").selectAll().execute()).toEqual([]);
  });

  it("creates and replaces a managed Linear API connection", async () => {
    const connection = await service.connectLinear("owner", "  lin_old  ", [{ type: "user", id: "recipient" }]);

    expect(connection).toMatchObject({
      appId: "linear",
      executionMode: "api",
      accountLogin: "Ada Lovelace",
      status: "active",
      shares: [{ type: "user", id: "recipient" }],
    });
    const variable = await db
      .selectFrom("agent_environment_variables")
      .select("value")
      .where("name", "=", "LINEAR_API_KEY")
      .where("user_id", "=", "owner")
      .executeTakeFirstOrThrow();
    expect(variable.value.startsWith("enc:")).toBe(true);

    const updated = await service.replaceShares("owner", connection.id, [{ type: "org", id: "default" }]);
    expect(updated.shares).toEqual([{ type: "org", id: "default" }]);

    const runtimeEnv = await service.filterRuntimeEnvironment(
      { currentUserId: "recipient", contextType: "dm", allowOrgSharedEnv: true },
      { LINEAR_API_KEY: "stale" },
    );
    expect(runtimeEnv).toEqual({});

    await service.updateLinearApiKey("owner", connection.id, "lin_new");
    expect(verifyLinearApiKeyMock).toHaveBeenLastCalledWith("lin_new");
    expect(
      await service.resolveAvailability({ currentUserId: "recipient", contextType: "dm", allowOrgSharedEnv: true }),
    ).toEqual([]);
    await service.disconnect("owner", connection.id);
  });

  it("does not list shared connections to external viewers", async () => {
    const connection = await service.connectGitHub("owner", "ghp_org", [{ type: "org", id: "default" }]);

    await expect(service.listConnections("external")).resolves.toEqual([]);
    await service.disconnect("owner", connection.id);
  });

  it("gates each managed provider independently during skill preflight", async () => {
    const availableManagedIntegrations = new Set<ManagedIntegrationAppId>(["github"]);
    const managedService = createCliIntegrationService({
      db,
      encryptionKey: ENCRYPTION_KEY,
      environmentVariables: createAgentEnvironmentVariableRepository(db, ENCRYPTION_KEY),
      getAvailableManagedIntegrations: async () => availableManagedIntegrations,
    });

    await expect(
      managedService.validateAgentSkills("owner", ["github", "linear", "clickup"], {
        platform: "slack",
        contextType: "dm",
        deliveryTarget: "D123",
        createdBy: "owner",
      }),
    ).resolves.toEqual(["linear", "clickup"]);
  });

  it("ignores legacy conversation shares and uses the invoking user's access", async () => {
    const connection = await service.connectGitHub("owner", "ghp_shared");
    const variable = await db
      .selectFrom("agent_environment_variables")
      .select("id")
      .where("name", "=", "GH_TOKEN")
      .where("user_id", "=", "owner")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("agent_environment_variable_shares")
      .values([
        {
          id: "legacy-slack",
          variable_id: variable.id,
          variable_name: "GH_TOKEN",
          target_type: "slack_channel",
          target_id: "C123",
          created_by: "owner",
        },
        {
          id: "legacy-whatsapp",
          variable_id: variable.id,
          variable_name: "GH_TOKEN",
          target_type: "whatsapp_group",
          target_id: "group@g.us",
          created_by: "owner",
        },
      ])
      .execute();

    await expect(
      service.filterRuntimeEnvironment(
        {
          currentUserId: "recipient",
          contextType: "channel_mention",
          allowOrgSharedEnv: true,
          taskContext: {
            platform: "slack",
            contextType: "channel",
            deliveryTarget: "C123",
            createdBy: "recipient",
          },
        },
        { GH_TOKEN: "stale" },
      ),
    ).resolves.toEqual({});
    await service.disconnect("owner", connection.id);
  });

  it("does not report an org-shared legacy GitHub token as runtime availability", async () => {
    const connection = await service.connectGitHub("owner", "ghp_org", [{ type: "org", id: "default" }]);

    const runtimeEnv = await service.filterRuntimeEnvironment(
      { currentUserId: "recipient", contextType: "dm", allowOrgSharedEnv: true },
      { GH_TOKEN: "stale-value" },
    );

    expect(runtimeEnv).toEqual({});
    expect(await service.resolveAvailability({ currentUserId: "recipient", contextType: "dm" })).toEqual([]);
    await service.disconnect("owner", connection.id);
  });

  it("does not expose an org-shared GitHub token to external users", async () => {
    const connection = await service.connectGitHub("owner", "ghp_org", [{ type: "org", id: "default" }]);

    const runtimeEnv = await service.filterRuntimeEnvironment(
      { currentUserId: "external", contextType: "dm", allowOrgSharedEnv: true },
      { GH_TOKEN: "ghp_org" },
    );

    expect(runtimeEnv).toEqual({});
    expect(await service.resolveAvailability({ currentUserId: "external", contextType: "dm" })).toEqual([]);
    await service.disconnect("owner", connection.id);
  });

  it("explains that an existing GH_TOKEN must be removed before connecting", async () => {
    await db
      .insertInto("agent_environment_variables")
      .values({
        id: "existing-gh-token",
        user_id: "owner",
        name: "GH_TOKEN",
        value: "existing-token",
        is_secret: 1,
      })
      .execute();

    await expect(service.connectGitHub("owner", "ghp_new")).rejects.toMatchObject({
      code: "MANAGED_ENVIRONMENT_VARIABLE",
      status: 409,
      message: "You already have an environment variable named GH_TOKEN. Remove it before connecting GitHub.",
    });
  });

  it("rejects duplicates and preserves the old token when replacement verification fails", async () => {
    const connection = await service.connectGitHub("owner", "ghp_old");
    await expect(service.connectGitHub("owner", "ghp_second")).rejects.toMatchObject({
      code: "ALREADY_CONNECTED",
      status: 409,
    });

    const before = await db
      .selectFrom("agent_environment_variables")
      .select("value")
      .where("name", "=", "GH_TOKEN")
      .where("user_id", "=", "owner")
      .executeTakeFirstOrThrow();
    verifyGithubTokenMock.mockRejectedValueOnce({ code: "INVALID_TOKEN" });

    await expect(service.updateGitHubToken("owner", connection.id, "ghp_bad")).rejects.toMatchObject({
      code: "INVALID_TOKEN",
      status: 401,
    });

    const after = await db
      .selectFrom("agent_environment_variables")
      .select("value")
      .where("name", "=", "GH_TOKEN")
      .where("user_id", "=", "owner")
      .executeTakeFirstOrThrow();
    expect(after.value).toBe(before.value);
  });
});
