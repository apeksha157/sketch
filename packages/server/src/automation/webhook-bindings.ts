import { type WebhookSourceBinding, webhookSourceBindingSchema } from "@sketch/shared";
import { type Kysely, sql } from "kysely";
import type { WebhookEndpointRow } from "../db/repositories/webhook-endpoints";
import type { DB } from "../db/schema";
import { authorizeAuthoringLease } from "./lock-service";
import { isAutomationWebhookTrigger, parseAutomationTriggerConfig } from "./webhook";
import { isWebhookVerificationReady } from "./webhook-verification";

export { type WebhookSourceBinding, webhookSourceBindingSchema } from "@sketch/shared";

export function webhookBindingMetadata(endpoint: WebhookEndpointRow): WebhookSourceBinding | undefined {
  try {
    const parsed = webhookSourceBindingSchema.safeParse(JSON.parse(endpoint.source_binding ?? "null"));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export class WebhookBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookBindingError";
  }
}

export class WebhookNotReadyError extends WebhookBindingError {
  constructor() {
    super("Complete or reconcile the signed webhook through its provider API before activating this automation.");
    this.name = "WebhookNotReadyError";
  }
}

export function readWebhookSourceBinding(endpoint: WebhookEndpointRow): WebhookSourceBinding | null {
  if (endpoint.source_binding === null) return null;
  try {
    return webhookSourceBindingSchema.parse(JSON.parse(endpoint.source_binding));
  } catch {
    throw new WebhookBindingError(
      "The stored webhook binding is invalid. Keep this automation paused and reconcile it.",
    );
  }
}

/** Called with the task row locked by the enclosing mutation transaction. */
export async function assertWebhookEndpointReady(
  db: Kysely<DB>,
  taskId: string,
  encryptionKey?: string,
): Promise<void> {
  const task = await db.selectFrom("scheduled_tasks").selectAll().where("id", "=", taskId).executeTakeFirst();
  if (!task) return;
  const trigger = parseAutomationTriggerConfig(task.steps, {
    scheduleType: task.schedule_type,
    scheduleValue: task.schedule_value,
  });
  if (!trigger || !isAutomationWebhookTrigger(trigger)) return;
  const endpoint = await db
    .selectFrom("webhook_endpoints")
    .selectAll()
    .where("task_id", "=", taskId)
    .executeTakeFirst();
  if (
    !endpoint ||
    (endpoint.verification_json === null &&
      endpoint.source_binding === null &&
      endpoint.signing_secret_encrypted === null &&
      (endpoint.status === "active" || endpoint.status === "revoked"))
  )
    return;
  if (
    endpoint.status !== "active_signed" ||
    !isWebhookVerificationReady({
      verificationJson: endpoint.verification_json,
      signingSecretEncrypted: endpoint.signing_secret_encrypted,
      sourceBinding: endpoint.source_binding,
      encryptionKey,
    })
  ) {
    throw new WebhookNotReadyError();
  }
}

/**
 * Save only under the owner's authoring lease, while paused. The task row lock
 * serializes activation/deletion; endpoint generations fence late HTTP results
 * and deliveries. No provider requests, retries, or action catalog live here.
 */
export async function updateWebhookBinding(params: {
  db: Kysely<DB>;
  endpoint: WebhookEndpointRow;
  userId: string;
  lease: { sessionId: string; generation: number };
  binding: WebhookSourceBinding | null;
  verificationJson: string;
  encryptedSecret: string | null;
  status: "pending" | "active_signed" | "revoked";
}): Promise<WebhookEndpointRow> {
  return params.db.transaction().execute(async (trx) => {
    const authorization = await authorizeAuthoringLease(trx, {
      taskId: params.endpoint.task_id,
      userId: params.userId,
      sessionId: params.lease.sessionId,
      generation: params.lease.generation,
    });
    if (authorization.kind !== "held") {
      throw new WebhookBindingError(
        "The automation editing lease changed or expired. Refresh before reconciling the webhook.",
      );
    }
    const task = await trx
      .updateTable("scheduled_tasks")
      .set({ revision: sql<number>`revision` })
      .where("id", "=", params.endpoint.task_id)
      .where("created_by", "=", params.userId)
      .where("status", "=", "paused")
      .returningAll()
      .executeTakeFirst();
    if (!task) throw new WebhookBindingError("Only the owner of a paused automation can change its webhook binding.");
    const trigger = parseAutomationTriggerConfig(task.steps, {
      scheduleType: task.schedule_type,
      scheduleValue: task.schedule_value,
    });
    if (!trigger || !isAutomationWebhookTrigger(trigger)) {
      throw new WebhookBindingError("Use a Sketch-native webhook automation before binding a provider webhook.");
    }
    const saved = await trx
      .updateTable("webhook_endpoints")
      .set({
        source_binding: params.binding ? JSON.stringify(params.binding) : null,
        verification_json: params.verificationJson,
        signing_secret_encrypted: params.encryptedSecret,
        status: params.status,
        generation: sql<number>`generation + 1`,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", params.endpoint.id)
      .where("task_id", "=", task.id)
      .where("generation", "=", params.endpoint.generation)
      .returningAll()
      .executeTakeFirst();
    if (!saved) throw new WebhookBindingError("The webhook changed during the request. Reconcile it before retrying.");
    return saved;
  });
}
