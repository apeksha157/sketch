import { createHash } from "node:crypto";
import { type IntegrationConnection, type ManagedIntegrationAppId, managedIntegrationAppId } from "@sketch/shared";
import { z } from "zod";
import type { Logger } from "../logger";
import { CanvasProviderRequestError } from "./canvas";
import { assertClickUpRequestAllowed, recordClickUpRateLimit } from "./clickup-request-budget";
import type { CanvasAccessToken, IntegrationProvider } from "./types";

const CLICKUP_VALIDATION_TIMEOUT_MS = 2_000;
const CLICKUP_VALIDATION_MAX_RESPONSE_BYTES = 32 * 1024;
const CLICKUP_API_URL = "https://api.clickup.com/api/v2";
const CLICKUP_VALIDATION_CONCURRENCY = 4;

type ClickUpValidationFailure = "transient" | "revoked_or_missing" | "uncertain_workspace";

type ClickUpValidationResult = { ok: true } | { ok: false; reason: ClickUpValidationFailure };
const clickUpId = z.union([z.string().min(1), z.number().int().positive()]);
const validationCache = new WeakMap<
  IntegrationProvider,
  Map<string, { result: Promise<ClickUpValidationResult>; expiresAt: number }>
>();

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CLICKUP_VALIDATION_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("ClickUp validation response exceeded its size limit");
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

function parseJson(body: string): Record<string, unknown> | null {
  if (!body.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function classifyError(error: unknown): ClickUpValidationFailure {
  if (error instanceof CanvasProviderRequestError) {
    return error.status === 401 || error.status === 403 || error.status === 404 ? "revoked_or_missing" : "transient";
  }
  return "transient";
}

function classifyHttpStatus(status: number): ClickUpValidationFailure {
  if (status === 401) return "revoked_or_missing";
  if (status === 403 || status === 404) return "uncertain_workspace";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  return "uncertain_workspace";
}

async function validateClickUpResponse(
  response: Response,
  endpoint: "user" | "team",
): Promise<ClickUpValidationResult> {
  const body = parseJson(await readBoundedBody(response));
  if (!response.ok) {
    if (endpoint === "team" && response.status === 404 && body?.ECODE === "SHARD_009") {
      return { ok: false, reason: "uncertain_workspace" };
    }
    return { ok: false, reason: classifyHttpStatus(response.status) };
  }
  const valid =
    endpoint === "user"
      ? z.object({ user: z.object({ id: clickUpId }) }).safeParse(body).success
      : z.object({ teams: z.array(z.object({ id: clickUpId })).min(1) }).safeParse(body).success;
  if (!valid) {
    return { ok: false, reason: "uncertain_workspace" };
  }
  return { ok: true };
}

async function clickUpValidationRequest(
  token: CanvasAccessToken,
  endpoint: "user" | "team",
): Promise<ClickUpValidationResult> {
  try {
    assertClickUpRequestAllowed(token.accessToken);
    const response = await fetch(`${CLICKUP_API_URL}/${endpoint}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token.accessToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(CLICKUP_VALIDATION_TIMEOUT_MS),
    });
    if (response.status === 429) {
      await response.body?.cancel();
      throw recordClickUpRateLimit(token.accessToken, response.headers);
    }
    return await validateClickUpResponse(response, endpoint);
  } catch (error) {
    return { ok: false, reason: classifyError(error) };
  }
}

async function validateClickUpConnection(params: {
  provider: IntegrationProvider;
  connection: IntegrationConnection;
  userEmail: string;
  userId: string;
}): Promise<ClickUpValidationResult> {
  if (!params.provider.getCanvasAccessToken) return { ok: false, reason: "revoked_or_missing" };

  let token: CanvasAccessToken;
  try {
    token = await params.provider.getCanvasAccessToken({
      integration: "clickup",
      accountId: params.connection.id,
      workspaceContext: { workspaceId: params.provider.providerId ?? "", userId: params.userId },
      userEmail: params.userEmail,
    });
  } catch (error) {
    return { ok: false, reason: classifyError(error) };
  }

  let cache = validationCache.get(params.provider);
  if (!cache) {
    cache = new Map();
    validationCache.set(params.provider, cache);
  }
  const key = createHash("sha256")
    .update(JSON.stringify([params.userId, params.userEmail, params.connection.id, token.accessToken]))
    .digest("hex");
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  if (cache.size >= 256) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  const result = Promise.all([clickUpValidationRequest(token, "user"), clickUpValidationRequest(token, "team")]).then(
    (results) => results.find((result) => !result.ok) ?? { ok: true as const },
  );
  cache.set(key, { result, expiresAt: Date.now() + 60_000 });
  return result;
}

async function validateClickUpConnections(params: {
  provider: IntegrationProvider;
  connections: IntegrationConnection[];
  userEmail: string;
  userId: string;
  logger?: Pick<Logger, "warn">;
  available: Set<ManagedIntegrationAppId>;
}): Promise<void> {
  const eligible = params.connections.filter((connection) => {
    const appId = managedIntegrationAppId(connection.appId) ?? managedIntegrationAppId(connection.appName);
    return (
      appId === "clickup" &&
      connection.source === "canvas_user_secrets" &&
      connection.status === "active" &&
      connection.canUse !== false &&
      connection.healthy !== false &&
      connection.authType === "oauth"
    );
  });
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex++;
      const connection = eligible[index];
      if (!connection) return;
      const result = await validateClickUpConnection({
        provider: params.provider,
        connection,
        userEmail: params.userEmail,
        userId: params.userId,
      });
      if (result.ok) {
        params.available.add("clickup");
      } else {
        params.logger?.warn(
          { event: "managed_integration_clickup_validation_failed", reason: result.reason },
          "ClickUp managed integration validation failed closed",
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CLICKUP_VALIDATION_CONCURRENCY, eligible.length) }, () => worker()));
}

export async function listAvailableManagedIntegrations(params: {
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  userEmail: string;
  currentUserId: string;
  logger?: Pick<Logger, "warn">;
}): Promise<Set<ManagedIntegrationAppId>> {
  const available = new Set<ManagedIntegrationAppId>();
  try {
    await resolveAvailableManagedIntegrations({ ...params, available });
  } catch {
    params.logger?.warn(
      {
        event: "managed_integration_availability_failed",
        reason: "provider_error",
      },
      "Managed integration availability lookup failed closed",
    );
  }
  return new Set(available);
}

async function resolveAvailableManagedIntegrations(params: {
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  userEmail: string;
  currentUserId: string;
  logger?: Pick<Logger, "warn">;
  available: Set<ManagedIntegrationAppId>;
}): Promise<void> {
  const provider = await params.loadIntegrationProvider();
  if (provider?.type !== "canvas" || !provider.providerId) return;

  const connections = await provider.listConnections(params.userEmail, undefined, {
    workspaceId: provider.providerId,
    userId: params.currentUserId,
  });
  const available = params.available;
  for (const connection of connections) {
    const appId = managedIntegrationAppId(connection.appId) ?? managedIntegrationAppId(connection.appName);
    if (
      appId &&
      appId !== "clickup" &&
      connection.status === "active" &&
      connection.canUse !== false &&
      connection.healthy !== false
    ) {
      available.add(appId);
    }
  }
  await validateClickUpConnections({
    provider,
    connections,
    userEmail: params.userEmail,
    userId: params.currentUserId,
    logger: params.logger,
    available,
  });
}
