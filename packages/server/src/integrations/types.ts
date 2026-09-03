import type { IntegrationApp, IntegrationConnection, PageInfo } from "@sketch/shared";
/**
 * Server-side integration types.
 * Shared types (IntegrationApp, IntegrationConnection, PageInfo) are imported
 * from @sketch/shared. This file keeps only the server-only runtime interface
 * and credential validation schemas.
 */
import { z } from "zod";

export type { IntegrationApp, IntegrationConnection, PageInfo };

export type IntegrationUserOrgRole = "admin" | "member";

export interface IntegrationWorkspaceContext {
  workspaceId: string;
  userId: string;
}

/** Explicit integration identities, including nulls, never inherit fields from the viewer. */
export function getIntegrationActor(params: {
  currentUserId?: string | null;
  userEmail?: string | null;
  integrationUserId?: string | null;
  integrationUserEmail?: string | null;
}) {
  const overridden = params.integrationUserId !== undefined || params.integrationUserEmail !== undefined;
  return {
    userId: (overridden ? params.integrationUserId : params.currentUserId) ?? null,
    userEmail: (overridden ? params.integrationUserEmail : params.userEmail) ?? null,
  };
}

export type CanvasManagedIntegration = "github" | "linear" | "clickup";

export interface CanvasAccessToken {
  accessToken: string;
  expiresAt?: string;
}

export interface CanvasAccessTokenRequest {
  integration: CanvasManagedIntegration;
  accountId?: string;
  workspaceContext?: IntegrationWorkspaceContext;
  forceRefresh?: boolean;
}

export interface BrokerSpec {
  /** Absolute path to the real CLI binary the broker will spawn. */
  cliPath: string;
  /** Env vars injected into the spawned CLI (creds — never visible to the agent). */
  credentialEnv: Record<string, string>;
  /** Name of the env var the agent sees pointing at the launcher (e.g. "CANVAS_CLI"). */
  launcherEnvName: string;
  /** Rejects reserved app/component arguments before the provider CLI is spawned. */
  argvPolicy?: (argv: readonly string[]) => { allowed: true } | { allowed: false; message: string };
}

export interface IntegrationActionRequest {
  userEmail: string;
  componentKey: string;
  configuredProps: Record<string, unknown>;
  workspaceContext?: IntegrationWorkspaceContext;
}

export interface IntegrationProvider {
  /** Stable provider type identifier (e.g. "canvas"). */
  readonly type: string;
  /** Stable configured provider record ID used by the web connection APIs. */
  readonly providerId?: string;
  listApps(query?: string, limit?: number, after?: string): Promise<{ apps: IntegrationApp[]; pageInfo: PageInfo }>;
  initiateConnection(
    userEmail: string,
    appId: string,
    callbackUrl: string,
    userName?: string,
    userOrgRole?: IntegrationUserOrgRole,
    workspaceContext?: IntegrationWorkspaceContext,
  ): Promise<{ redirectUrl: string }>;
  listConnections(
    userEmail: string,
    userName?: string,
    workspaceContext?: IntegrationWorkspaceContext,
  ): Promise<IntegrationConnection[]>;
  removeConnection(
    userEmail: string,
    connectionId: string,
    userName?: string,
    workspaceContext?: IntegrationWorkspaceContext,
  ): Promise<void>;
  updateConnectionAccess?(
    userEmail: string,
    connectionId: string,
    accessLevel: "personal" | "organization",
    userName?: string,
    options?: {
      visibility?: "private" | "selected_members" | "organization";
      granteeUserIds?: string[];
    },
    workspaceContext?: IntegrationWorkspaceContext,
  ): Promise<IntegrationConnection | null>;
  /**
   * Static capability check: does this provider type expose a brokered CLI?
   * Independent of runtime params — used to validate at automation creation time
   * before claudeConfigDir/userEmail are resolved. HTTP-only providers return false.
   */
  isBrokerCapable(): boolean;
  /**
   * Returns a broker spec when this provider exposes a brokered CLI to the agent,
   * or null for HTTP-only providers (no CLI surface).
   */
  getBrokerSpec(params: { userEmail: string | null; claudeConfigDir: string }): BrokerSpec | null;
  executeAction?(request: IntegrationActionRequest, signal?: AbortSignal): Promise<unknown>;
  getCanvasAccessToken?(params: {
    integration: CanvasManagedIntegration;
    userEmail: string;
    accountId?: string;
    workspaceContext?: IntegrationWorkspaceContext;
    forceRefresh?: boolean;
  }): Promise<CanvasAccessToken>;
}

/**
 * Three-state outcome of resolving the active integration provider:
 * - `absent`: no row, or row without a `type`. The org has not configured any integration.
 * - `ok`: row exists and the runtime adapter constructed successfully.
 * - `load_failed`: row exists but the factory threw — credentials malformed,
 *   schema mismatch, etc. The integration is misconfigured, not absent.
 *
 * Hot-path callers that only need the happy provider treat both `absent` and
 * `load_failed` as `null` (see `loadIntegrationProvider` in bootstrap). Callers
 * that should distinguish the misconfigured case (status endpoints, agent
 * prompt blocks) consume the union directly.
 */
export type IntegrationStatus =
  | { kind: "absent" }
  | { kind: "ok"; provider: IntegrationProvider }
  | { kind: "load_failed"; reason: string; type: string };

export const canvasCredentialsSchema = z.object({
  apiKey: z.string().min(1),
});
