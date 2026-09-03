/**
 * Canvas integration provider adapter.
 * Canvas internally uses Pipedream for app connections. All API calls
 * are scoped to the org via the API key, and to the user via X-User-Email header.
 * Canvas resolves the email to its own user ID for Pipedream scoping.
 *
 * Constructor accepts apiUrl and apiKey directly (extracted from the mcp_servers row)
 * rather than a credentials object, since the unified table stores them separately.
 */
import { join } from "node:path";
import {
  type IntegrationApp,
  type IntegrationConnection,
  type PageInfo,
  isCanvasNativeIntegrationAppId,
} from "@sketch/shared";
import { z } from "zod";
import type { CredentialEnvelope } from "../connectors/credential-envelope";
import { decryptCredentialEnvelope } from "../connectors/credential-envelope";
import { canvasBlockedIntegrationMessage, isCanvasBlockedAppId, isCanvasBlockedComponentKey } from "./cli/policy";
import type {
  BrokerSpec,
  IntegrationActionRequest,
  IntegrationProvider,
  IntegrationUserOrgRole,
  IntegrationWorkspaceContext,
} from "./types";

const REQUEST_TIMEOUT_MS = 30_000;
const ACTION_REQUEST_TIMEOUT_MS = 120_000;

type CanvasAccountResponse = {
  id: string;
  source?: "canvas_user_secrets" | "pipedream" | string;
  name?: string;
  accountName?: string;
  authType?: "oauth" | "api_key" | string;
  app?: { name_slug?: string; nameSlug?: string; name?: string; imgSrc?: string };
  healthy: boolean;
  dead?: boolean;
  status?: "active" | "error" | "expired";
  accessLevel?: "personal" | "organization";
  visibility?: "private" | "selected_members" | "organization";
  memberGrants?: Array<{
    accountId: string;
    orgId: string;
    workspaceId?: string;
    granteeUserId: string;
    grantedByUserId: string;
    createdAt: string;
    updatedAt: string;
  }>;
  sharingReason?: "owner" | "selected_member" | "organization";
  ownerUserId?: string;
  ownerName?: string;
  isOwnedByViewer?: boolean;
  canUse?: boolean;
  canManageAccess?: boolean;
  canDelete?: boolean;
  created_at?: string;
  connectedAt?: string;
};

export type CanvasSketchConnectorType =
  | "google_drive"
  | "google_calendar"
  | "gmail"
  | "outlook"
  | "outlook_calendar"
  | "teams"
  | "fireflies"
  | "clickup"
  | "notion"
  | "linear"
  | "github";

export interface CanvasConnectorCredentialResponse {
  connectorType: CanvasSketchConnectorType;
  provider: string;
  credentialKind: "oauth_access_token" | "api_key";
  expiresAt?: string;
  envelope: CredentialEnvelope;
}

export interface CanvasProviderOptions {
  credentialPrivateKeyPem?: string;
  credentialPublicKeyId?: string;
}

export interface GithubAccessToken {
  accessToken: string;
  expiresAt?: string;
}

const credentialEnvelopeSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("RSA-OAEP-256+A256GCM"),
  keyId: z.string().min(1),
  encryptedKey: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ciphertext: z.string().min(1),
});

const canvasSketchConnectorTypeSchema = z.enum([
  "google_drive",
  "google_calendar",
  "gmail",
  "outlook",
  "outlook_calendar",
  "teams",
  "fireflies",
  "clickup",
  "notion",
  "linear",
  "github",
] satisfies [CanvasSketchConnectorType, ...CanvasSketchConnectorType[]]);

const canvasConnectorCredentialResponseSchema = z.object({
  connectorType: canvasSketchConnectorTypeSchema,
  provider: z.string().min(1),
  credentialKind: z.enum(["oauth_access_token", "api_key"]),
  expiresAt: z.string().min(1).optional(),
  envelope: credentialEnvelopeSchema,
});

const canvasCredentialMintResponseSchema = z.object({
  success: z.literal(true),
  data: canvasConnectorCredentialResponseSchema,
});

function hasCanvasAccessMetadata(account: CanvasAccountResponse): boolean {
  return (
    account.accessLevel !== undefined ||
    account.visibility !== undefined ||
    account.ownerUserId !== undefined ||
    account.ownerName !== undefined ||
    account.isOwnedByViewer !== undefined ||
    account.canUse !== undefined ||
    account.canManageAccess !== undefined ||
    account.canDelete !== undefined
  );
}

function getConnectionSource(account: CanvasAccountResponse): string {
  return account.source ?? (hasCanvasAccessMetadata(account) ? "canvas_user_secrets" : "pipedream");
}

function canUseConnection(account: CanvasAccountResponse): boolean {
  if (account.canUse === false) return false;
  if (
    getConnectionSource(account) === "canvas_user_secrets" &&
    account.accessLevel === "personal" &&
    account.isOwnedByViewer === false
  ) {
    return false;
  }
  return true;
}

export class CanvasProviderRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CanvasProviderRequestError";
  }
}

export class CanvasProvider implements IntegrationProvider {
  readonly type = "canvas";
  readonly providerId: string;
  private readonly accessTokenCache = new Map<string, GithubAccessToken>();
  private readonly accessTokenRequests = new Map<string, Promise<GithubAccessToken>>();

  constructor(
    private apiUrl: string,
    private apiKey: string,
    providerId: string,
    private readonly options: CanvasProviderOptions = {},
  ) {
    this.providerId = providerId;
  }

  isBrokerCapable(): boolean {
    return true;
  }

  async executeAction(request: IntegrationActionRequest, signal?: AbortSignal): Promise<unknown> {
    if (isCanvasBlockedComponentKey(request.componentKey)) {
      throw new CanvasProviderRequestError(409, "CLI_INTEGRATION", canvasBlockedIntegrationMessage());
    }
    const url = new URL("/api/direct-executions/action", this.apiUrl);
    const requestSignal = AbortSignal.timeout(ACTION_REQUEST_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, requestSignal]) : requestSignal;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(request.userEmail, true, undefined, undefined, request.workspaceContext),
      body: JSON.stringify({
        componentKey: request.componentKey,
        configuredProps: request.configuredProps,
      }),
      signal: combinedSignal,
    });
    if (!res.ok) throw await this.parseError(res, `Canvas action execution failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { success?: boolean; data?: unknown; message?: string; error?: string };
    if (body.success !== true) {
      throw new CanvasProviderRequestError(
        502,
        body.error ?? "UPSTREAM_ERROR",
        body.message ?? "Canvas action execution returned an invalid response",
      );
    }
    return body.data;
  }

  async getGithubAccessToken(params: {
    userEmail: string;
    accountId?: string;
    workspaceContext?: IntegrationWorkspaceContext;
    forceRefresh?: boolean;
  }): Promise<GithubAccessToken> {
    return this.getCanvasAccessToken({ ...params, integration: "github" });
  }

  async getCanvasAccessToken(params: {
    integration: "github" | "linear";
    userEmail: string;
    accountId?: string;
    workspaceContext?: IntegrationWorkspaceContext;
    forceRefresh?: boolean;
  }): Promise<GithubAccessToken> {
    if (!this.options.credentialPrivateKeyPem) {
      throw new CanvasProviderRequestError(
        503,
        "CREDENTIAL_IMPORT_NOT_CONFIGURED",
        "Canvas credential import is not configured",
      );
    }

    const cacheKey = `${params.integration}\0${params.userEmail}\0${params.accountId ?? ""}`;
    const cached = this.accessTokenCache.get(cacheKey);
    const expiresAtMs = cached?.expiresAt ? Date.parse(cached.expiresAt) : 0;
    const cacheIsFresh = cached?.expiresAt
      ? Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() + 5 * 60_000
      : params.integration === "github";
    if (cached && !params.forceRefresh && cacheIsFresh) {
      return cached;
    }

    if (!params.forceRefresh) {
      const inFlight = this.accessTokenRequests.get(cacheKey);
      if (inFlight) return inFlight;
    }

    const request = this.mintCanvasAccessToken(params).finally(() => {
      if (this.accessTokenRequests.get(cacheKey) === request) this.accessTokenRequests.delete(cacheKey);
    });
    this.accessTokenRequests.set(cacheKey, request);
    return request;
  }

  private async mintCanvasAccessToken(params: {
    integration: "github" | "linear";
    userEmail: string;
    accountId?: string;
    workspaceContext?: IntegrationWorkspaceContext;
    forceRefresh?: boolean;
  }): Promise<GithubAccessToken> {
    const privateKeyPem = this.options.credentialPrivateKeyPem;
    if (!privateKeyPem) throw new Error("Canvas credential import is not configured");
    const response = await this.mintConnectorCredential({
      userEmail: params.userEmail,
      connectorType: params.integration,
      publicKeyId: this.options.credentialPublicKeyId,
      accountId: params.accountId,
      workspaceContext: params.workspaceContext,
      forceRefresh: params.forceRefresh,
    });
    const payload = z
      .object({
        type: z.literal("oauth_access_token"),
        connectorType: z.enum(["github", "linear"]),
        provider: z.string().min(1),
        accessToken: z.string().min(1),
        tokenType: z.string().min(1).optional(),
        expiresAt: z.string().min(1).optional(),
      })
      .parse(decryptCredentialEnvelope<unknown>(response.envelope, privateKeyPem));
    if (
      response.connectorType !== params.integration ||
      payload.connectorType !== params.integration ||
      response.credentialKind !== "oauth_access_token"
    ) {
      throw new Error(`Canvas ${params.integration} credential response did not contain the requested OAuth token`);
    }
    if (this.options.credentialPublicKeyId && response.envelope.keyId !== this.options.credentialPublicKeyId) {
      throw new Error("Canvas GitHub credential envelope key id does not match the configured key");
    }
    const expiresAt = response.expiresAt ?? payload.expiresAt;
    const token = { accessToken: payload.accessToken, ...(expiresAt ? { expiresAt } : {}) };
    const cacheKey = `${params.integration}\0${params.userEmail}\0${params.accountId ?? ""}`;
    this.accessTokenCache.set(cacheKey, token);
    return token;
  }

  getBrokerSpec({
    userEmail,
    claudeConfigDir,
    workspaceContext,
  }: {
    userEmail: string | null;
    claudeConfigDir: string;
    workspaceContext?: IntegrationWorkspaceContext;
  }): BrokerSpec {
    const credentialEnv: Record<string, string> = {
      CANVAS_MCP_URL: this.apiUrl.endsWith("/mcp") ? this.apiUrl : `${this.apiUrl.replace(/\/+$/, "")}/mcp`,
    };
    if (this.apiKey) credentialEnv.CANVAS_API_KEY_MCP = this.apiKey;
    if (userEmail) credentialEnv.CANVAS_USER_EMAIL = userEmail;
    if (workspaceContext) {
      credentialEnv.CANVAS_SKETCH_WORKSPACE_ID = workspaceContext.workspaceId;
      credentialEnv.CANVAS_SKETCH_WORKSPACE_USER_ID = workspaceContext.userId;
    }
    return {
      cliPath: join(claudeConfigDir, "skills", "canvas", "canvas-cli.js"),
      credentialEnv: {
        ...credentialEnv,
        CANVAS_BLOCKED_APP_IDS: "github,github-oauth,linear,linear-oauth",
      },
      launcherEnvName: "CANVAS_CLI",
      argvPolicy: (argv) => {
        const blocked = argv.some((value) => {
          const normalized = value.trim().toLowerCase();
          if (isCanvasBlockedAppId(normalized) || isCanvasBlockedComponentKey(normalized)) return true;
          return normalized.includes("github") || normalized.includes("linear");
        });
        return blocked ? { allowed: false, message: canvasBlockedIntegrationMessage() } : { allowed: true };
      },
    };
  }

  private headers(
    userEmail?: string,
    includeContentType = true,
    userName?: string,
    userOrgRole?: IntegrationUserOrgRole,
    workspaceContext?: IntegrationWorkspaceContext,
  ): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (includeContentType) h["Content-Type"] = "application/json";
    if (userEmail) h["X-User-Email"] = userEmail;
    const trimmedName = userName?.trim();
    if (trimmedName) h["X-User-Name"] = trimmedName.replace(/[\r\n]/g, " ");
    if (userOrgRole) h["X-User-Org-Role"] = userOrgRole;
    if (workspaceContext) {
      h["X-Sketch-Workspace-Id"] = workspaceContext.workspaceId;
      h["X-Sketch-Workspace-User-Id"] = workspaceContext.userId;
    }
    return h;
  }

  private async parseError(res: Response, fallback: string): Promise<CanvasProviderRequestError> {
    const body = (await res.json().catch(() => null)) as {
      error?: string | { code?: string; message?: string };
      message?: string;
    } | null;
    const message =
      (typeof body?.error === "object" ? body.error.message : undefined) ??
      body?.message ??
      (typeof body?.error === "string" ? body.error : undefined) ??
      fallback;
    const code =
      (typeof body?.error === "object" ? body.error.code : undefined) ??
      (res.status === 401
        ? "UNAUTHORIZED"
        : res.status === 403
          ? "FORBIDDEN"
          : res.status === 404
            ? "NOT_FOUND"
            : res.status === 400
              ? "BAD_REQUEST"
              : "UPSTREAM_ERROR");
    return new CanvasProviderRequestError(res.status, code, message);
  }

  async listApps(
    query?: string,
    limit?: number,
    after?: string,
  ): Promise<{ apps: IntegrationApp[]; pageInfo: PageInfo }> {
    const url = new URL("/api/apps", this.apiUrl);
    if (query) url.searchParams.set("q", query);
    if (limit !== undefined || after !== undefined) {
      url.searchParams.set("paginate", "true");
      if (limit !== undefined) url.searchParams.set("limit", String(limit));
      if (after) url.searchParams.set("after", after);
    }

    const res = await fetch(url.toString(), {
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Canvas listApps failed: ${res.status} ${res.statusText}`);
    }

    /**
     * Canvas API wraps responses in: { success, data: { pageInfo, data: [...] }, message }.
     * The apps array is at data.data and pagination info at data.pageInfo.
     */
    const raw = (await res.json()) as {
      success: boolean;
      data: {
        data: Array<{
          id?: string;
          nameSlug: string;
          name: string;
          description?: string;
          imgSrc?: string;
          categories?: string[];
        }>;
        pageInfo?: { endCursor: string | null; hasMore: boolean };
      };
      message?: string;
    };

    const catalogApps = raw.data?.data ?? [];
    const orderedCatalogApps = [
      ...catalogApps.filter((app) => isCanvasNativeIntegrationAppId(app.nameSlug)),
      ...catalogApps.filter((app) => !isCanvasNativeIntegrationAppId(app.nameSlug)),
    ];
    const apps: IntegrationApp[] = orderedCatalogApps.map((app) => ({
      id: app.nameSlug,
      name: app.name,
      description: app.description ?? "",
      icon: app.imgSrc,
      category: app.categories?.[0],
      executionMode: "canvas" as const,
    }));

    const pageInfo: PageInfo = raw.data?.pageInfo ?? { endCursor: null, hasMore: false };

    return { apps, pageInfo };
  }

  async initiateConnection(
    userEmail: string,
    appId: string,
    callbackUrl: string,
    userName?: string,
    userOrgRole?: IntegrationUserOrgRole,
    workspaceContext?: IntegrationWorkspaceContext,
  ): Promise<{ redirectUrl: string }> {
    const res = await fetch(`${this.apiUrl}/api/apps/connect-token`, {
      method: "POST",
      headers: this.headers(userEmail, true, userName, userOrgRole, workspaceContext),
      body: JSON.stringify({ app_slug: appId, callback_url: callbackUrl }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw await this.parseError(res, `Canvas initiateConnection failed: ${res.status} ${res.statusText}`);
    }

    const raw = (await res.json()) as {
      success: boolean;
      data: { connect_link_url?: string; token?: string; expires_at?: string };
    };
    const connectLinkUrl = raw.data?.connect_link_url;
    if (!connectLinkUrl) {
      throw new Error("Canvas did not return a connect link URL");
    }
    return { redirectUrl: connectLinkUrl };
  }

  async listConnections(
    userEmail: string,
    userName?: string,
    workspaceContext?: IntegrationWorkspaceContext,
  ): Promise<IntegrationConnection[]> {
    const res = await fetch(`${this.apiUrl}/api/pipedream/accounts`, {
      headers: this.headers(userEmail, true, userName, undefined, workspaceContext),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw await this.parseError(res, `Canvas listConnections failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { accounts: CanvasAccountResponse[] };

    return (data.accounts ?? []).filter(canUseConnection).map((account): IntegrationConnection => {
      const appId = account.app?.nameSlug ?? account.app?.name_slug ?? account.id;
      const appName = account.app?.name ?? account.name ?? "Unknown";
      const connectedAt = account.connectedAt ?? account.created_at ?? new Date().toISOString();
      return {
        id: account.id,
        providerId: this.providerId,
        source: getConnectionSource(account),
        executionMode: "canvas",
        appId,
        appName,
        app: account.app
          ? {
              name: appName,
              nameSlug: appId,
              imgSrc: account.app.imgSrc,
            }
          : undefined,
        icon: account.app?.imgSrc,
        accountName: account.accountName ?? account.name,
        authType: account.authType,
        healthy: account.healthy,
        status: account.status ?? (account.dead ? "error" : account.healthy ? "active" : "error"),
        accessLevel: account.accessLevel,
        visibility: account.visibility,
        memberGrants: account.memberGrants,
        sharingReason: account.sharingReason,
        ownerUserId: account.ownerUserId,
        ownerName: account.ownerName,
        isOwnedByViewer: account.isOwnedByViewer,
        canUse: account.canUse,
        canManageAccess: account.canManageAccess,
        canDelete: account.canDelete,
        createdAt: connectedAt,
        connectedAt,
      };
    });
  }

  async removeConnection(
    userEmail: string,
    connectionId: string,
    userName?: string,
    workspaceContext?: IntegrationWorkspaceContext,
  ): Promise<void> {
    const res = await fetch(`${this.apiUrl}/api/pipedream/accounts/${connectionId}`, {
      method: "DELETE",
      headers: this.headers(userEmail, false, userName, undefined, workspaceContext),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw await this.parseError(res, `Canvas removeConnection failed: ${res.status} ${res.statusText}`);
    }
  }

  async updateConnectionAccess(
    userEmail: string,
    connectionId: string,
    accessLevel: "personal" | "organization",
    userName?: string,
    options?: {
      visibility?: "private" | "selected_members" | "organization";
      granteeUserIds?: string[];
    },
    workspaceContext?: IntegrationWorkspaceContext,
  ): Promise<IntegrationConnection | null> {
    const res = await fetch(`${this.apiUrl}/api/canvas-accounts/${encodeURIComponent(connectionId)}/access`, {
      method: "PUT",
      headers: this.headers(userEmail, true, userName, undefined, workspaceContext),
      body: JSON.stringify({
        accessLevel,
        ...(options?.visibility ? { visibility: options.visibility } : {}),
        ...(options?.granteeUserIds ? { granteeUserIds: options.granteeUserIds } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw await this.parseError(res, `Canvas updateConnectionAccess failed: ${res.status} ${res.statusText}`);
    }

    return null;
  }

  async mintConnectorCredential(params: {
    userEmail: string;
    connectorType: CanvasSketchConnectorType;
    publicKeyId?: string;
    accountId?: string;
    userName?: string;
    userOrgRole?: IntegrationUserOrgRole;
    workspaceContext?: IntegrationWorkspaceContext;
    forceRefresh?: boolean;
  }): Promise<CanvasConnectorCredentialResponse> {
    const res = await fetch(`${this.apiUrl}/api/sketch/credentials/mint`, {
      method: "POST",
      headers: this.headers(params.userEmail, true, params.userName, params.userOrgRole, params.workspaceContext),
      body: JSON.stringify({
        connectorType: params.connectorType,
        ...(params.publicKeyId ? { publicKeyId: params.publicKeyId } : {}),
        ...(params.accountId ? { accountId: params.accountId } : {}),
        ...(params.forceRefresh ? { forceRefresh: true } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw await this.parseError(res, `Canvas credential mint failed: ${res.status} ${res.statusText}`);
    }

    const parsed = canvasCredentialMintResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      throw new Error("Canvas credential mint returned an invalid response");
    }
    return parsed.data.data;
  }
}
