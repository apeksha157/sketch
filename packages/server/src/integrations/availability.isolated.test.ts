import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationConnection, ManagedIntegrationAppId } from "@sketch/shared";
import type { ModelMessage, ToolSet } from "ai";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanUseTool } from "../agent/permissions";
import { buildRuntimeCapabilitiesContext, buildSystemContext } from "../agent/prompt";
import type { RunAgentParams } from "../agent/runner";
import { DefaultAgentRuntimeSkillsProvider } from "../agent/runtime/skills";
import { createSketchMcpToolDefinitions } from "../agent/sketch-tools";
import { UploadCollector } from "../agent/tools/types";
import { createAgentEnvironmentVariableRepository } from "../db/repositories/agent-environment-variables";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { listAvailableManagedIntegrations } from "./availability";
import { createCliIntegrationService } from "./cli/service";
import type { IntegrationProvider } from "./types";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

type ExecutableSdkTool = {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
};

async function executeAiTool(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const selectedTool = tools[name] as
    | {
        execute?: (
          input: unknown,
          options: { toolCallId: string; messages: ModelMessage[]; context: undefined },
        ) => unknown;
      }
    | undefined;
  if (!selectedTool?.execute) throw new Error(`Tool is not executable: ${name}`);
  return await selectedTool.execute(input, { toolCallId: "availability-matrix", messages: [], context: undefined });
}

function connection(
  appId: string,
  overrides: Partial<Pick<IntegrationConnection, "status" | "canUse" | "healthy">> = {},
): IntegrationConnection {
  return {
    id: `${appId}-account`,
    providerId: "canvas-provider",
    source: "canvas_user_secrets",
    executionMode: "canvas",
    appId,
    appName: appId,
    status: "active",
    canUse: true,
    createdAt: "2026-08-27T00:00:00.000Z",
    connectedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

function provider(listConnections: IntegrationProvider["listConnections"]): IntegrationProvider {
  return {
    type: "canvas",
    providerId: "canvas-provider",
    listConnections,
  } as IntegrationProvider;
}

describe("managed integration availability matrix", () => {
  let root: string;
  let workspaceDir: string;
  let claudeConfigDir: string;
  let db: Kysely<DB>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sketch-managed-availability-"));
    workspaceDir = join(root, "workspace");
    claudeConfigDir = join(root, "claude");
    await mkdir(workspaceDir, { recursive: true });
    for (const integration of ["github", "linear", "clickup"]) {
      const skillDir = join(claudeConfigDir, "skills", integration);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---\ndescription: ${integration} managed skill\n---\n${integration} skill body`,
      );
    }
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  });

  it("uses the sharing context once and counts only active usable connections", async () => {
    const listConnections = vi
      .fn()
      .mockResolvedValue([
        connection("github"),
        connection("linear-app", { status: "error" }),
        connection("linear_app", { canUse: false }),
        connection("linear-oauth", { healthy: false }),
      ]);
    const loadIntegrationProvider = vi.fn().mockResolvedValue(provider(listConnections));

    const available = await listAvailableManagedIntegrations({
      loadIntegrationProvider,
      userEmail: "user@example.com",
      currentUserId: "user-1",
    });

    expect([...available]).toEqual(["github"]);
    expect(loadIntegrationProvider).toHaveBeenCalledOnce();
    expect(listConnections).toHaveBeenCalledOnce();
    expect(listConnections).toHaveBeenCalledWith("user@example.com", undefined, {
      workspaceId: "canvas-provider",
      userId: "user-1",
    });
  });

  it.each([
    { appId: "github-oauth", expected: "github" as const },
    { appId: "linear-oauth", expected: "linear" as const },
    { appId: "linear-app", expected: "linear" as const },
    { appId: "linear_app", expected: "linear" as const },
  ])("normalizes the Canvas alias $appId", async ({ appId, expected }) => {
    const available = await listAvailableManagedIntegrations({
      loadIntegrationProvider: async () => provider(vi.fn().mockResolvedValue([connection(appId)])),
      userEmail: "user@example.com",
      currentUserId: "user-1",
    });

    expect(available).toEqual(new Set([expected]));
  });

  it("fails closed when Canvas connection discovery times out", async () => {
    const logger = { warn: vi.fn() };
    const listConnections = vi.fn().mockRejectedValue(new DOMException("Request timed out", "TimeoutError"));
    const availability = listAvailableManagedIntegrations({
      loadIntegrationProvider: vi.fn().mockResolvedValue(provider(listConnections)),
      userEmail: "user@example.com",
      currentUserId: "user-1",
      logger,
    });

    await expect(availability).resolves.toEqual(new Set());
    expect(logger.warn).toHaveBeenCalledWith(
      { event: "managed_integration_availability_failed", reason: "provider_error" },
      "Managed integration availability lookup failed closed",
    );
  });

  it("fails closed without exposing a provider error in logs", async () => {
    const logger = { warn: vi.fn() };

    await expect(
      listAvailableManagedIntegrations({
        loadIntegrationProvider: async () => {
          throw new Error("provider failure with token-value-sentinel");
        },
        userEmail: "user@example.com",
        currentUserId: "user-1",
        logger,
      }),
    ).resolves.toEqual(new Set());

    expect(logger.warn).toHaveBeenCalledWith(
      { event: "managed_integration_availability_failed", reason: "provider_error" },
      "Managed integration availability lookup failed closed",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("token-value-sentinel");
  });

  it.each(
    (["github", "linear", "clickup"] as const).flatMap((integration) => [
      { integration, connected: false },
      { integration, connected: true },
    ]),
  )("keeps $integration fail-closed across every runtime layer when connected=$connected", async (row) => {
    const available = new Set<ManagedIntegrationAppId>(row.connected ? [row.integration] : []);
    const toolNames = { github: "github_cli", linear: "linear_api", clickup: "clickup_api" };
    const toolName = toolNames[row.integration];
    const otherToolNames = Object.values(toolNames).filter((name) => name !== toolName);
    const prompt = `${buildSystemContext({
      platform: "slack",
      availableManagedIntegrations: available,
    })}\n${buildRuntimeCapabilitiesContext(undefined, available)}`;

    expect(prompt.includes(toolName)).toBe(row.connected);
    for (const name of otherToolNames) expect(prompt).not.toContain(name);

    const canUseTool = createCanUseTool(workspaceDir, createTestLogger(), claudeConfigDir, {
      availableManagedIntegrations: available,
    });
    const sdkPermission = await canUseTool("Skill", { skill: row.integration });
    expect(sdkPermission.behavior).toBe(row.connected ? "allow" : "deny");

    const skillsProvider = new DefaultAgentRuntimeSkillsProvider();
    const skillTools = await skillsProvider.createSkillTool({
      db,
      workspaceKey: "user-1",
      userMessage: "test managed availability",
      workspaceDir,
      claudeConfigDir,
      userName: "User",
      platform: "slack",
      onProgressEvent: async () => {},
      availableManagedIntegrations: available,
      logger: createTestLogger(),
    } satisfies RunAgentParams);
    const skillExecution = executeAiTool(skillTools, "Skill", { skill: row.integration });
    if (row.connected) await expect(skillExecution).resolves.toContain(`${row.integration} skill body`);
    else
      await expect(skillExecution).rejects.toThrow(
        row.integration === "clickup" ? "ClickUp access could not be verified" : "integration is not connected",
      );

    const registeredTools = createSketchMcpToolDefinitions({
      uploadCollector: new UploadCollector(),
      workspaceDir,
      availableManagedIntegrations: available,
    }).map((definition) => definition.name);
    expect(registeredTools.includes(toolName)).toBe(row.connected);
    for (const name of otherToolNames) expect(registeredTools).not.toContain(name);

    const cliIntegrations = createCliIntegrationService({
      db,
      encryptionKey: ENCRYPTION_KEY,
      environmentVariables: createAgentEnvironmentVariableRepository(db, ENCRYPTION_KEY),
      getAvailableManagedIntegrations: async () => available,
    });
    await expect(cliIntegrations.validateAgentSkills("user-1", [row.integration])).resolves.toEqual(
      row.connected ? [] : [row.integration],
    );
  });

  it("accepts a Linear automation while rejecting GitHub when only Linear is connected", async () => {
    const cliIntegrations = createCliIntegrationService({
      db,
      encryptionKey: ENCRYPTION_KEY,
      environmentVariables: createAgentEnvironmentVariableRepository(db, ENCRYPTION_KEY),
      getAvailableManagedIntegrations: async () => new Set<ManagedIntegrationAppId>(["linear"]),
    });

    await expect(cliIntegrations.validateAgentSkills("user-1", ["linear", "github"])).resolves.toEqual(["github"]);
  });

  it.each([
    { integration: "github" as const, status: 403, toolName: "github_cli" },
    { integration: "linear" as const, status: 404, toolName: "linear_api" },
  ])("maps a revoked $integration connection during mint to a reconnect message", async (row) => {
    const mint = vi.fn().mockRejectedValue(Object.assign(new Error("raw Canvas mint failure"), { status: row.status }));
    const fakeProvider = {
      type: "canvas",
      providerId: "canvas-provider",
      getGithubAccessToken: mint,
    } as unknown as IntegrationProvider;
    const definitions = createSketchMcpToolDefinitions({
      uploadCollector: new UploadCollector(),
      workspaceDir,
      currentUserId: "user-1",
      currentUserEmail: "user@example.com",
      availableManagedIntegrations: new Set<ManagedIntegrationAppId>([row.integration]),
      ...(row.integration === "github"
        ? { loadIntegrationProvider: async () => fakeProvider }
        : { getCanvasAccessToken: mint }),
    }) as ExecutableSdkTool[];
    const selectedTool = definitions.find((definition) => definition.name === row.toolName);
    if (!selectedTool) throw new Error(`Missing managed tool: ${row.toolName}`);

    const result = await selectedTool.handler(
      row.integration === "github" ? { argv: ["version"] } : { query: "query { viewer { id } }" },
      {},
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `${row.integration === "github" ? "GitHub" : "Linear"} isn't connected (or was disconnected). Reconnect it in Sketch Integrations.`,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("raw Canvas mint failure");
    expect(mint).toHaveBeenCalledOnce();
  });

  it.each([
    { integration: "github" as const, toolName: "github_cli", args: { argv: ["version"] } },
    { integration: "linear" as const, toolName: "linear_api", args: { query: "query { viewer { id } }" } },
  ])("mints $integration as the automation owner rather than the viewer", async (row) => {
    const mint = vi.fn().mockRejectedValue(Object.assign(new Error("mint rejected for test"), { status: 403 }));
    const fakeProvider = {
      type: "canvas",
      providerId: "canvas-provider",
      getGithubAccessToken: mint,
      getCanvasAccessToken: mint,
    } as unknown as IntegrationProvider;
    const definitions = createSketchMcpToolDefinitions({
      uploadCollector: new UploadCollector(),
      workspaceDir,
      currentUserId: "viewer-1",
      currentUserEmail: "viewer@example.com",
      integrationUserId: "owner-1",
      integrationUserEmail: "owner@example.com",
      availableManagedIntegrations: new Set<ManagedIntegrationAppId>([row.integration]),
      loadIntegrationProvider: async () => fakeProvider,
    }) as ExecutableSdkTool[];
    const selectedTool = definitions.find((definition) => definition.name === row.toolName);
    if (!selectedTool) throw new Error(`Missing managed tool: ${row.toolName}`);
    await selectedTool.handler(row.args, {});
    expect(mint).toHaveBeenCalledOnce();
    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({
        userEmail: "owner@example.com",
        workspaceContext: { workspaceId: "canvas-provider", userId: "owner-1" },
      }),
    );
  });

  it.each(
    (["github", "linear"] as const).flatMap((integration) =>
      [
        { integrationUserId: "owner-1" },
        { integrationUserEmail: "owner@example.com" },
        { integrationUserId: "owner-1", integrationUserEmail: null },
        { integrationUserId: null, integrationUserEmail: null },
      ].map((actor) => ({ integration, actor })),
    ),
  )("never fills an incomplete $integration owner from viewer credentials: $actor", async ({ integration, actor }) => {
    const mint = vi.fn().mockRejectedValue(new Error("must not mint viewer credentials"));
    const loadIntegrationProvider = vi.fn().mockResolvedValue({
      type: "canvas",
      providerId: "canvas-provider",
      getGithubAccessToken: mint,
      getCanvasAccessToken: mint,
    });
    const definitions = createSketchMcpToolDefinitions({
      uploadCollector: new UploadCollector(),
      workspaceDir,
      currentUserId: "viewer-1",
      currentUserEmail: "viewer@example.com",
      ...actor,
      availableManagedIntegrations: new Set<ManagedIntegrationAppId>([integration]),
      loadIntegrationProvider,
    }) as ExecutableSdkTool[];
    const selectedTool = definitions.find(
      (definition) => definition.name === (integration === "github" ? "github_cli" : "linear_api"),
    );
    if (!selectedTool) throw new Error(`Missing managed tool for ${integration}`);
    await selectedTool.handler(
      integration === "github" ? { argv: ["version"] } : { query: "query { viewer { id } }" },
      {},
    );
    expect(loadIntegrationProvider).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });
});
