import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { expect, vi } from "vitest";
import { automationWebhookRoutes } from "../../api/webhooks";
import { deleteAutomation, getAutomationDefinition } from "../../automation/persistence";
import { createWebhookEndpointRepository } from "../../db/repositories/webhook-endpoints";
import type { DB } from "../../db/schema";
import type { TaskScheduler } from "../../scheduler/service";
import { executeClickUpApi } from "./clickup-api";
import { handleManageScheduledTasks } from "./scheduled-tasks";
import type { SketchMcpDeps } from "./types";

/** Exercises the real builder tools, native receiver, and task lifecycle for disjoint provider subscriptions. */
export async function verifyScopedWebhookSlots(params: {
  db: Kysely<DB>;
  deps: SketchMcpDeps;
  scheduler: TaskScheduler;
  taskId: string;
  key: string;
  baseUrl: string;
}) {
  const { db, deps, scheduler, taskId, key, baseUrl } = params;
  if (!deps.taskContext) throw new Error("Missing authoring context");
  const manageDeps = {
    db,
    scheduler,
    taskContext: deps.taskContext,
    config: { BASE_URL: baseUrl, PORT: 3000 },
    encryptionKey: key,
  };
  const slots: { slot: string; endpointId: string; url: string; listId: string; secret: string; resourceId: string }[] =
    [];
  for (let index = 0; index < 6; index++) {
    const slot = index === 0 ? "default" : `list-${index + 1}`;
    const args = { action: "ensureWebhookEndpoint" as const, task_id: taskId, webhook_slot: slot };
    const first = await handleManageScheduledTasks(args, manageDeps);
    const metadata = JSON.parse(first.content[0].text);
    const repeated = JSON.parse((await handleManageScheduledTasks(args, manageDeps)).content[0].text);
    expect(repeated.webhookEndpointId).toBe(metadata.webhookEndpointId);
    slots.push({
      slot,
      endpointId: metadata.webhookEndpointId,
      url: metadata.webhookUrl,
      listId: String(index + 1),
      secret: `signing-secret-${index}`,
      resourceId: `hook-${index}`,
    });
  }
  expect(new Set(slots.map((slot) => slot.endpointId)).size).toBe(6);
  await expect(scheduler.resumeTask(taskId)).rejects.toThrow(/reconcile/);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(String(init?.body));
    const slot = slots.find((slot) => slot.url === body.endpoint);
    if (!slot) throw new Error("Unknown callback");
    expect(String(body.list_id)).toBe(slot.listId);
    return new Response(
      JSON.stringify({
        webhook: {
          id: slot.resourceId,
          team_id: "123",
          endpoint: slot.url,
          list_id: slot.listId,
          events: ["taskCreated"],
          secret: slot.secret,
          health: { status: "active", fail_count: 0 },
        },
      }),
    );
  });
  for (const [index, slot] of slots.entries()) {
    await executeClickUpApi(
      {
        method: "POST",
        path: "/team/123/webhook",
        accountId: "canvas-account-1",
        webhookEndpointId: slot.endpointId,
        body: { endpoint: slot.url, events: ["taskCreated"], list_id: slot.listId },
      },
      deps,
    );
    if (index < slots.length - 1) await expect(scheduler.resumeTask(taskId)).rejects.toThrow(/reconcile/);
  }
  const boundRows = await createWebhookEndpointRepository(db).listByTaskId(taskId);
  expect(boundRows).toHaveLength(6);
  expect(new Set(boundRows.map((row) => row.signing_secret_encrypted)).size).toBe(6);
  await scheduler.resumeTask(taskId);
  const enqueue = vi.fn().mockResolvedValue(true);
  const app = new Hono().route(
    "/api/webhooks",
    automationWebhookRoutes({ db, encryptionKey: key, scheduler: { enqueueWebhookDelivery: enqueue } }),
  );
  for (const slot of slots) {
    const body = JSON.stringify({
      event: "taskCreated",
      webhook_id: slot.resourceId,
      task_id: `task-${slot.listId}`,
      history_items: [{ id: "provider-event" }],
    });
    const request = (secret: string) =>
      app.request(`/api/webhooks/v1/${slot.endpointId}`, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Signature": createHmac("sha256", secret).update(body).digest("hex"),
        },
      });
    expect((await request("wrong-secret")).status).toBe(401);
    expect((await request(slot.secret)).status).toBe(202);
    const duplicate = await request(slot.secret);
    expect((await duplicate.json()).duplicate).toBe(true);
  }
  expect(enqueue).toHaveBeenCalledTimes(6);
  const definition = await getAutomationDefinition({ db, taskId, webhookBaseUrl: baseUrl });
  const metadata = definition?.steps.find((step) => step.type === "trigger")?.triggerConfig?.webhookEndpoints;
  expect(metadata).toHaveLength(6);
  expect(
    metadata?.every(
      (endpoint) =>
        endpoint.lastDelivery?.endpointId === endpoint.endpointId &&
        endpoint.binding?.subscription?.scope?.field === "list_id",
    ),
  ).toBe(true);
  expect(JSON.stringify(metadata)).not.toContain("signing-secret-");
  await scheduler.pauseTask(taskId);
  const cleanup = (slot: (typeof slots)[number]) =>
    executeClickUpApi(
      {
        method: "DELETE",
        path: `/webhook/${slot.resourceId}`,
        accountId: "canvas-account-1",
        webhookEndpointId: slot.endpointId,
      },
      deps,
    );
  await cleanup(slots[0]);
  await expect(
    deleteAutomation({
      db,
      taskId,
      actor: { userId: "owner" },
      scheduler: { removeTaskRuntime: vi.fn().mockReturnValue(true) },
    }),
  ).resolves.toEqual({ kind: "webhook_cleanup_required" });
  await expect(createWebhookEndpointRepository(db).deleteByTaskId(taskId)).rejects.toThrow(/remote webhook/);
  const blockedRetirement = await handleManageScheduledTasks(
    { action: "retireWebhookEndpoint", task_id: taskId, webhook_slot: slots[1].slot },
    manageDeps,
  );
  expect(blockedRetirement.content[0].text).toContain("Delete the exact remote subscription");
  for (const slot of slots.slice(1)) await cleanup(slot);
  await expect(
    deleteAutomation({
      db,
      taskId,
      actor: { userId: "owner" },
      scheduler: { removeTaskRuntime: vi.fn().mockReturnValue(true) },
    }),
  ).resolves.toEqual({ kind: "deleted" });
  expect(await createWebhookEndpointRepository(db).listByTaskId(taskId)).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(12);
}
