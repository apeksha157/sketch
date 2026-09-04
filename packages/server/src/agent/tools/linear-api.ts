import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { type CanvasAccessToken, type CanvasAccessTokenRequest, getIntegrationActor } from "../../integrations/types";
import {
  isManagedIntegrationDisconnectedError,
  managedIntegrationReconnectMessage,
} from "./managed-integration-errors";
import type { SketchMcpDeps, ToolResult } from "./types";

export const LINEAR_API_URL = "https://api.linear.app/graphql";
export const LINEAR_API_TIMEOUT_MS = 30_000;
export const LINEAR_MAX_QUERY_CHARS = 16 * 1024;
export const LINEAR_MAX_VARIABLES_BYTES = 32 * 1024;
export const LINEAR_MAX_RESPONSE_BYTES = 256 * 1024;

type LinearApiArgs = {
  query: string;
  variables?: Record<string, unknown>;
  accountId?: string;
};

type LinearGraphQlResponse = {
  data?: unknown;
  errors?: Array<{ message?: unknown }>;
};

type CanvasAccessTokenProvider = (params: CanvasAccessTokenRequest) => Promise<CanvasAccessToken>;

const schema = {
  query: z.string().trim().min(1).max(LINEAR_MAX_QUERY_CHARS).describe("A bounded Linear GraphQL query or mutation."),
  variables: z
    .record(z.string().max(256), z.unknown())
    .optional()
    .describe("Optional GraphQL variables. Keep the object bounded and send only fields needed for this request."),
  accountId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Opaque Canvas Linear account ID. Omit to prefer your personal account, then a single shared account. Set this when the user explicitly selects a shared account.",
    ),
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeErrorMessage(error: unknown, secret?: string): string {
  if (error instanceof Error && error.message.trim()) {
    const message = secret ? error.message.split(secret).join("[redacted]") : error.message;
    return message.slice(0, 1000);
  }
  return "unknown error";
}

function validateArguments(args: LinearApiArgs): string {
  if (args.query.length > LINEAR_MAX_QUERY_CHARS) {
    throw new Error(`Linear GraphQL query exceeds the ${LINEAR_MAX_QUERY_CHARS}-character limit.`);
  }
  const variables = args.variables ?? {};
  const serializedVariables = JSON.stringify(variables);
  if (serializedVariables === undefined || byteLength(serializedVariables) > LINEAR_MAX_VARIABLES_BYTES) {
    throw new Error(`Linear GraphQL variables exceed the ${LINEAR_MAX_VARIABLES_BYTES}-byte limit.`);
  }
  return JSON.stringify({ query: args.query, variables });
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LINEAR_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`Linear API response exceeds the ${LINEAR_MAX_RESPONSE_BYTES}-byte limit.`);
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

function parseGraphQlResponse(body: string, accessToken: string): LinearGraphQlResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Linear API returned an invalid JSON response.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Linear API returned an invalid response.");
  }
  const result = parsed as LinearGraphQlResponse;
  if (result.errors && result.errors.length > 0) {
    const messages = result.errors
      .map((error) =>
        typeof error?.message === "string"
          ? error.message.split(accessToken).join("[redacted]")
          : "Unknown GraphQL error",
      )
      .slice(0, 10);
    throw new Error(`Linear GraphQL error: ${messages.join("; ")}`);
  }
  return result;
}

async function getTokenProvider(deps: SketchMcpDeps): Promise<CanvasAccessTokenProvider | null> {
  if (deps.getCanvasAccessToken) return deps.getCanvasAccessToken;
  const { userId, userEmail } = getIntegrationActor({ ...deps, userEmail: deps.currentUserEmail });
  if (!deps.loadIntegrationProvider || !userId || !userEmail) return null;
  const provider = await deps.loadIntegrationProvider();
  if (!provider) return null;
  const candidate = provider.getCanvasAccessToken;
  if (!candidate) return null;
  return (params) =>
    candidate.call(provider, {
      ...params,
      userEmail,
      ...(provider.providerId && userId ? { workspaceContext: { workspaceId: provider.providerId, userId } } : {}),
    });
}

export async function executeLinearApi(args: LinearApiArgs, deps: SketchMcpDeps): Promise<unknown> {
  const body = validateArguments(args);
  const getCanvasAccessToken = await getTokenProvider(deps);
  if (!getCanvasAccessToken) throw new Error("Linear OAuth is not configured for this Sketch run.");

  let token = await getCanvasAccessToken({
    integration: "linear",
    ...(args.accountId ? { accountId: args.accountId } : {}),
    forceRefresh: false,
  });
  let didForceRefresh = false;

  for (;;) {
    if (!token.accessToken || typeof token.accessToken !== "string") {
      throw new Error("Canvas returned an invalid Linear access token.");
    }
    let response: Response;
    try {
      response = await fetch(LINEAR_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "Content-Type": "application/json",
          "public-file-urls-expire-in": "60",
        },
        body,
        signal: AbortSignal.timeout(LINEAR_API_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Linear API request failed: ${safeErrorMessage(error, token.accessToken)}`);
    }

    if (response.status === 401 && !didForceRefresh) {
      await response.body?.cancel();
      token = await getCanvasAccessToken({
        integration: "linear",
        ...(args.accountId ? { accountId: args.accountId } : {}),
        forceRefresh: true,
      });
      didForceRefresh = true;
      continue;
    }

    const responseBody = await readBoundedResponse(response);
    if (!response.ok) {
      if (response.status === 403) throw new Error("Linear API access is forbidden for this account.");
      if (response.status === 429) throw new Error("Linear API rate limit reached. Try again later.");
      throw new Error(`Linear API request failed with HTTP ${response.status}.`);
    }
    return parseGraphQlResponse(responseBody, token.accessToken).data;
  }
}

export async function handleLinearApi(args: LinearApiArgs, deps: SketchMcpDeps): Promise<ToolResult> {
  try {
    const result = await executeLinearApi(args, deps);
    const serialized = JSON.stringify(result) ?? "null";
    if (byteLength(serialized) > LINEAR_MAX_RESPONSE_BYTES) {
      return {
        content: [{ type: "text", text: `Linear API response exceeds the ${LINEAR_MAX_RESPONSE_BYTES}-byte limit.` }],
      };
    }
    return { content: [{ type: "text", text: serialized }] };
  } catch (error) {
    if (isManagedIntegrationDisconnectedError(error)) {
      return { content: [{ type: "text", text: managedIntegrationReconnectMessage("linear") }] };
    }
    return { content: [{ type: "text", text: `Linear API failed: ${safeErrorMessage(error)}` }] };
  }
}

export function createLinearApiTool(deps: SketchMcpDeps) {
  return tool(
    "linear_api",
    "Execute a bounded Linear GraphQL query or mutation through Sketch. Canvas owns OAuth and refresh tokens; this tool never exposes credentials or request headers.",
    schema,
    async (args): Promise<ToolResult> => handleLinearApi(args, deps),
  );
}
