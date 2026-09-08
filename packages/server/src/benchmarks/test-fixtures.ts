import type { IntegrationConnection, IntegrationProvider } from "../integrations/types";
import type { ProviderIntegration } from "./cases";

export function testBenchmarkProvider(
  listConnections: IntegrationProvider["listConnections"] = async () => [],
): IntegrationProvider {
  return {
    type: "canvas",
    providerId: "test-provider",
    listConnections,
    listApps: async () => ({ apps: [], pageInfo: { hasMore: false, endCursor: null } }),
    initiateConnection: async () => ({ redirectUrl: "https://test.invalid/connect" }),
    removeConnection: async () => {},
    isBrokerCapable: () => false,
    getBrokerSpec: () => null,
    getCanvasAccessToken: async () => ({ accessToken: "test-token" }),
    getGithubAccessToken: async () => ({ accessToken: "test-github-token" }),
  };
}
export function testBenchmarkConnection(
  integration: ProviderIntegration,
  id = `${integration}-account`,
): IntegrationConnection {
  return {
    id,
    providerId: "test-provider",
    appId: integration,
    appName: integration,
    accountName: `${integration} shared account`,
    status: "active",
    canUse: true,
    isOwnedByViewer: false,
    createdAt: "2026-09-08T00:00:00Z",
    accessRevision: 1,
  };
}
