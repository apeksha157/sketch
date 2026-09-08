import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationWebhookRoutes } from "../../api/webhooks";
import { decrypt } from "../../auth/encryption";
import { createSettingsRepository } from "../../db/repositories/settings";
import { createWebhookEndpointRepository } from "../../db/repositories/webhook-endpoints";
import type { DB } from "../../db/schema";
import { TaskScheduler, type TaskSchedulerDeps } from "../../scheduler/service";
import { createTestConfig, createTestLogger, createTestPgDb } from "../../test-utils";
import { type ClickUpApiArgs, executeClickUpApi } from "./clickup-api";
import { verifyScopedWebhookSlots } from "./clickup-webhook-slots.test-support";
import { handleManageScheduledTasks } from "./scheduled-tasks";
import { type SketchMcpDeps, UploadCollector } from "./types";

const KEY = "1".repeat(64);
const OAUTH_TOKEN = "canvas-minted-oauth-token";
const SIGNING_SECRET = "provider-signing-secret";
const BASE_URL = "https://sketch.example.test";

describe("Postgres ClickUp registration readiness and immutable delivery history", () => {
  let db: Kysely<DB>;
  let deps: SketchMcpDeps;
  let taskId: string;
  let endpointId: string;
  let callbackUrl: string;
  let scheduler: TaskScheduler;

  beforeEach(async () => {
    db = await createTestPgDb();
    await db
      .insertInto("users")
      .values([
        { id: "owner", name: "Owner" },
        { id: "other", name: "Other" },
      ])
      .execute();
    scheduler = new TaskScheduler({
      db,
      config: createTestConfig({ BASE_URL, ENCRYPTION_KEY: KEY }),
      logger: createTestLogger(),
      settingsRepo: createSettingsRepository(db, KEY),
    } as TaskSchedulerDeps);
    const taskContext = {
      platform: "slack" as const,
      contextType: "dm" as const,
      deliveryTarget: "D1",
      createdBy: "owner",
    };
    const created = await handleManageScheduledTasks(
      {
        action: "add",
        title: "ClickUp status updates",
        prompt: "Report changed statuses without changing ClickUp tasks.",
        schedule_type: "external",
        schedule_value: "webhook",
        status: "paused",
      },
      { db, scheduler, taskContext, config: { BASE_URL, PORT: 3000 }, encryptionKey: KEY },
    );
    expect(created.content[0].text).toContain("Automation created:");
    const task = await db.selectFrom("scheduled_tasks").selectAll().executeTakeFirstOrThrow();
    taskId = task.id;
    await scheduler.pauseTask(taskId);
    const endpoint = await createWebhookEndpointRepository(db).getByTaskId(taskId);
    if (!endpoint) throw new Error("ManageScheduledTasks did not create a native endpoint");
    endpointId = endpoint.id;
    callbackUrl = `${BASE_URL}/api/webhooks/v1/${endpointId}`;
    expect(created.content[0].text).toContain(callbackUrl);
    deps = {
      db,
      workspaceDir: "/tmp/sketch-clickup-test",
      uploadCollector: new UploadCollector(),
      currentUserId: "owner",
      currentUserEmail: "owner@example.test",
      taskContext,
      availableManagedIntegrations: new Set(["clickup"]),
      settingsEncryptionKey: KEY,
      toolConfig: { BASE_URL, PORT: 3000 },
      getCanvasAccessToken: vi.fn().mockResolvedValue({ accessToken: OAUTH_TOKEN }),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  function request(method: ClickUpApiArgs["method"] = "POST"): ClickUpApiArgs {
    return {
      method,
      path: method === "POST" || method === "GET" ? "/team/123/webhook" : "/webhook/hook-1",
      accountId: "canvas-account-1",
      webhookEndpointId: endpointId,
      files: undefined,
      ...(method === "POST" || method === "PUT"
        ? { body: { endpoint: callbackUrl, events: ["taskStatusUpdated"], list_id: 456 } }
        : {}),
    };
  }

  function remote(overrides: Record<string, unknown> = {}) {
    return {
      id: "hook-1",
      team_id: "123",
      endpoint: callbackUrl,
      events: ["taskStatusUpdated"],
      list_id: "456",
      secret: SIGNING_SECRET,
      health: { status: "active", fail_count: 0 },
      ...overrides,
    };
  }

  const storedEndpoint = () =>
    db.selectFrom("webhook_endpoints").selectAll().where("id", "=", endpointId).executeTakeFirstOrThrow();
  const success = () => new Response(JSON.stringify({ webhook: remote() }), { status: 200 });

  async function admitSignedReceipt(
    options: { historyId?: string; enqueue?: (deliveryId: string) => Promise<boolean> } = {},
  ) {
    const enqueue = options.enqueue ?? vi.fn().mockResolvedValue(true);
    const app = new Hono().route(
      "/api/webhooks",
      automationWebhookRoutes({ db, encryptionKey: KEY, scheduler: { enqueueWebhookDelivery: enqueue } }),
    );
    const body = JSON.stringify({
      event: "taskStatusUpdated",
      webhook_id: "hook-1",
      task_id: "task-abc",
      history_items: [{ id: options.historyId ?? "receipt-1" }],
    });
    const response = await app.request(`/api/webhooks/v1/${endpointId}`, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "X-Signature": createHmac("sha256", SIGNING_SECRET).update(body).digest("hex"),
      },
    });
    return { app, response, receipt: await response.json(), enqueue };
  }

  async function register() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => success());
    return executeClickUpApi(request(), deps);
  }

  it("runs six disjoint list subscriptions under one automation and fences cleanup across all slots", async () => {
    await verifyScopedWebhookSlots({ db, deps, scheduler, taskId, key: KEY, baseUrl: BASE_URL });
  });

  it("retires an unused default without deleting working provider subscriptions", async () => {
    await verifyScopedWebhookSlots({ db, deps, scheduler, taskId, key: KEY, baseUrl: BASE_URL, unusedDefault: true });
  });

  it("mismatched remote scope must remain unavailable after a signed delivery", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ webhook: remote({ list_id: null }) })),
    );
    await expect(executeClickUpApi(request(), deps)).rejects.toThrow(/events or location/);
    expect((await storedEndpoint()).status).toBe("pending");
    await admitSignedReceipt();
    await expect(scheduler.resumeTask(taskId)).rejects.toThrow();
  });

  it("rejected update must not rewrite historical receipt generations", async () => {
    await register();
    await admitSignedReceipt();
    const before = await db
      .selectFrom("webhook_deliveries")
      .selectAll()
      .where("endpoint_id", "=", endpointId)
      .executeTakeFirstOrThrow();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ECODE: "INPUT_001" }), { status: 400 }),
    );
    await expect(executeClickUpApi(request("PUT"), deps)).rejects.toThrow();
    const after = await db
      .selectFrom("webhook_deliveries")
      .selectAll()
      .where("id", "=", before.id)
      .executeTakeFirstOrThrow();
    expect(after.endpoint_generation).toBe(before.endpoint_generation);
  });

  it("activates a validated quiet webhook without discarding its first real event", async () => {
    await register();
    await expect(scheduler.resumeTask(taskId)).resolves.toBeUndefined();
    const first = await admitSignedReceipt();
    expect(first.response.status).toBe(202);
    expect(first.receipt.paused).not.toBe(true);
    expect(first.enqueue).toHaveBeenCalledWith(first.receipt.deliveryId);
  });
});
