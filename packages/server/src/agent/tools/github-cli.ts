import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

import { runGithubCli } from "../../integrations/cli/github-runner";
import { getIntegrationActor } from "../../integrations/types";
import {
  isManagedIntegrationDisconnectedError,
  managedIntegrationReconnectMessage,
} from "./managed-integration-errors";
import type { SketchMcpDeps, ToolResult } from "./types";

const schema = {
  argv: z
    .array(z.string().min(1).max(512))
    .min(1)
    .max(24)
    .describe("GitHub CLI arguments without the leading gh executable."),
  accountId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Opaque Canvas account ID. Omit to prefer your personal account, then a single shared account. Set this when the user explicitly selects a shared account.",
    ),
  stdin: z
    .string()
    .max(64 * 1024)
    .optional()
    .describe("Optional bounded stdin for a broker-supported command."),
};

export function createGithubCliTool(deps: SketchMcpDeps) {
  return tool(
    "github_cli",
    "Run a GitHub CLI operation in the current Sketch workspace. Sketch obtains a short-lived token from Canvas and injects it only into the gh child process. Do not request or print credentials.",
    schema,
    async (args): Promise<ToolResult> => {
      const { userId, userEmail } = getIntegrationActor({ ...deps, userEmail: deps.currentUserEmail });
      if (!deps.loadIntegrationProvider || !userId || !userEmail) {
        return { content: [{ type: "text", text: "GitHub OAuth is not configured for this Sketch run." }] };
      }
      const provider = await deps.loadIntegrationProvider();
      if (!provider?.getGithubAccessToken) {
        return { content: [{ type: "text", text: "The local GitHub CLI credential provider is not available." }] };
      }
      try {
        const workspaceContext =
          provider.providerId && userId ? { workspaceId: provider.providerId, userId } : undefined;
        const result = await runGithubCli({
          argv: args.argv,
          stdin: args.stdin,
          workspaceDir: deps.workspaceDir,
          getAccessToken: (tokenOptions) =>
            provider.getGithubAccessToken?.({
              userEmail,
              accountId: args.accountId,
              forceRefresh: tokenOptions?.forceRefresh,
              workspaceContext,
            }) ?? Promise.reject(new Error("The local GitHub CLI credential provider is not available")),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        if (isManagedIntegrationDisconnectedError(error)) {
          return { content: [{ type: "text", text: managedIntegrationReconnectMessage("github") }] };
        }
        return {
          content: [
            { type: "text", text: `GitHub CLI failed: ${error instanceof Error ? error.message : "unknown error"}` },
          ],
        };
      }
    },
  );
}
