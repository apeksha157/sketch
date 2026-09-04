/**
 * Provider factory and MCP config builder.
 * createProvider: instantiates an adapter from a mcp_servers row.
 * buildMcpConfig: constructs the SDK McpHttpServerConfig for agent runs.
 *
 * Both functions accept the fields from the mcp_servers table directly
 * (type, apiUrl, credentials JSON, providerId) rather than a raw row,
 * so callers can pass values from the unified table.
 */
import { CanvasProvider, type CanvasProviderOptions } from "./canvas";
import { canvasCredentialsSchema } from "./types";
import type { IntegrationProvider } from "./types";

export function createProvider(
  type: string,
  apiUrl: string,
  credentials: string,
  providerId: string,
  options: CanvasProviderOptions = {},
): IntegrationProvider {
  const parsed = JSON.parse(credentials);
  switch (type) {
    case "canvas": {
      const creds = canvasCredentialsSchema.parse(parsed);
      return new CanvasProvider(apiUrl, creds.apiKey, providerId, options);
    }
    default:
      throw new Error(`Provider type "${type}" is not yet implemented`);
  }
}

export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/**
 * Build an MCP server config for use with the agent SDK.
 * For integration providers (type != null): includes X-User-Email header for user scoping.
 * For plain MCP servers (type == null): uses bearerToken if present in credentials.
 */
export function buildMcpConfig(
  url: string,
  credentials: string,
  userEmail: string | null,
  type: string | null,
): McpHttpServerConfig {
  const parsed = JSON.parse(credentials) as Record<string, string>;
  const token = parsed.apiKey ?? parsed.bearerToken;
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (type && userEmail) {
    headers["X-User-Email"] = userEmail;
  }

  return { type: "http", url, headers };
}
