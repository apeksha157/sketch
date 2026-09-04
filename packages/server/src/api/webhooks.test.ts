import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../auth/encryption";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createWebhookDeliveryRepository } from "../db/repositories/webhook-deliveries";
import { createWebhookEndpointRepository } from "../db/repositories/webhook-endpoints";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { automationWebhookRoutes } from "./webhooks";

function webhookSteps() {
  return JSON.stringify([
    { id: "trigger-1", type: "trigger", triggerConfig: { type: "webhook" } },
    { id: "agent-1", type: "agent", agentMode: "sketch" },
  ]);
}

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SIGNING_SECRET = "clickup-signing-secret";
const JSON_MEDIA_TYPE = "application/json";
const CLICKUP_VERIFICATION = JSON.stringify({
  type: "hmac_sha256",
  signatureHeader: "x-signature",
  resourceIdField: "webhook_id",
  dedupe: { eventField: "event", itemsField: "history_items", itemIdField: "id" },
});

function clickUpBody(
  options: {
    event?: string;
    historyItems?: Array<{ id: string }>;
    resourceId?: string;
    extra?: Record<string, unknown>;
  } = {},
): string {
  return JSON.stringify({
    webhook_id: options.resourceId ?? "resource-1",
    event: options.event ?? "taskUpdated",
    history_items: options.historyItems ?? [{ id: "history-1" }],
    ...options.extra,
  });
}

function clickUpSignature(body: string): string {
  return createHmac("sha256", SIGNING_SECRET).update(Buffer.from(body, "utf8")).digest("hex");
}

describe("automation webhook routes", () => {
  let db: Kysely<DB>;
  let enqueueWebhookDelivery: (deliveryId: string) => Promise<boolean>;

  beforeEach(async () => {
    db = await createTestDb();
    enqueueWebhookDelivery = vi.fn<(deliveryId: string) => Promise<boolean>>().mockResolvedValue(true);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function addTask(status: "active" | "paused" = "active") {
    const tasks = createScheduledTaskRepository(db);
    return tasks.add({
      id: `task-${Math.random().toString(16).slice(2)}`,
      platform: "web",
      context_type: "dm",
      delivery_target: "conversation-1",
      thread_ts: null,
      prompt: "Process the webhook",
      schedule_type: "external",
      schedule_value: "webhook",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: null,
      status,
      next_run_at: null,
      steps: webhookSteps(),
    });
  }

  async function endpointForTask(taskId: string) {
    const endpoint = await createWebhookEndpointRepository(db).ensureForTask(taskId);
    return endpoint.endpoint;
  }

  async function signedEndpointForTask(taskId: string) {
    const endpoint = await endpointForTask(taskId);
    await db
      .updateTable("webhook_endpoints")
      .set({
        status: "active_signed",
        verification_json: CLICKUP_VERIFICATION,
        signing_secret_encrypted: encrypt(SIGNING_SECRET, ENCRYPTION_KEY),
        source_binding: JSON.stringify({
          integration: "clickup",
          accountId: "account-1",
          collectionPath: "list/123",
          callbackUrl: `https://sketch.example/api/webhooks/v1/${endpoint.id}`,
          resourceId: "resource-1",
        }),
      })
      .where("id", "=", endpoint.id)
      .execute();
    const signedEndpoint = await createWebhookEndpointRepository(db).getById(endpoint.id);
    if (!signedEndpoint) throw new Error("signed webhook endpoint fixture was not found");
    return signedEndpoint;
  }

  function app(encryptionKey?: string) {
    const app = new Hono();
    app.route(
      "/api/webhooks",
      automationWebhookRoutes({
        db,
        encryptionKey,
        scheduler: { enqueueWebhookDelivery },
      }),
    );
    return app;
  }

  it("admits an unauthenticated native JSON webhook durably without running an agent inline", async () => {
    const task = await addTask();
    const endpoint = await endpointForTask(task.id);
    const body = '{"event":"created"}';

    const response = await app().request(`/api/webhooks/v1/${endpoint.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Sketch-Webhook-Signature": "not-used",
      },
      body,
    });

    expect(response.status).toBe(202);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ accepted: true, duplicate: false, eventId: expect.any(String) });
    expect(enqueueWebhookDelivery).toHaveBeenCalledWith(receipt.deliveryId);
    const delivery = await createWebhookDeliveryRepository(db).getById(receipt.deliveryId);
    expect(delivery).toMatchObject({ endpoint_id: endpoint.id, task_id: task.id, payload_hash: expect.any(String) });
    expect(JSON.parse(delivery?.trigger_data ?? "{}")).toMatchObject({ source: "webhook", data: { event: "created" } });
  });

  it("accepts an optional Idempotency-Key and deduplicates matching retries", async () => {
    const task = await addTask();
    const endpoint = await endpointForTask(task.id);
    const headers = {
      "content-type": "application/json",
      "Idempotency-Key": "event-1",
    };
    const first = await app().request(`/api/webhooks/v1/${endpoint.id}`, {
      method: "POST",
      headers,
      body: '{"value":1}',
    });
    const firstReceipt = await first.json();
    const duplicate = await app().request(`/api/webhooks/v1/${endpoint.id}`, {
      method: "POST",
      headers,
      body: '{"value":1}',
    });
    const duplicateReceipt = await duplicate.json();
    expect(duplicate.status).toBe(202);
    expect(duplicateReceipt.deliveryId).toBe(firstReceipt.deliveryId);
    expect(duplicateReceipt.duplicate).toBe(true);

    const mismatch = await app().request(`/api/webhooks/v1/${endpoint.id}`, {
      method: "POST",
      headers,
      body: '{"value":2}',
    });
    expect(mismatch.status).toBe(409);
  });

  it("verifies a signed webhook over the exact raw body before admitting it", async () => {
    const task = await addTask();
    const endpoint = await signedEndpointForTask(task.id);
    const body = '{ "webhook_id": "resource-1", "event": "taskUpdated", "history_items": [{ "id": "history-1" }] }';
    const response = await app(ENCRYPTION_KEY).request(`/api/webhooks/v1/${endpoint?.id}`, {
      method: "POST",
      headers: { "content-type": JSON_MEDIA_TYPE, "x-signature": clickUpSignature(body) },
      body,
    });

    expect(response.status).toBe(202);
    const receipt = await response.json();
    expect(receipt).toMatchObject({
      accepted: true,
      duplicate: false,
      eventId: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(receipt).not.toHaveProperty("signingSecret");
    expect(receipt).not.toHaveProperty("sourceBinding");
    expect(enqueueWebhookDelivery).toHaveBeenCalledTimes(1);
    const delivery = await createWebhookDeliveryRepository(db).getById(receipt.deliveryId);
    expect(delivery?.trigger_data).not.toContain(SIGNING_SECRET);
    expect(delivery?.trigger_data).not.toContain("enc:");
  });

  it("rejects missing, malformed, and tampered signatures without parsing or admitting", async () => {
    const task = await addTask();
    const endpoint = await signedEndpointForTask(task.id);
    const body = clickUpBody();
    const path = `/api/webhooks/v1/${endpoint?.id}`;

    for (const signature of [undefined, "not-hex", "0".repeat(62), "0".repeat(66)]) {
      const headers = new Headers({ "content-type": JSON_MEDIA_TYPE });
      if (signature !== undefined) headers.set("x-signature", signature);
      const response = await app(ENCRYPTION_KEY).request(path, { method: "POST", headers, body });
      expect(response.status).toBe(401);
    }

    const tampered = await app(ENCRYPTION_KEY).request(path, {
      method: "POST",
      headers: { "content-type": JSON_MEDIA_TYPE, "x-signature": clickUpSignature(body) },
      body: `${body} `,
    });
    expect(tampered.status).toBe(401);
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
    await expect(createWebhookDeliveryRepository(db).list({ endpointId: endpoint?.id })).resolves.toHaveLength(0);
  });

  it("fails closed for a missing key, plaintext secret, malformed config, or missing binding", async () => {
    const cases = [
      { encryptionKey: undefined, update: {} },
      { encryptionKey: ENCRYPTION_KEY, update: { signing_secret_encrypted: SIGNING_SECRET } },
      { encryptionKey: ENCRYPTION_KEY, update: { verification_json: "not-json" } },
      { encryptionKey: ENCRYPTION_KEY, update: { source_binding: null } },
      { encryptionKey: ENCRYPTION_KEY, update: { status: "active" } },
    ];

    for (const [index, testCase] of cases.entries()) {
      const task = await addTask();
      const endpoint = await signedEndpointForTask(task.id);
      if (Object.keys(testCase.update).length > 0) {
        await db.updateTable("webhook_endpoints").set(testCase.update).where("id", "=", endpoint?.id).execute();
      }
      const body = clickUpBody({ extra: { case: index } });
      const response = await app(testCase.encryptionKey).request(`/api/webhooks/v1/${endpoint?.id}`, {
        method: "POST",
        headers: { "content-type": JSON_MEDIA_TYPE, "x-signature": clickUpSignature(body) },
        body,
      });
      expect(response.status).toBe(503);
    }
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it("enforces the source resource and signed protocol on the compatibility route", async () => {
    const task = await addTask();
    const endpoint = await signedEndpointForTask(task.id);
    const body = clickUpBody({ resourceId: "other-resource" });
    const wrongResource = await app(ENCRYPTION_KEY).request(`/api/webhooks/wf/${task.id}`, {
      method: "POST",
      headers: { "content-type": JSON_MEDIA_TYPE, "x-signature": clickUpSignature(body) },
      body,
    });
    expect(wrongResource.status).toBe(400);

    const missingSignature = await app(ENCRYPTION_KEY).request(`/api/webhooks/wf/${task.id}`, {
      method: "POST",
      headers: { "content-type": JSON_MEDIA_TYPE, "Idempotency-Key": "attacker-controlled" },
      body: clickUpBody(),
    });
    expect(missingSignature.status).toBe(401);
    expect(endpoint?.id).toBeTruthy();
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it("does not admit a pending signed endpoint", async () => {
    const task = await addTask();
    const endpoint = await signedEndpointForTask(task.id);
    await db.updateTable("webhook_endpoints").set({ status: "pending" }).where("id", "=", endpoint.id).execute();

    const body = clickUpBody();
    const response = await app(ENCRYPTION_KEY).request(`/api/webhooks/v1/${endpoint.id}`, {
      method: "POST",
      headers: { "content-type": JSON_MEDIA_TYPE, "x-signature": clickUpSignature(body) },
      body,
    });

    expect(response.status).toBe(404);
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
    await expect(createWebhookDeliveryRepository(db).list({ endpointId: endpoint.id })).resolves.toHaveLength(0);
  });

  it("deduplicates signed provider identity across header changes and JSON whitespace", async () => {
    const task = await addTask();
    const endpoint = await signedEndpointForTask(task.id);
    const firstBody = clickUpBody({ historyItems: [{ id: "history-1" }, { id: "history-2" }] });
    const secondBody =
      '{ "history_items": [{ "id": "history-2" }, { "id": "history-1" }], "event": "taskUpdated", "webhook_id": "resource-1" }';
    const first = await app(ENCRYPTION_KEY).request(`/api/webhooks/v1/${endpoint?.id}`, {
      method: "POST",
      headers: {
        "content-type": JSON_MEDIA_TYPE,
        "x-signature": clickUpSignature(firstBody),
        "Idempotency-Key": "one",
      },
      body: firstBody,
    });
    const firstReceipt = await first.json();
    const duplicate = await app(ENCRYPTION_KEY).request(`/api/webhooks/v1/${endpoint?.id}`, {
      method: "POST",
      headers: {
        "content-type": JSON_MEDIA_TYPE,
        "x-signature": clickUpSignature(secondBody),
        "Idempotency-Key": "two",
      },
      body: secondBody,
    });
    const duplicateReceipt = await duplicate.json();

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(duplicateReceipt).toMatchObject({ duplicate: true, deliveryId: firstReceipt.deliveryId });
    expect(enqueueWebhookDelivery).toHaveBeenCalledTimes(1);
  });

  it("uses raw payload hashes without history and separates distinct provider event kinds", async () => {
    const task = await addTask();
    const endpoint = await signedEndpointForTask(task.id);
    const noHistoryBody = clickUpBody({ historyItems: [] });
    const retry = await app(ENCRYPTION_KEY).request(`/api/webhooks/v1/${endpoint?.id}`, {
      method: "POST",
      headers: {
        "content-type": JSON_MEDIA_TYPE,
        "x-signature": clickUpSignature(noHistoryBody),
        "Idempotency-Key": "one",
      },
      body: noHistoryBody,
    });
    const retryReceipt = await retry.json();
    const sameProviderRetry = await app(ENCRYPTION_KEY).request(`/api/webhooks/v1/${endpoint?.id}`, {
      method: "POST",
      headers: {
        "content-type": JSON_MEDIA_TYPE,
        "x-signature": clickUpSignature(noHistoryBody),
        "Idempotency-Key": "two",
      },
      body: noHistoryBody,
    });
    const sameProviderRetryReceipt = await sameProviderRetry.json();
    const otherEventBody = clickUpBody({ event: "taskStatusUpdated", historyItems: [{ id: "history-1" }] });
    const otherEvent = await app(ENCRYPTION_KEY).request(`/api/webhooks/v1/${endpoint?.id}`, {
      method: "POST",
      headers: { "content-type": JSON_MEDIA_TYPE, "x-signature": clickUpSignature(otherEventBody) },
      body: otherEventBody,
    });

    expect(sameProviderRetryReceipt).toMatchObject({ duplicate: true, deliveryId: retryReceipt.deliveryId });
    expect(otherEvent.status).toBe(202);
    expect((await otherEvent.json()).deliveryId).not.toBe(retryReceipt.deliveryId);
    expect(enqueueWebhookDelivery).toHaveBeenCalledTimes(2);
  });

  it("records a valid signed event as terminal while paused and does not enqueue it after resume", async () => {
    const task = await addTask("paused");
    const endpoint = await signedEndpointForTask(task.id);
    const body = clickUpBody();
    const first = await app(ENCRYPTION_KEY).request(`/api/webhooks/v1/${endpoint?.id}`, {
      method: "POST",
      headers: { "content-type": JSON_MEDIA_TYPE, "x-signature": clickUpSignature(body) },
      body,
    });
    const firstReceipt = await first.json();
    await createScheduledTaskRepository(db).updateStatus(task.id, "active");
    const duplicate = await app(ENCRYPTION_KEY).request(`/api/webhooks/v1/${endpoint?.id}`, {
      method: "POST",
      headers: { "content-type": JSON_MEDIA_TYPE, "x-signature": clickUpSignature(body), "Idempotency-Key": "ignored" },
      body,
    });

    expect(first.status).toBe(202);
    expect(firstReceipt).toMatchObject({ paused: true, ignored: true, duplicate: false });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ duplicate: true, deliveryId: firstReceipt.deliveryId });
    await expect(createWebhookDeliveryRepository(db).getById(firstReceipt.deliveryId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it("rejects malformed requests and inactive or deactivated endpoints", async () => {
    const activeTask = await addTask();
    const activeEndpoint = await endpointForTask(activeTask.id);
    const baseHeaders = {
      "content-type": "application/json",
      "Idempotency-Key": "validation-event",
    };

    expect(
      (
        await app().request(`/api/webhooks/v1/${activeEndpoint.id}`, {
          method: "POST",
          headers: baseHeaders,
          body: "not-json",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app().request(`/api/webhooks/v1/${activeEndpoint.id}`, {
          method: "POST",
          headers: { "Idempotency-Key": "missing-content-type" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await app().request(`/api/webhooks/v1/${activeEndpoint.id}`, {
          method: "POST",
          headers: { ...baseHeaders, "Idempotency-Key": "x".repeat(201) },
          body: "{}",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app().request(`/api/webhooks/v1/${activeEndpoint.id}`, {
          method: "POST",
          headers: baseHeaders,
          body: "x".repeat(1_000_001),
        })
      ).status,
    ).toBe(413);

    const pausedTask = await addTask("paused");
    const pausedEndpoint = await endpointForTask(pausedTask.id);
    expect(
      (
        await app().request(`/api/webhooks/v1/${pausedEndpoint.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(409);

    await createWebhookEndpointRepository(db).deactivateForTask(activeTask.id);
    expect(
      (
        await app().request(`/api/webhooks/v1/${activeEndpoint.id}`, {
          method: "POST",
          headers: baseHeaders,
          body: "{}",
        })
      ).status,
    ).toBe(404);
    expect((await app().request("/api/webhooks/v1/missing", { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("keeps the task-id compatibility route unauthenticated", async () => {
    const task = await addTask();
    await endpointForTask(task.id);
    const response = await app().request(`/api/webhooks/wf/${task.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(202);
  });
});
