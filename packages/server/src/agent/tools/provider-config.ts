import { tool } from "@anthropic-ai/claude-agent-sdk";
import { managedIntegrationAppId } from "@sketch/shared";
import { getIntegrationActor } from "../../integrations/types";
import type { SketchMcpDeps } from "./types";

export function createProviderConfigTool(
  deps: Pick<
    SketchMcpDeps,
    "loadIntegrationProvider" | "currentUserId" | "currentUserEmail" | "integrationUserId" | "integrationUserEmail"
  >,
) {
  return tool(
    "getProviderConfig",
    "Check provider configuration and discover accessible managed account IDs. Discovery is not proof of current Workspace access. Credentials and user scoping are injected server-side; never set keys or emails manually.",
    {},
    async () => {
      if (!deps.loadIntegrationProvider) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ configured: false }) }],
        };
      }

      const provider = await deps.loadIntegrationProvider();
      if (!provider) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ configured: false }) }],
        };
      }

      const { userId, userEmail } = getIntegrationActor({ ...deps, userEmail: deps.currentUserEmail });
      let accounts: Record<string, unknown> = {};
      if (provider.type === "canvas" && provider.providerId && userId && userEmail) {
        try {
          const connections = await provider.listConnections(userEmail, undefined, {
            workspaceId: provider.providerId,
            userId,
          });
          accounts = {
            managedAccounts: connections
              .filter(
                (connection) =>
                  (managedIntegrationAppId(connection.appId) ?? managedIntegrationAppId(connection.appName)) ===
                    "clickup" &&
                  connection.source === "canvas_user_secrets" &&
                  connection.authType === "oauth" &&
                  connection.status === "active" &&
                  connection.canUse !== false &&
                  connection.healthy !== false,
              )
              .map((connection) => ({
                integration: "clickup",
                accountId: connection.id,
                accountName: connection.accountName,
                ownerName: connection.ownerName,
                isOwnedByViewer: connection.isOwnedByViewer,
              })),
            managedAccountsStatus: "discovered",
          };
        } catch {
          accounts = { managedAccountsStatus: "unavailable" };
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              configured: true,
              type: provider.type,
              ...accounts,
            }),
          },
        ],
      };
    },
  );
}
