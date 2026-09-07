import type { WebhookDeliveryReceipt } from "@sketch/shared";
import { type Kysely, sql } from "kysely";
import {
  type WebhookEndpointRepositoryOptions,
  type WebhookEndpointRow,
  createWebhookEndpointsRepository,
} from "../db/repositories/webhook-endpoints";
import type { DB } from "../db/schema";
import { WebhookBindingError, type WebhookSourceBinding, webhookBindingMetadata } from "./webhook-bindings";

import { authorizeAuthoringLease } from "./lock-service";
import { isAutomationWebhookTrigger, parseAutomationTriggerConfig } from "./webhook";

export const WEBHOOK_ENDPOINT_PATH = "/api/webhooks/v1";
export const WEBHOOK_BODY_LIMIT_BYTES = 1_000_000;
export const WEBHOOK_IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const WEBHOOK_EVENT_ID_HEADER = WEBHOOK_IDEMPOTENCY_KEY_HEADER;
export const WEBHOOK_EVENT_ID_MAX_LENGTH = 200;

export const NATIVE_WEBHOOK_PATH = WEBHOOK_ENDPOINT_PATH;
export const NATIVE_WEBHOOK_METHOD = "POST" as const;
export const NATIVE_WEBHOOK_CONTENT_TYPE = "application/json" as const;

/** Only receipts from the current binding generation count as delivery verification. */
export async function lastWebhookDeliveryMetadata(
  db: Kysely<DB>,
  taskId: string,
  endpointId?: string,
): Promise<WebhookDeliveryReceipt | undefined> {
  return db
    .selectFrom("webhook_deliveries as delivery")
    .innerJoin("webhook_endpoints as endpoint", "endpoint.id", "delivery.endpoint_id")
    .select([
      "endpoint.id as endpointId",
      "endpoint.generation as endpointGeneration",
      "delivery.id as deliveryId",
      "delivery.event_id as eventId",
      "delivery.created_at as receivedAt",
      "delivery.status as status",
    ])
    .where("endpoint.task_id", "=", taskId)
    .$if(endpointId !== undefined, (query) => query.where("endpoint.id", "=", endpointId as string))
    .whereRef("delivery.endpoint_generation", "=", "endpoint.generation")
    .orderBy("delivery.created_at", "desc")
    .orderBy("delivery.id", "desc")
    .limit(1)
    .executeTakeFirst();
}

export interface WebhookEndpointConfiguration {
  readonly endpointId: string;
  readonly taskId: string;
  readonly url: string;
  readonly method: typeof NATIVE_WEBHOOK_METHOD;
  readonly contentType: typeof NATIVE_WEBHOOK_CONTENT_TYPE;
  readonly authentication: "none" | "hmac_sha256";
  readonly binding?: WebhookSourceBinding;
  readonly bodyLimitBytes: typeof WEBHOOK_BODY_LIMIT_BYTES;
  readonly idempotencyHeader: typeof WEBHOOK_IDEMPOTENCY_KEY_HEADER;
  readonly status: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebhookEndpointServiceOptions {
  readonly db: Kysely<DB>;
  readonly baseUrl?: string | null;
  readonly port?: number;
  readonly repositoryOptions?: WebhookEndpointRepositoryOptions;
}

export function buildNativeWebhookUrl(
  endpointId: string,
  options: { readonly baseUrl?: string | null; readonly port?: number } = {},
): string {
  const baseUrl = options.baseUrl?.trim().replace(/\/+$/u, "") || `http://localhost:${options.port ?? 3000}`;
  return `${baseUrl}${NATIVE_WEBHOOK_PATH}/${encodeURIComponent(endpointId)}`;
}

function configurationFor(
  row: WebhookEndpointRow,
  options: Pick<WebhookEndpointServiceOptions, "baseUrl" | "port">,
): WebhookEndpointConfiguration {
  return {
    endpointId: row.id,
    taskId: row.task_id,
    url: buildNativeWebhookUrl(row.id, options),
    method: NATIVE_WEBHOOK_METHOD,
    contentType: NATIVE_WEBHOOK_CONTENT_TYPE,
    authentication: row.verification_json != null ? "hmac_sha256" : "none",
    binding: webhookBindingMetadata(row),
    bodyLimitBytes: WEBHOOK_BODY_LIMIT_BYTES,
    idempotencyHeader: WEBHOOK_IDEMPOTENCY_KEY_HEADER,
    status: row.status,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createWebhookEndpointService(
  optionsOrDb: WebhookEndpointServiceOptions | Kysely<DB>,
  _legacyEncryptionKey?: string,
  urlOptions?: {
    readonly baseUrl?: string | null;
    readonly port?: number;
    readonly repositoryOptions?: WebhookEndpointRepositoryOptions;
  },
) {
  const resolved: WebhookEndpointServiceOptions =
    "db" in optionsOrDb
      ? optionsOrDb
      : {
          db: optionsOrDb,
          baseUrl: urlOptions?.baseUrl,
          port: urlOptions?.port,
          repositoryOptions: urlOptions?.repositoryOptions,
        };
  const repository = createWebhookEndpointsRepository(resolved.db, resolved.repositoryOptions);
  const endpointUrlOptions = { baseUrl: resolved.baseUrl, port: resolved.port };

  const ensureForTask = async (taskId: string): Promise<WebhookEndpointConfiguration> => {
    const result = await repository.ensureForTask(taskId);
    return configurationFor(result.endpoint, endpointUrlOptions);
  };
  const getById = async (endpointId: string): Promise<WebhookEndpointConfiguration | null> => {
    const row = await repository.getById(endpointId);
    return row ? configurationFor(row, endpointUrlOptions) : null;
  };
  const getByTaskId = async (taskId: string): Promise<WebhookEndpointConfiguration | null> => {
    const row = await repository.getByTaskId(taskId);
    return row ? configurationFor(row, endpointUrlOptions) : null;
  };
  const deactivateForTask = async (taskId: string): Promise<WebhookEndpointConfiguration | null> => {
    const row = await repository.deactivateForTask(taskId);
    return row ? configurationFor(row, endpointUrlOptions) : null;
  };

  return {
    ensureForTask,
    provisionForTask: ensureForTask,
    getById,
    getByTaskId,
    get: getById,
    deactivateForTask,
    deactivate: deactivateForTask,
    async deleteByTaskId(taskId: string): Promise<void> {
      await repository.deleteByTaskId(taskId);
    },
  };
}

/** Stable provider-neutral slots let an agent bind disjoint subscriptions without broadening their scopes. */
export async function manageWebhookEndpointSlot(params: {
  db: Kysely<DB>;
  taskId: string;
  userId: string;
  slot: string;
  retire?: boolean;
  lease: { sessionId: string; generation: number };
}): Promise<WebhookEndpointRow> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(params.slot))
    throw new WebhookBindingError(
      "Use a stable endpoint slot of 1-100 letters, digits, dots, colons, underscores, or hyphens.",
    );
  return params.db.transaction().execute(async (trx) => {
    const authorization = await authorizeAuthoringLease(trx, {
      taskId: params.taskId,
      userId: params.userId,
      ...params.lease,
    });
    if (authorization.kind !== "held")
      throw new WebhookBindingError("The automation editing lease changed or expired.");
    const task = await trx
      .updateTable("scheduled_tasks")
      .set({ revision: sql<number>`revision` })
      .where("id", "=", params.taskId)
      .where("created_by", "=", params.userId)
      .where("status", "=", "paused")
      .returningAll()
      .executeTakeFirst();
    const trigger =
      task &&
      parseAutomationTriggerConfig(task.steps, {
        scheduleType: task.schedule_type,
        scheduleValue: task.schedule_value,
      });
    if (!task || !trigger || !isAutomationWebhookTrigger(trigger))
      throw new WebhookBindingError("Only the owner of a paused native webhook automation can manage endpoint slots.");
    const repository = createWebhookEndpointsRepository(trx);
    const endpoints = await repository.listByTaskId(task.id);
    const existing = endpoints.find((endpoint) => endpoint.slot === params.slot);
    if (params.retire) {
      if (!existing || existing.slot === "default")
        throw new WebhookBindingError("Only an existing additional endpoint slot can be retired.");
      if (existing.source_binding !== null)
        throw new WebhookBindingError(
          "Delete the exact remote subscription through its provider API before retiring this slot.",
        );
      return trx
        .updateTable("webhook_endpoints")
        .set({ status: "revoked", generation: sql<number>`generation + 1`, updated_at: new Date().toISOString() })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    if (!existing && endpoints.length >= 32)
      throw new WebhookBindingError("An automation supports at most 32 endpoint slots.");
    return (await repository.ensureForTask(task.id, params.slot)).endpoint;
  });
}
