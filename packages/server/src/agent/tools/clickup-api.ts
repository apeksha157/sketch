import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { clickupWebhookEventSchema } from "@sketch/shared";
import { z } from "zod/v4";
import { encrypt } from "../../auth/encryption";
import { releaseLock } from "../../automation/lock-service";
import {
  WebhookBindingError,
  type WebhookSourceBinding,
  readWebhookSourceBinding,
  updateWebhookBinding,
} from "../../automation/webhook-bindings";
import { buildNativeWebhookUrl } from "../../automation/webhook-endpoints";
import type { WebhookVerification } from "../../automation/webhook-verification";
import { createScheduledTaskRepository } from "../../db/repositories/scheduled-tasks";
import { createWebhookEndpointRepository } from "../../db/repositories/webhook-endpoints";
import {
  ClickUpApiRateLimitError,
  assertClickUpRequestAllowed,
  recordClickUpRateLimit,
} from "../../integrations/clickup-request-budget";
import { type CanvasAccessToken, type CanvasAccessTokenRequest, getIntegrationActor } from "../../integrations/types";
import {
  isManagedIntegrationDisconnectedError,
  managedIntegrationReconnectMessage,
} from "./managed-integration-errors";
import { acquireAgentLease } from "./scheduled-tasks";
import type { SketchMcpDeps, ToolResult } from "./types";

export const CLICKUP_API_URL = "https://api.clickup.com/api/v2";
export const CLICKUP_API_TIMEOUT_MS = 30_000;
export const CLICKUP_MAX_PATH_CHARS = 512;
export const CLICKUP_MAX_QUERY_BYTES = 8 * 1024;
export const CLICKUP_MAX_BODY_BYTES = 64 * 1024;
export const CLICKUP_MAX_RESPONSE_BYTES = 256 * 1024;
export const CLICKUP_MAX_ATTACHMENT_FILES = 5;
export const CLICKUP_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const CLICKUP_MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
export const CLICKUP_MAX_ATTACHMENT_FILENAME_CHARS = 255;
export { ClickUpApiRateLimitError } from "../../integrations/clickup-request-budget";

export type ClickUpLocalFile = {
  path: string;
  filename?: string;
  contentType?: string;
};

export type ClickUpApiArgs = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  accountId?: string;
  webhookEndpointId?: string;
  files?: ClickUpLocalFile[];
};

type CanvasAccessTokenProvider = (params: CanvasAccessTokenRequest) => Promise<CanvasAccessToken>;

export class ClickUpApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`ClickUp API request failed with HTTP ${status}${code ? ` (${code})` : ""}.`);
    this.name = "ClickUpApiHttpError";
  }
}

export class ClickUpUploadUncertainError extends Error {
  constructor(message = "ClickUp attachment upload outcome is uncertain; reconcile the task before retrying.") {
    super(message);
    this.name = "ClickUpUploadUncertainError";
  }
}

function providerErrorCode(body: string): string | undefined {
  try {
    const code: unknown = JSON.parse(body)?.ECODE;
    return typeof code === "string" && /^(OAUTH|SHARD)_\d{1,6}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

const schema = {
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method for the ClickUp API request."),
  path: z
    .string()
    .trim()
    .min(1)
    .max(CLICKUP_MAX_PATH_CHARS)
    .regex(/^\/[A-Za-z0-9][A-Za-z0-9._~:@/-]*$/, "Use a relative ClickUp API v2 path such as /team.")
    .describe("Relative ClickUp API v2 path. Do not include a host, query string, or token."),
  query: z
    .record(z.string().trim().min(1).max(128), z.string().max(512))
    .optional()
    .describe("Optional bounded query parameters."),
  body: z.unknown().optional().describe("Optional JSON request body. Send only fields needed for this request."),
  accountId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe("Opaque Canvas ClickUp account ID. Omit only when Canvas can resolve one usable account."),
  webhookEndpointId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Native Sketch endpoint ID returned by ManageScheduledTasks. Required for webhook writes and optional for explicit GET reconciliation. Captures signing secrets server-side; requires the owner, a paused automation, and exact accountId.",
    ),
  files: z
    .array(
      z
        .object({
          path: z.string().trim().min(1).max(4096),
          filename: z.string().trim().min(1).max(CLICKUP_MAX_ATTACHMENT_FILENAME_CHARS).optional(),
          contentType: z.string().trim().min(1).max(128).optional(),
        })
        .strict(),
    )
    .max(CLICKUP_MAX_ATTACHMENT_FILES)
    .optional()
    .describe(
      "Trusted local files for POST /task/{task_id}/attachment. Use server-provided local paths only; never send URLs, base64, or file bytes.",
    ),
};

const clickUpApiArgsSchema = z.object(schema);

export function parseClickUpApiArgs(value: unknown): ClickUpApiArgs {
  return clickUpApiArgsSchema.parse(value);
}

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

function isWebhookManagementPath(path: string): boolean {
  return path.split("/").some((segment) => {
    const normalized = segment.toLowerCase();
    return normalized === "webhook" || normalized === "webhooks";
  });
}

function validatePath(path: string): void {
  if (path.length > CLICKUP_MAX_PATH_CHARS || !/^\/[A-Za-z0-9][A-Za-z0-9._~:@/-]*$/.test(path)) {
    throw new Error("Use a relative ClickUp API v2 path such as /team.");
  }
  if (path.includes("?") || path.includes("#") || path.includes("//")) {
    throw new Error("ClickUp API paths must not contain a query string, fragment, or empty path segment.");
  }
  if (path.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new Error("ClickUp API paths must not contain dot segments.");
  }
  if (path.toLowerCase().includes("/oauth")) {
    throw new Error("ClickUp OAuth endpoints are not available through the ClickUp API tool.");
  }
}

function buildUrl(args: ClickUpApiArgs): string {
  validatePath(args.path);
  const url = new URL(`${CLICKUP_API_URL}${args.path}`);
  for (const [key, value] of Object.entries(args.query ?? {})) url.searchParams.set(key, value);
  if (byteLength(url.search) > CLICKUP_MAX_QUERY_BYTES) {
    throw new Error(`ClickUp API query exceeds the ${CLICKUP_MAX_QUERY_BYTES}-byte limit.`);
  }
  return url.toString();
}

function buildRequest(args: ClickUpApiArgs): { url: string; body?: string } {
  const url = buildUrl(args);
  if (args.files && args.files.length > 0) {
    throw new Error("ClickUp local files are only supported by POST /task/{task_id}/attachment.");
  }

  if (args.body === undefined) return { url: url.toString() };
  let body: string;
  try {
    const serialized = JSON.stringify(args.body);
    if (serialized === undefined) throw new Error("undefined JSON");
    body = serialized;
  } catch {
    throw new Error("ClickUp API request body must be JSON serializable.");
  }
  if (byteLength(body) > CLICKUP_MAX_BODY_BYTES) {
    throw new Error(`ClickUp API request body exceeds the ${CLICKUP_MAX_BODY_BYTES}-byte limit.`);
  }
  return { url: url.toString(), body };
}

function isTaskAttachmentRequest(args: ClickUpApiArgs): boolean {
  return args.method === "POST" && /^\/task\/[A-Za-z0-9][A-Za-z0-9._~-]*\/attachment$/u.test(args.path);
}

function trustedRootContains(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function safeAttachmentFilename(value: string | undefined, sourcePath: string): string {
  const candidate = [...(value?.trim() || basename(sourcePath))]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return character === "\\" || character === "/" || codePoint <= 0x1f || codePoint === 0x7f ? "_" : character;
    })
    .join("");
  if (!candidate || candidate === "." || candidate === "..") throw new Error("ClickUp attachment filename is invalid");
  if (candidate.length > CLICKUP_MAX_ATTACHMENT_FILENAME_CHARS) {
    throw new Error(`ClickUp attachment filename exceeds ${CLICKUP_MAX_ATTACHMENT_FILENAME_CHARS} characters`);
  }
  return candidate;
}

function safeAttachmentContentType(value: string | undefined): string {
  const contentType = value?.trim() || "application/octet-stream";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*\/[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*(?:;[^\r\n]{0,64})?$/u.test(
      contentType,
    )
  ) {
    throw new Error("ClickUp attachment content type is invalid");
  }
  return contentType;
}

type MaterializedClickUpFile = { bytes: Buffer; filename: string; contentType: string };

async function materializeClickUpFiles(
  args: ClickUpApiArgs,
  deps: SketchMcpDeps,
  signal?: AbortSignal,
): Promise<MaterializedClickUpFile[]> {
  const files = args.files ?? [];
  if (files.length === 0) return [];
  if (files.length > CLICKUP_MAX_ATTACHMENT_FILES) {
    throw new Error(`ClickUp attachments support at most ${CLICKUP_MAX_ATTACHMENT_FILES} local files`);
  }
  if (!isTaskAttachmentRequest(args)) {
    throw new Error("ClickUp local files are only supported by POST /task/{task_id}/attachment.");
  }
  if (!deps.workspaceDir) throw new Error("ClickUp attachment file roots are not configured");
  const roots = [await realpath(deps.workspaceDir)];
  if (deps.trustedLocalFileRoot) roots.push(await realpath(deps.trustedLocalFileRoot));
  let totalBytes = 0;
  const materialized: MaterializedClickUpFile[] = [];
  for (const file of files) {
    if (signal?.aborted) throw new Error("ClickUp attachment upload was cancelled before reading local files");
    if (!isAbsolute(file.path) || file.path.includes("\0") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(file.path)) {
      throw new Error("ClickUp attachment path must be an absolute trusted local path");
    }
    const link = await lstat(file.path).catch(() => null);
    if (!link || !link.isFile() || link.isSymbolicLink()) {
      throw new Error("ClickUp attachment must be a regular, non-symlink local file");
    }
    const resolved = await realpath(file.path).catch(() => null);
    if (!resolved || !roots.some((root) => trustedRootContains(root, resolved))) {
      throw new Error("ClickUp attachment file is outside the trusted automation file roots");
    }
    if (link.size > CLICKUP_MAX_ATTACHMENT_BYTES) {
      throw new Error(`ClickUp attachment exceeds the ${CLICKUP_MAX_ATTACHMENT_BYTES}-byte per-file limit`);
    }
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) throw new Error("ClickUp attachment could not be opened safely");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== link.dev || opened.ino !== link.ino) {
        throw new Error("ClickUp attachment changed while it was being opened");
      }
      if (opened.size > CLICKUP_MAX_ATTACHMENT_BYTES) {
        throw new Error(`ClickUp attachment exceeds the ${CLICKUP_MAX_ATTACHMENT_BYTES}-byte per-file limit`);
      }
      const bytes = await handle.readFile({ signal });
      if (bytes.byteLength > CLICKUP_MAX_ATTACHMENT_BYTES) {
        throw new Error(`ClickUp attachment exceeds the ${CLICKUP_MAX_ATTACHMENT_BYTES}-byte per-file limit`);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > CLICKUP_MAX_ATTACHMENT_TOTAL_BYTES) {
        throw new Error(`ClickUp attachments exceed the ${CLICKUP_MAX_ATTACHMENT_TOTAL_BYTES}-byte total limit`);
      }
      materialized.push({
        bytes,
        filename: safeAttachmentFilename(file.filename, file.path),
        contentType: safeAttachmentContentType(file.contentType),
      });
    } finally {
      await handle.close();
    }
  }
  return materialized;
}

function buildMultipartRequest(
  args: ClickUpApiArgs,
  files: MaterializedClickUpFile[],
): { url: string; formData: FormData } {
  if (args.body !== undefined) throw new Error("ClickUp attachment requests must not include a JSON body");
  const formData = new FormData();
  for (const file of files) {
    formData.append("attachment[]", new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.filename);
  }
  return { url: buildUrl(args), formData };
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
    if (size > CLICKUP_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`ClickUp API response exceeds the ${CLICKUP_MAX_RESPONSE_BYTES}-byte limit.`);
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

function redactSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join("[redacted]") : value;
}

function parseResponse(body: string, secret: string): unknown {
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body);
    const serialized = JSON.stringify(parsed);
    return JSON.parse(redactSecret(serialized, secret));
  } catch {
    return redactSecret(body, secret);
  }
}

async function getTokenProvider(deps: SketchMcpDeps): Promise<CanvasAccessTokenProvider | null> {
  if (deps.getCanvasAccessToken) return deps.getCanvasAccessToken;
  const { userId, userEmail } = getIntegrationActor({ ...deps, userEmail: deps.currentUserEmail });
  if (!deps.loadIntegrationProvider || !userId || !userEmail) return null;
  const provider = await deps.loadIntegrationProvider();
  if (!provider?.getCanvasAccessToken) return null;
  const getAccessToken = provider.getCanvasAccessToken;
  return (params) =>
    getAccessToken.call(provider, {
      ...params,
      userEmail,
      ...(provider.providerId && userId ? { workspaceContext: { workspaceId: provider.providerId, userId } } : {}),
    });
}

async function requestClickUpApi(
  args: ClickUpApiArgs,
  deps: SketchMcpDeps,
  request: { url: string; body?: string; formData?: FormData },
  onSend: () => void,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const getCanvasAccessToken = await getTokenProvider(deps);
  if (!getCanvasAccessToken) throw new Error("ClickUp authorization is not configured for this Sketch run.");

  let token = await getCanvasAccessToken({
    integration: "clickup",
    ...(args.accountId ? { accountId: args.accountId } : {}),
    forceRefresh: false,
  });
  let didForceRefresh = false;

  for (;;) {
    if (!token.accessToken || typeof token.accessToken !== "string") {
      throw new Error("Canvas returned an invalid ClickUp access token.");
    }
    assertClickUpRequestAllowed(token.accessToken);

    let response: Response;
    let sent = false;
    try {
      onSend();
      sent = true;
      const timeoutSignal = AbortSignal.timeout(CLICKUP_API_TIMEOUT_MS);
      response = await fetch(request.url, {
        method: args.method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token.accessToken}`,
          ...(request.body === undefined && request.formData === undefined
            ? {}
            : request.formData === undefined
              ? { "Content-Type": "application/json" }
              : {}),
        },
        ...(request.body === undefined && request.formData === undefined
          ? {}
          : { body: request.formData ?? request.body }),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
    } catch (error) {
      if (sent && args.files && args.files.length > 0) {
        throw new ClickUpUploadUncertainError();
      }
      throw new Error(`ClickUp API request failed: ${safeErrorMessage(error, token.accessToken)}`);
    }

    if (response.status === 401 && !didForceRefresh) {
      await response.body?.cancel();
      token = await getCanvasAccessToken({
        integration: "clickup",
        ...(args.accountId ? { accountId: args.accountId } : {}),
        forceRefresh: true,
      });
      didForceRefresh = true;
      continue;
    }

    if (response.status === 429) {
      await response.body?.cancel();
      throw recordClickUpRateLimit(token.accessToken, response.headers);
    }

    const responseBody = await readBoundedResponse(response);
    if (!response.ok) {
      throw new ClickUpApiHttpError(response.status, providerErrorCode(responseBody));
    }
    const parsed = parseResponse(responseBody, token.accessToken);
    if (isWebhookManagementPath(args.path) && typeof parsed === "string") {
      throw new WebhookBindingError("ClickUp returned an invalid webhook response. Reconcile before retrying.");
    }
    return parsed;
  }
}

const clickupWebhookVerification: WebhookVerification = {
  type: "hmac_sha256",
  signatureHeader: "x-signature",
  resourceIdField: "webhook_id",
  dedupe: { eventField: "event", itemsField: "history_items", itemIdField: "id" },
};

const remoteWebhookIdentitySchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    endpoint: z.string().url(),
    team_id: z.union([z.string(), z.number()]),
    status: z.string().trim().min(1).max(64).optional(),
    health: z
      .object({ status: z.string().trim().min(1).max(64).optional(), fail_count: z.number().nonnegative().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const remoteWebhookSchema = remoteWebhookIdentitySchema.extend({
  secret: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => Buffer.byteLength(value, "utf8") <= 4096),
});

export function clickUpSubscription(data: Record<string, unknown>): NonNullable<WebhookSourceBinding["subscription"]> {
  const parsed = z
    .union([clickupWebhookEventSchema, clickupWebhookEventSchema.array().min(1).max(100)])
    .safeParse(data.events);
  if (!parsed.success) throw new WebhookBindingError("Use a bounded, explicit set of ClickUp webhook events.");
  const events = [...new Set(typeof parsed.data === "string" ? [parsed.data] : parsed.data)].sort();
  const fields = ["task_id", "list_id", "folder_id", "space_id"] as const;
  const presentFields = fields.filter((key) => data[key] != null);
  const field = presentFields[0];
  if (!field) return { events, scope: null };
  for (const candidate of presentFields) {
    const value = data[candidate];
    if ((typeof value !== "string" && typeof value !== "number") || !/^[A-Za-z0-9_-]{1,256}$/u.test(String(value))) {
      throw new WebhookBindingError("The ClickUp webhook location must be an exact task, list, folder, or space ID.");
    }
  }
  const value = data[field];
  return { events, scope: { field, id: String(value) } };
}

function clickUpRemoteHealth(data: Record<string, unknown>): "active" | "failing" | "suspended" | "unknown" {
  const statusValues = [
    data.status,
    data.health && typeof data.health === "object" && !Array.isArray(data.health)
      ? (data.health as Record<string, unknown>).status
      : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  if (statusValues.length === 0) return "unknown";
  if (statusValues.every((value) => value === "active")) return "active";
  if (statusValues.some((value) => value === "suspended")) return "suspended";
  if (statusValues.some((value) => value === "failing")) return "failing";
  return "unknown";
}

function redactWebhookSecrets(data: unknown): unknown {
  const secrets = new Set<string>();
  let serialized = JSON.stringify(data, (key, value: unknown) => {
    if (key.toLowerCase() === "secret" || key.toLowerCase() === "signing_secret") {
      if (typeof value === "string" && value) secrets.add(JSON.stringify(value).slice(1, -1));
      return "[redacted]";
    }
    return value;
  });
  for (const secret of secrets) serialized = serialized.split(secret).join("[redacted]");
  return JSON.parse(serialized);
}

/** Provider paths and response fields stay here; endpoint security and admission are shared. */
async function prepareWebhookCapture(args: ClickUpApiArgs, deps: SketchMcpDeps) {
  const collection = /^\/team\/(\d+)\/webhook$/.exec(args.path);
  const resource = /^\/webhook\/([A-Za-z0-9_-]{1,128})$/.exec(args.path);
  if (
    !((collection && ["GET", "POST"].includes(args.method)) || (resource && ["PUT", "DELETE"].includes(args.method)))
  ) {
    throw new WebhookBindingError(
      "Unsupported ClickUp webhook request. Use GET/POST /team/{id}/webhook or PUT/DELETE /webhook/{id}.",
    );
  }
  if (args.method === "GET" && !args.webhookEndpointId) return null;
  const db = deps.db;
  const ctx = deps.taskContext;
  const userId = deps.currentUserId;
  if (
    !args.webhookEndpointId ||
    !args.accountId ||
    !db ||
    !userId ||
    !ctx ||
    ctx.createdBy !== userId ||
    !deps.availableManagedIntegrations?.has("clickup")
  ) {
    throw new WebhookBindingError(
      "Webhook changes require webhookEndpointId, exact accountId, and the connected automation owner's authoring context.",
    );
  }
  if (ctx.planOnly) throw new WebhookBindingError("Webhook binding changes are unavailable in plan-only mode.");
  const encryptionKey = deps.settingsEncryptionKey;
  if (!encryptionKey || !/^[a-fA-F0-9]{64}$/.test(encryptionKey)) {
    throw new WebhookBindingError("Sketch webhook secret encryption is not configured.");
  }
  let endpoint = await createWebhookEndpointRepository(db).getById(args.webhookEndpointId);
  const task = endpoint && (await createScheduledTaskRepository(db).getById(endpoint.task_id));
  if (!endpoint || !task || task.created_by !== userId || task.status !== "paused") {
    throw new WebhookBindingError("Only the owner of a paused automation can bind its webhook.");
  }
  if (ctx.currentAutomation && ctx.currentAutomation.taskId !== task.id) {
    throw new WebhookBindingError("Use the webhook endpoint of the current automation.");
  }
  const stored = readWebhookSourceBinding(endpoint);
  if (args.method === "POST" && stored) {
    throw new WebhookBindingError(
      "A webhook registration already exists or has an uncertain outcome. Use GET with the same webhookEndpointId to reconcile; do not repeat POST.",
    );
  }
  if (args.method !== "POST" && !stored) {
    throw new WebhookBindingError("This endpoint has no provider binding to reconcile or change.");
  }
  const callbackUrl =
    stored?.callbackUrl ??
    buildNativeWebhookUrl(endpoint.id, {
      baseUrl: deps.toolConfig?.BASE_URL,
      port: deps.toolConfig?.PORT,
    });
  if (!stored) {
    const callback = new URL(callbackUrl);
    if (
      callback.protocol !== "https:" ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash ||
      /^(localhost|127\..*|\[::1\])$/i.test(callback.hostname) ||
      callback.hostname.endsWith(".localhost")
    ) {
      throw new WebhookBindingError(
        "ClickUp requires a publicly reachable HTTPS Sketch BASE_URL before registering a webhook.",
      );
    }
  }
  let binding: WebhookSourceBinding = stored ?? {
    integration: "clickup",
    accountId: args.accountId,
    ...(collection?.[1] ? { workspaceId: collection[1] } : {}),
    collectionPath: args.path,
    callbackUrl,
    resourceId: null,
  };
  if (
    binding.integration !== "clickup" ||
    binding.accountId !== args.accountId ||
    (collection && binding.workspaceId !== undefined && binding.workspaceId !== collection[1]) ||
    (collection && binding.collectionPath !== args.path) ||
    (resource && binding.resourceId !== resource[1])
  ) {
    throw new WebhookBindingError(
      "Use this endpoint's original OAuth account, workspace, and exact remote webhook ID.",
    );
  }
  if (args.method === "POST" || args.method === "PUT") {
    const body = z.record(z.string(), z.unknown()).safeParse(args.body);
    if (!body.success || body.data.endpoint !== callbackUrl) {
      throw new WebhookBindingError(
        "The webhook body endpoint must match the native Sketch webhook URL; callback changes require cleanup first.",
      );
    }
    const subscription = clickUpSubscription(body.data);
    if (args.method === "PUT") {
      if (
        !stored?.subscription ||
        (subscription.scope && JSON.stringify(subscription.scope) !== JSON.stringify(stored.subscription.scope))
      ) {
        throw new WebhookBindingError(
          "Keep the original webhook location; changing it requires cleanup and a new registration.",
        );
      }
      subscription.scope = stored.subscription.scope;
    }
    binding = {
      ...binding,
      ...(collection?.[1] ? { workspaceId: collection[1] } : {}),
      subscription,
    };
  }
  const acquired = await acquireAgentLease(db, task.id, ctx);
  if (acquired.kind !== "held")
    throw new WebhookBindingError("The automation editing lease changed or expired. Refresh before retrying.");
  const lease = acquired.lease;
  const release = async () => {
    if (lease.releaseAfterMutation)
      await releaseLock(db, { taskId: task.id, userId, sessionId: lease.sessionId, generation: lease.generation });
  };
  const verificationJson = JSON.stringify(clickupWebhookVerification);
  const previous = endpoint;
  try {
    endpoint = await updateWebhookBinding({
      db,
      endpoint,
      userId,
      lease,
      binding,
      verificationJson,
      encryptedSecret: previous.signing_secret_encrypted,
      status: "pending",
    });
  } catch (error) {
    await release();
    throw error instanceof WebhookBindingError
      ? error
      : new WebhookBindingError("The webhook binding could not be reserved. No provider request was sent.");
  }
  const reserved = endpoint;
  const save = async (remote: { id: string; secret?: string } | null, ready = false) => {
    try {
      return await updateWebhookBinding({
        db,
        endpoint: reserved,
        userId,
        lease,
        verificationJson,
        binding: remote ? { ...binding, resourceId: remote.id } : null,
        encryptedSecret: remote
          ? remote.secret
            ? encrypt(remote.secret, encryptionKey)
            : previous.signing_secret_encrypted
          : null,
        status: remote ? (ready ? "active_signed" : "pending") : "revoked",
      });
    } catch (error) {
      throw error instanceof WebhookBindingError
        ? error
        : new WebhookBindingError(
            "The provider response could not be saved. Keep the automation paused and reconcile; do not repeat creation.",
          );
    }
  };
  return {
    release,
    discardRejectedRequest: async () => {
      if (args.method === "POST") {
        await save(null);
      } else {
        await updateWebhookBinding({
          db,
          endpoint: reserved,
          userId,
          lease,
          binding: stored,
          verificationJson: previous.verification_json ?? verificationJson,
          encryptedSecret: previous.signing_secret_encrypted,
          status: previous.status === "active_signed" || previous.status === "revoked" ? previous.status : "pending",
        });
      }
    },
    finish: async (data: unknown) => {
      if (args.method === "DELETE") {
        await save(null);
        return { deleted: true, webhookBinding: { endpointId: reserved.id, taskId: task.id, status: "revoked" } };
      }
      const result =
        args.method === "GET"
          ? z.object({ webhooks: z.array(z.unknown()) }).safeParse(data)
          : z.object({ webhook: z.unknown() }).safeParse(data);
      if (!result.success)
        throw new WebhookBindingError(
          "ClickUp did not return a usable webhook response. Keep the automation paused and reconcile.",
        );
      const candidates = "webhooks" in result.data ? result.data.webhooks : [result.data.webhook];
      const matching = candidates.filter(
        (value) =>
          typeof value === "object" && value !== null && "endpoint" in value && value.endpoint === binding.callbackUrl,
      );
      const identity = matching.length === 1 ? remoteWebhookIdentitySchema.safeParse(matching[0]) : null;
      if (
        !identity?.success ||
        String(identity.data.team_id) !== binding.collectionPath.split("/")[2] ||
        (binding.resourceId !== null && binding.resourceId !== identity.data.id)
      ) {
        throw new WebhookBindingError(
          "No unique matching webhook with the requested events, location, and signing secret was found. Keep the binding paused and reconcile the original account; do not repeat POST.",
        );
      }
      const remote = remoteWebhookSchema.safeParse(identity.data);
      if (!remote.success) {
        await save({ id: identity.data.id });
        throw new WebhookBindingError(
          "The matching webhook has no usable signing secret. Its remote ID is saved for cleanup; keep the automation paused and reconcile or delete it.",
        );
      }
      let ready = false;
      try {
        ready =
          !!binding.subscription &&
          JSON.stringify(clickUpSubscription(remote.data)) === JSON.stringify(binding.subscription) &&
          clickUpRemoteHealth(remote.data) === "active";
      } catch (error) {
        if (!(error instanceof WebhookBindingError)) throw error;
      }
      const saved = await save(remote.data, ready);
      if (!ready) {
        const health = clickUpRemoteHealth(remote.data);
        throw new WebhookBindingError(
          health === "unknown"
            ? "The matching ClickUp webhook did not include a usable active health status. Its remote ID is saved, but the automation remains paused until the exact binding is reconciled."
            : health !== "active"
              ? `The matching ClickUp webhook is ${health}; it remains paused until the exact remote binding is healthy.`
              : "The webhook events or location are invalid or differ from the requested subscription. It remains paused; inspect the saved remote ID before correcting or deleting it.",
        );
      }
      return {
        ...(redactWebhookSecrets(data) as object),
        webhookBinding: {
          endpointId: reserved.id,
          taskId: task.id,
          accountId: binding.accountId,
          resourceId: remote.data.id,
          status: saved.status,
          verification: "registration_validated",
          delivery: "awaiting_first_delivery",
        },
      };
    },
  };
}

export async function executeClickUpApi(
  args: ClickUpApiArgs,
  deps: SketchMcpDeps,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (isTaskAttachmentRequest(args) && (!args.files || args.files.length === 0)) {
    throw new Error("ClickUp task attachment requests require trusted local files");
  }
  const materializedFiles = await materializeClickUpFiles(args, deps, signal);
  const request = materializedFiles.length > 0 ? buildMultipartRequest(args, materializedFiles) : buildRequest(args);
  const webhook = isWebhookManagementPath(args.path);
  if (args.webhookEndpointId && !webhook)
    throw new WebhookBindingError("webhookEndpointId is only for native webhook binding requests.");
  const capture = webhook ? await prepareWebhookCapture(args, deps) : null;
  let sent = false;
  try {
    const data = await requestClickUpApi(
      args,
      deps,
      request,
      () => {
        sent = true;
      },
      signal,
    );
    return capture ? await capture.finish(data) : webhook ? redactWebhookSecrets(data) : data;
  } catch (error) {
    if (capture && args.method === "DELETE" && error instanceof ClickUpApiHttpError && error.status === 404) {
      return await capture.finish(null);
    }
    if (
      capture &&
      (!sent ||
        error instanceof ClickUpApiRateLimitError ||
        (error instanceof ClickUpApiHttpError &&
          error.code !== "OAUTH_171" &&
          [400, 401, 403, 404, 422].includes(error.status)))
    ) {
      await capture.discardRejectedRequest();
    }
    throw error;
  } finally {
    await capture?.release();
  }
}

export async function handleClickUpApi(
  args: ClickUpApiArgs,
  deps: SketchMcpDeps,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    const result = await executeClickUpApi(args, deps, signal);
    const serialized = JSON.stringify(result) ?? "null";
    if (byteLength(serialized) > CLICKUP_MAX_RESPONSE_BYTES) {
      return {
        content: [{ type: "text", text: `ClickUp API response exceeds the ${CLICKUP_MAX_RESPONSE_BYTES}-byte limit.` }],
      };
    }
    return { content: [{ type: "text", text: serialized }] };
  } catch (error) {
    if (!(error instanceof ClickUpApiHttpError) && isManagedIntegrationDisconnectedError(error)) {
      return { content: [{ type: "text", text: managedIntegrationReconnectMessage("clickup") }] };
    }
    return { content: [{ type: "text", text: `ClickUp API failed: ${safeErrorMessage(error)}` }] };
  }
}

export function createClickUpApiTool(deps: SketchMcpDeps) {
  return tool(
    "clickup_api",
    "Execute a bounded ClickUp API v2 request through Sketch. Canvas owns ClickUp authorization and credential selection; this tool never exposes credentials or request headers.",
    schema,
    async (args: ClickUpApiArgs): Promise<ToolResult> => handleClickUpApi(args, deps),
  );
}
