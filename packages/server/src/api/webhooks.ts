import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { type Kysely, sql } from "kysely";
import type { Logger } from "pino";
import { isAutomationWebhookTrigger, parseAutomationTriggerConfig } from "../automation/webhook";
import {
  WEBHOOK_BODY_LIMIT_BYTES,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_ID_MAX_LENGTH,
} from "../automation/webhook-endpoints";
import {
  parseWebhookVerification,
  verifyWebhookRequest,
  webhookEventIdentity,
} from "../automation/webhook-verification";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createWebhookDeliveryRepository } from "../db/repositories/webhook-deliveries";
import {
  WEBHOOK_ENDPOINT_STATUS_ACTIVE,
  WEBHOOK_ENDPOINT_STATUS_SIGNED,
  createWebhookEndpointRepository,
  isWebhookEndpointActive,
} from "../db/repositories/webhook-endpoints";
import type { DB } from "../db/schema";
import type { TaskScheduler } from "../scheduler/service";

const JSON_MEDIA_TYPE = "application/json";

type WebhookRouteKind = "endpoint" | "compatibility";
type WebhookAdmissionResult = Awaited<ReturnType<ReturnType<typeof createWebhookDeliveryRepository>["insertOrGet"]>>;

interface AutomationWebhookRouteDeps {
  db: Kysely<DB>;
  encryptionKey?: string;
  logger?: Logger;
  scheduler: Pick<TaskScheduler, "enqueueWebhookDelivery">;
}

class WebhookBodyTooLargeError extends Error {}

async function readRawBody(request: Request): Promise<Buffer> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      size += chunk.byteLength;
      if (size > WEBHOOK_BODY_LIMIT_BYTES) {
        await reader.cancel();
        throw new WebhookBodyTooLargeError("Webhook payload is too large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function isJsonMediaType(value: string | undefined): boolean {
  if (!value) return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === JSON_MEDIA_TYPE;
}

function errorResponse(c: Context, code: string, message: string, status: 400 | 401 | 404 | 409 | 413 | 415 | 503) {
  return c.json({ error: { code, message } }, status);
}

function requestEventId(value: string | undefined): string | undefined {
  if (value === undefined) return randomUUID();
  if (value.trim().length === 0 || value.length > WEBHOOK_EVENT_ID_MAX_LENGTH) return undefined;
  return value;
}

function hasSignedMetadata(endpoint: {
  verification_json: string | null;
  signing_secret_encrypted: string | null;
  source_binding: string | null;
}): boolean {
  return (
    endpoint.verification_json !== null ||
    endpoint.signing_secret_encrypted !== null ||
    endpoint.source_binding !== null
  );
}

function endpointAuthMatches(
  left: {
    verification_json: string | null;
    signing_secret_encrypted: string | null;
    source_binding: string | null;
  },
  right: {
    verification_json: string | null;
    signing_secret_encrypted: string | null;
    source_binding: string | null;
  },
): boolean {
  return (
    left.verification_json === right.verification_json &&
    left.signing_secret_encrypted === right.signing_secret_encrypted &&
    left.source_binding === right.source_binding
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function automationWebhookRoutes(deps: AutomationWebhookRouteDeps) {
  const routes = new Hono();
  const tasks = createScheduledTaskRepository(deps.db);
  const endpoints = createWebhookEndpointRepository(deps.db, deps.encryptionKey);

  const handleWebhook = async (c: Context, kind: WebhookRouteKind) => {
    const identifier = c.req.param(kind === "endpoint" ? "endpointId" : "taskId");
    let endpoint: Awaited<ReturnType<typeof endpoints.getById>>;
    try {
      endpoint = kind === "endpoint" ? await endpoints.getById(identifier) : await endpoints.getByTaskId(identifier);
    } catch (error) {
      deps.logger?.error({ err: error, endpointId: identifier }, "Webhook endpoint lookup failed");
      return errorResponse(c, "WEBHOOK_UNAVAILABLE", "Webhook endpoint is temporarily unavailable", 503);
    }

    if (!endpoint || !isWebhookEndpointActive(endpoint.status)) {
      return errorResponse(c, "NOT_FOUND", "Webhook endpoint not found", 404);
    }

    const signed = endpoint.status === WEBHOOK_ENDPOINT_STATUS_SIGNED || hasSignedMetadata(endpoint);
    if (signed && endpoint.status !== WEBHOOK_ENDPOINT_STATUS_SIGNED) {
      return errorResponse(c, "WEBHOOK_VERIFICATION_UNAVAILABLE", "Webhook verification is unavailable", 503);
    }

    const task = await tasks.getById(endpoint.task_id);
    const trigger = task
      ? parseAutomationTriggerConfig(task.steps, {
          scheduleType: task.schedule_type,
          scheduleValue: task.schedule_value,
        })
      : undefined;
    if (!task || !trigger || !isAutomationWebhookTrigger(trigger)) {
      return errorResponse(c, "NOT_FOUND", "Webhook endpoint not found", 404);
    }

    if (!isJsonMediaType(c.req.header("content-type"))) {
      return errorResponse(c, "UNSUPPORTED_MEDIA_TYPE", "Webhook content type must be application/json", 415);
    }

    const contentLengthHeader = c.req.header("content-length");
    if (contentLengthHeader !== undefined) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > WEBHOOK_BODY_LIMIT_BYTES) {
        return errorResponse(c, "PAYLOAD_TOO_LARGE", "Webhook payload is too large", 413);
      }
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(c.req.raw);
    } catch (error) {
      if (error instanceof WebhookBodyTooLargeError) {
        return errorResponse(c, "PAYLOAD_TOO_LARGE", "Webhook payload is too large", 413);
      }
      throw error;
    }

    if (signed) {
      const verification = parseWebhookVerification(endpoint.verification_json);
      const verificationResult = verifyWebhookRequest({
        rawBody,
        signature: verification ? c.req.header(verification.signatureHeader) : undefined,
        verificationJson: endpoint.verification_json,
        signingSecretEncrypted: endpoint.signing_secret_encrypted,
        sourceBinding: endpoint.source_binding,
        encryptionKey: deps.encryptionKey,
      });
      if (verificationResult.kind === "invalid_configuration") {
        return errorResponse(c, "WEBHOOK_VERIFICATION_UNAVAILABLE", "Webhook verification is unavailable", 503);
      }
      if (verificationResult.kind === "invalid_signature") {
        return errorResponse(c, "WEBHOOK_SIGNATURE_INVALID", "Webhook signature is invalid", 401);
      }

      let data: unknown;
      try {
        data = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return errorResponse(c, "INVALID_JSON", "Webhook payload must be valid JSON", 400);
      }
      if (!isRecord(data)) {
        return errorResponse(c, "INVALID_JSON", "Webhook payload must be a JSON object", 400);
      }

      const resourceId = data[verificationResult.verification.resourceIdField];
      if (resourceId !== verificationResult.sourceBinding.resourceId) {
        return errorResponse(c, "WEBHOOK_RESOURCE_MISMATCH", "Webhook resource is not bound to this endpoint", 400);
      }
      const identity = webhookEventIdentity(
        rawBody,
        data,
        verificationResult.verification,
        verificationResult.sourceBinding.resourceId,
      );
      return admitAndQueue(c, {
        deps,
        endpoint,
        task,
        trigger,
        eventId: identity.eventId,
        payloadHash: identity.payloadHash,
        triggerData: {
          source: "webhook",
          requestedAt: new Date().toISOString(),
          eventId: identity.eventId,
          data,
        },
        signed: true,
      });
    }

    if (task.status !== "active") {
      return errorResponse(c, "AUTOMATION_INACTIVE", "Automation is not active", 409);
    }

    let data: unknown;
    try {
      data = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return errorResponse(c, "INVALID_JSON", "Webhook payload must be valid JSON", 400);
    }

    const eventId = requestEventId(c.req.header(WEBHOOK_EVENT_ID_HEADER));
    if (eventId === undefined) {
      return errorResponse(c, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be between 1 and 200 characters", 400);
    }
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    return admitAndQueue(c, {
      deps,
      endpoint,
      task,
      trigger,
      eventId,
      payloadHash,
      triggerData: {
        source: "webhook",
        requestedAt: new Date().toISOString(),
        eventId,
        data,
      },
      signed: false,
    });
  };

  routes.post("/v1/:endpointId", (c) => handleWebhook(c, "endpoint"));
  routes.post("/wf/:taskId", (c) => handleWebhook(c, "compatibility"));

  return routes;
}

async function admitAndQueue(
  c: Context,
  params: {
    deps: AutomationWebhookRouteDeps;
    endpoint: NonNullable<Awaited<ReturnType<ReturnType<typeof createWebhookEndpointRepository>["getById"]>>>;
    task: NonNullable<Awaited<ReturnType<ReturnType<typeof createScheduledTaskRepository>["getById"]>>>;
    trigger: { type: string };
    eventId: string;
    payloadHash: string;
    triggerData: Record<string, unknown>;
    signed: boolean;
  },
) {
  type Admission =
    | { readonly kind: "state_changed" }
    | {
        readonly kind: "admitted";
        readonly delivery: WebhookAdmissionResult["delivery"];
        readonly created: boolean;
        readonly paused: boolean;
      };
  let admission: Admission;
  try {
    admission = await params.deps.db.transaction().execute(async (trx) => {
      const currentTask = await trx
        .updateTable("scheduled_tasks")
        .set({ revision: sql<number>`revision` })
        .where("id", "=", params.task.id)
        .returningAll()
        .executeTakeFirst();
      const currentEndpoint = await trx
        .selectFrom("webhook_endpoints")
        .selectAll()
        .where("id", "=", params.endpoint.id)
        .executeTakeFirst();
      if (!currentTask || !currentEndpoint) return { kind: "state_changed" as const };
      const taskUnchanged =
        currentTask.revision === params.task.revision &&
        currentEndpoint.task_id === params.endpoint.task_id &&
        currentEndpoint.generation === params.endpoint.generation &&
        currentEndpoint.status === params.endpoint.status &&
        endpointAuthMatches(currentEndpoint, params.endpoint);
      if (!taskUnchanged) return { kind: "state_changed" as const };
      if (
        params.signed &&
        (currentEndpoint.status !== WEBHOOK_ENDPOINT_STATUS_SIGNED ||
          (params.task.status === "paused" && currentTask.status === "active") ||
          currentTask.status === "completed")
      ) {
        return { kind: "state_changed" as const };
      }
      if (
        !params.signed &&
        (currentEndpoint.status !== WEBHOOK_ENDPOINT_STATUS_ACTIVE || currentTask.status !== "active")
      ) {
        return { kind: "state_changed" as const };
      }

      const paused = params.signed && currentTask.status !== "active";
      const delivery = await createWebhookDeliveryRepository(trx).insertOrGet({
        endpointId: params.endpoint.id,
        taskId: params.endpoint.task_id,
        eventId: params.eventId,
        payloadHash: params.payloadHash,
        triggerData: params.triggerData,
        taskRevision: params.task.revision,
        endpointGeneration: params.endpoint.generation,
        status: paused ? "cancelled" : "pending",
      });
      return { kind: "admitted" as const, ...delivery, paused };
    });
  } catch (error) {
    params.deps.logger?.error({ err: error, endpointId: params.endpoint.id }, "Webhook durable admission failed");
    return errorResponse(c, "ADMISSION_UNAVAILABLE", "Webhook admission is temporarily unavailable", 503);
  }

  if (admission.kind === "state_changed") {
    return errorResponse(c, "WEBHOOK_STATE_CHANGED", "Webhook endpoint or automation changed during admission", 409);
  }

  const { delivery, created, paused } = admission;
  if (!params.signed && delivery.payload_hash !== params.payloadHash) {
    return errorResponse(c, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different payload", 409);
  }

  const shouldEnqueue = params.signed ? created && !paused : !isTerminalDelivery(delivery.status);
  if (shouldEnqueue) {
    try {
      await params.deps.scheduler.enqueueWebhookDelivery(delivery.id);
    } catch (error) {
      params.deps.logger?.warn({ error, deliveryId: delivery.id }, "Webhook delivery handoff failed");
    }
  }

  return c.json(
    {
      accepted: true,
      duplicate: !created,
      ...(params.signed && paused ? { paused: true, ignored: true } : {}),
      deliveryId: delivery.id,
      eventId: delivery.event_id,
      taskId: params.task.id,
      trigger: {
        type: params.trigger.type,
        method: "POST",
        contentType: JSON_MEDIA_TYPE,
      },
    },
    202,
  );
}

function isTerminalDelivery(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
