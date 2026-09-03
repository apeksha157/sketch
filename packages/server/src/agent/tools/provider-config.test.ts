import type { IntegrationConnection } from "@sketch/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasProvider } from "../../integrations/canvas";
import { createProviderConfigTool } from "./provider-config";

function account(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: "opaque-owner-account",
    providerId: "canvas-1",
    source: "canvas_user_secrets",
    executionMode: "canvas",
    appId: "clickup",
    appName: "ClickUp",
    authType: "oauth",
    status: "active",
    accountName: "Product Workspace",
    ownerName: "Owner",
    isOwnedByViewer: false,
    canUse: true,
    healthy: true,
    createdAt: "2026-09-03T00:00:00Z",
    connectedAt: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

describe("provider configuration account discovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the existing unconfigured response", async () => {
    const result = await createProviderConfigTool({}).handler({}, {});
    expect(result.content[0]).toMatchObject({ text: JSON.stringify({ configured: false }) });
  });

  it("discovers exact eligible IDs for the credential actor without selecting one or exposing secrets", async () => {
    const provider = new CanvasProvider("https://canvas.example.test", "test-key", "canvas-1");
    const withSecrets = { ...account(), accessToken: "must-not-expose", signingSecret: "also-private" };
    const listConnections = vi
      .spyOn(provider, "listConnections")
      .mockResolvedValue([
        withSecrets,
        account({ id: "opaque-second-account", accountName: "Engineering" }),
        account({ id: "pat", authType: "api_key" }),
        account({ id: "pipedream", source: "pipedream" }),
        account({ id: "denied", canUse: false }),
        account({ id: "expired", status: "expired" }),
      ]);
    const result = await createProviderConfigTool({
      loadIntegrationProvider: async () => provider,
      currentUserId: "viewer",
      currentUserEmail: "viewer@example.test",
      integrationUserId: "actor",
      integrationUserEmail: "actor@example.test",
    }).handler({}, {});
    expect(listConnections).toHaveBeenCalledWith("actor@example.test", undefined, {
      workspaceId: "canvas-1",
      userId: "actor",
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0].type === "text" ? result.content[0].text : "{}";
    expect(JSON.parse(text)).toEqual({
      configured: true,
      type: "canvas",
      managedAccountsStatus: "discovered",
      managedAccounts: [
        {
          integration: "clickup",
          accountId: "opaque-owner-account",
          accountName: "Product Workspace",
          ownerName: "Owner",
          isOwnedByViewer: false,
        },
        {
          integration: "clickup",
          accountId: "opaque-second-account",
          accountName: "Engineering",
          ownerName: "Owner",
          isOwnedByViewer: false,
        },
      ],
    });
    expect(text).not.toContain("must-not-expose");
    expect(text).not.toContain("also-private");
  });

  it("reports failed discovery without declaring disconnection or requesting reconnect", async () => {
    const provider = new CanvasProvider("https://canvas.example.test", "test-key", "canvas-1");
    vi.spyOn(provider, "listConnections").mockRejectedValue(new Error("private upstream detail"));
    const result = await createProviderConfigTool({
      loadIntegrationProvider: async () => provider,
      currentUserId: "actor",
      currentUserEmail: "actor@example.test",
    }).handler({}, {});
    expect(result.content[0]).toMatchObject({
      text: JSON.stringify({ configured: true, type: "canvas", managedAccountsStatus: "unavailable" }),
    });
    expect(JSON.stringify(result)).not.toMatch(/reconnect|private upstream detail/i);
  });

  it.each([null, undefined])("does not discover the viewer's accounts when the owner's email is %s", async (email) => {
    const provider = new CanvasProvider("https://canvas.example.test", "test-key", "canvas-1");
    const listConnections = vi.spyOn(provider, "listConnections").mockResolvedValue([account()]);
    const result = await createProviderConfigTool({
      loadIntegrationProvider: async () => provider,
      currentUserId: "viewer",
      currentUserEmail: "viewer@example.test",
      integrationUserId: "owner",
      integrationUserEmail: email,
    }).handler({}, {});
    expect(listConnections).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("opaque-owner-account");
  });
});
