import type { WebhookDeliveryReceipt } from "@sketch/shared";
import type { Kysely } from "kysely";
import {
  type WebhookEndpointRepositoryOptions,
  type WebhookEndpointRow,
  createWebhookEndpointsRepository,
} from "../db/repositories/webhook-endpoints";
import type { DB } from "../db/schema";
import { type WebhookSourceBinding, webhookBindingMetadata } from "./webhook-bindings";

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
