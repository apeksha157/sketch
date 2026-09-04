import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationWebhookRoutes } from "../../api/webhooks";
import { decrypt } from "../../auth/encryption";
import { deleteAutomation, getAutomationDefinition, updateAutomationDefinition } from "../../automation/persistence";
import { assertWebhookEndpointReady } from "../../automation/webhook-bindings";
import { createScheduledTaskRepository } from "../../db/repositories/scheduled-tasks";
import { createSettingsRepository } from "../../db/repositories/settings";
import { createWebhookEndpointRepository } from "../../db/repositories/webhook-endpoints";
import type { DB } from "../../db/schema";
import { TaskScheduler, type TaskSchedulerDeps } from "../../scheduler/service";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";
import { type ClickUpApiArgs, createClickUpApiTool, executeClickUpApi, handleClickUpApi } from "./clickup-api";
import { handleManageScheduledTasks } from "./scheduled-tasks";
import { type SketchMcpDeps, UploadCollector } from "./types";

const KEY = "1".repeat(64);
const OAUTH_TOKEN = "canvas-minted-oauth-token";
const SIGNING_SECRET = "provider-signing-secret";
const BASE_URL = "https://sketch.example.test";

describe("skill-led ClickUp webhook binding through existing tools", () => {
  let db: Kysely<DB>;
  let deps: SketchMcpDeps;
  let taskId: string;
  let endpointId: string;
  let callbackUrl: string;
  let scheduler: TaskScheduler;

  beforeEach(async () => {
    db = await createTestDb();
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

  async function register() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => success());
    return executeClickUpApi(request(), deps);
  }

  it("captures the API-created secret through the tool handler and admits an authenticated delivery", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const pending = await storedEndpoint();
      expect(pending.status).toBe("pending");
      expect(pending.signing_secret_encrypted).toBeNull();
      expect(JSON.parse(pending.source_binding ?? "{}")).toMatchObject({
        accountId: "canvas-account-1",
        resourceId: null,
      });
      return success();
    });
    const result = await createClickUpApiTool(deps).handler(
      { query: undefined, body: undefined, accountId: undefined, webhookEndpointId: undefined, ...request() },
      {},
    );
    expect(JSON.stringify(result)).not.toContain(SIGNING_SECRET);
    expect(JSON.stringify(result)).not.toContain(OAUTH_TOKEN);
    expect(JSON.stringify(result)).toContain("active_signed");
    const saved = await storedEndpoint();
    expect(saved.status).toBe("active_signed");
    expect(saved.signing_secret_encrypted).toMatch(/^enc:/);
    expect(decrypt(saved.signing_secret_encrypted ?? "", KEY)).toBe(SIGNING_SECRET);
    expect(deps.getCanvasAccessToken).toHaveBeenCalledWith({
      integration: "clickup",
      accountId: "canvas-account-1",
      forceRefresh: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clickup.com/api/v2/team/123/webhook",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({ Authorization: `Bearer ${OAUTH_TOKEN}` }),
      }),
    );
    await scheduler.resumeTask(taskId);
    const enqueue = vi.fn().mockResolvedValue(true);
    const app = new Hono().route(
      "/api/webhooks",
      automationWebhookRoutes({ db, encryptionKey: KEY, scheduler: { enqueueWebhookDelivery: enqueue } }),
    );
    const body = JSON.stringify({
      event: "taskStatusUpdated",
      webhook_id: "hook-1",
      task_id: "task-abc",
      history_items: [{ id: "history-1" }],
    });
    const headers = {
      "Content-Type": "application/json",
      "X-Signature": createHmac("sha256", SIGNING_SECRET).update(body).digest("hex"),
    };
    const first = await app.request(`/api/webhooks/v1/${endpointId}`, { method: "POST", body, headers });
    expect(first.status).toBe(202);
    const receipt = await first.json();
    expect(receipt.duplicate).toBe(false);
    expect(enqueue).toHaveBeenCalledWith(receipt.deliveryId);
    const definition = await getAutomationDefinition({ db, taskId });
    expect(definition?.steps.find((step) => step.type === "trigger")?.triggerConfig).toMatchObject({
      webhookBinding: { accountId: "canvas-account-1", resourceId: "hook-1" },
      webhookLastDelivery: { deliveryId: receipt.deliveryId, eventId: receipt.eventId, status: "pending" },
    });
    expect(JSON.stringify(definition)).not.toContain(SIGNING_SECRET);
    expect(JSON.stringify(definition)).not.toContain(saved.signing_secret_encrypted);
    const duplicate = await app.request(`/api/webhooks/v1/${endpointId}`, { method: "POST", body, headers });
    expect((await duplicate.json()).duplicate).toBe(true);
    expect(await db.selectFrom("webhook_deliveries").selectAll().execute()).toHaveLength(1);
    await expect(executeClickUpApi(request(), deps)).rejects.toThrow(/paused/);
  });

  it.each([
    ["missing endpoint", { webhookEndpointId: undefined }],
    ["missing account", { accountId: undefined }],
    ["callback substitution", { body: { endpoint: "https://elsewhere.example.test", events: ["taskUpdated"] } }],
  ])("rejects %s before minting or requesting a token", async (_label, patch) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(executeClickUpApi({ ...request(), ...patch }, deps)).rejects.toThrow();
    expect(deps.getCanvasAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await storedEndpoint()).source_binding).toBeNull();
  });

  it.each(["other owner", "plan only", "no encryption", "unavailable", "localhost", "stale lease"])(
    "fails closed for %s",
    async (reason) => {
      const changed = { ...deps };
      const context = deps.taskContext;
      if (!context) throw new Error("Test authoring context missing");
      if (reason === "other owner") {
        changed.currentUserId = "other";
        changed.taskContext = { ...context, createdBy: "other" };
      }
      if (reason === "plan only") changed.taskContext = { ...context, planOnly: true };
      if (reason === "no encryption") changed.settingsEncryptionKey = undefined;
      if (reason === "unavailable") changed.availableManagedIntegrations = new Set();
      if (reason === "localhost") changed.toolConfig = { BASE_URL: "http://localhost:5001", PORT: 5001 };
      if (reason === "stale lease")
        changed.taskContext = { ...context, authoringLease: { sessionId: "expired", generation: 99 } };
      await expect(executeClickUpApi(request(), changed)).rejects.toThrow();
      expect(deps.getCanvasAccessToken).not.toHaveBeenCalled();
      expect((await storedEndpoint()).source_binding).toBeNull();
    },
  );

  it("retains an uncertain create and only reconciles with a unique inventory match", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("connection lost"));
    await expect(executeClickUpApi(request(), deps)).rejects.toThrow("connection lost");
    await expect(scheduler.resumeTask(taskId)).rejects.toThrow(/reconcile/);
    await expect(
      updateAutomationDefinition({
        db,
        taskId,
        actor: { userId: "owner", source: "internal" },
        patch: { status: "active" },
        brokerCapable: false,
      }),
    ).rejects.toMatchObject({ issues: [{ code: "WEBHOOK_NOT_READY" }] });
    await expect(executeClickUpApi(request(), deps)).rejects.toThrow(/do not repeat POST/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ webhooks: [] })));
    await expect(executeClickUpApi(request("GET"), deps)).rejects.toThrow(/No unique matching/);
    expect((await storedEndpoint()).source_binding).not.toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ webhooks: [remote()] })));
    const restored = await executeClickUpApi(request("GET"), deps);
    expect(restored).toMatchObject({ webhookBinding: { resourceId: "hook-1", status: "active_signed" } });
    expect(JSON.stringify(restored)).not.toContain(SIGNING_SECRET);
    await expect(assertWebhookEndpointReady(db, taskId, KEY)).resolves.toBeUndefined();
  });

  it.each(["missing secret", "ambiguous", "wrong workspace"])("does not activate for a %s response", async (reason) => {
    const candidate = remote(
      reason === "missing secret" ? { secret: undefined } : reason === "wrong workspace" ? { team_id: "999" } : {},
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ webhook: candidate })));
    if (reason === "ambiguous") {
      await register();
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ webhooks: [remote(), remote({ id: "hook-2" })] })),
      );
    }
    const result = await handleClickUpApi(request(reason === "ambiguous" ? "GET" : "POST"), deps);
    expect(JSON.stringify(result)).not.toContain(SIGNING_SECRET);
    expect((await storedEndpoint()).status).toBe("pending");
    if (reason === "missing secret") {
      expect(JSON.parse((await storedEndpoint()).source_binding ?? "{}").resourceId).toBe("hook-1");
    }
    await expect(scheduler.resumeTask(taskId)).rejects.toThrow(/reconcile/);
  });

  it.each([
    ["missing secret", { secret: undefined }],
    ["oversized secret", { secret: "x".repeat(4097) }],
    ["malformed events", { events: { unexpected: true } }],
    ["wildcard events", { events: ["*"] }],
    ["malformed location", { list_id: { unexpected: true } }],
  ])("retains the cleanup ID when unknown-create recovery has %s", async (_reason, invalid) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("unknown create"));
    await expect(executeClickUpApi(request(), deps)).rejects.toThrow("unknown create");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ webhooks: [remote(invalid)] })));
    const result = await handleClickUpApi(request("GET"), deps);
    expect(JSON.stringify(result)).not.toContain(SIGNING_SECRET);
    expect(result.content[0].text).toContain("ClickUp API failed");
    const saved = await storedEndpoint();
    expect(saved.status).toBe("pending");
    expect(JSON.parse(saved.source_binding ?? "{}")).toMatchObject({
      resourceId: "hook-1",
      accountId: "canvas-account-1",
      subscription: { events: ["taskStatusUpdated"], scope: { field: "list_id", id: "456" } },
    });
    await expect(scheduler.resumeTask(taskId)).rejects.toThrow(/reconcile/);
    await expect(executeClickUpApi(request(), deps)).rejects.toThrow(/do not repeat POST/);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(executeClickUpApi(request("DELETE"), deps)).resolves.toMatchObject({ deleted: true });
    expect((await storedEndpoint()).source_binding).toBeNull();
  });

  it("keeps prior ciphertext and cleanup identity when reconciliation omits the secret", async () => {
    await register();
    const before = await storedEndpoint();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ webhooks: [remote({ secret: undefined })] })),
    );
    await expect(executeClickUpApi(request("GET"), deps)).rejects.toThrow(/no usable signing secret/);
    expect(await storedEndpoint()).toMatchObject({
      status: "pending",
      source_binding: before.source_binding,
      signing_secret_encrypted: before.signing_secret_encrypted,
    });
  });

  it("retains cleanup identity across failures, permits only the pinned delete, and never downgrades to unsigned", async () => {
    await register();
    const removeTaskRuntime = vi.fn().mockResolvedValue(true);
    await expect(
      deleteAutomation({ db, taskId, actor: { userId: "owner" }, scheduler: { removeTaskRuntime } }),
    ).resolves.toEqual({ kind: "webhook_cleanup_required" });
    const current = await getAutomationDefinition({ db, taskId });
    if (!current) throw new Error("Test automation missing");
    await expect(
      updateAutomationDefinition({
        db,
        taskId,
        actor: { userId: "owner", source: "internal" },
        patch: {
          steps: current.steps.map((step) =>
            step.type === "trigger"
              ? {
                  ...step,
                  triggerConfig: {
                    type: "schedule",
                    scheduleType: "interval",
                    scheduleValue: "60",
                    timezone: current.timezone,
                  },
                }
              : step,
          ),
          scheduleType: "interval",
          scheduleValue: "60",
        },
        brokerCapable: false,
      }),
    ).rejects.toMatchObject({ issues: [{ code: "WEBHOOK_CLEANUP_REQUIRED" }] });
    await expect(executeClickUpApi({ ...request("DELETE"), accountId: "other-account" }, deps)).rejects.toThrow(
      /original OAuth account/,
    );
    await expect(executeClickUpApi({ ...request("DELETE"), path: "/webhook/another-hook" }, deps)).rejects.toThrow(
      /exact remote webhook ID/,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("failure", { status: 500 }));
    await expect(executeClickUpApi(request("DELETE"), deps)).rejects.toThrow("HTTP 500");
    expect((await storedEndpoint()).source_binding).not.toBeNull();
    expect(decrypt((await storedEndpoint()).signing_secret_encrypted ?? "", KEY)).toBe(SIGNING_SECRET);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(executeClickUpApi(request("DELETE"), deps)).resolves.toMatchObject({ deleted: true });
    expect(await storedEndpoint()).toMatchObject({
      status: "revoked",
      signing_secret_encrypted: null,
      source_binding: null,
    });
    await createWebhookEndpointRepository(db).ensureForTask(taskId);
    expect((await storedEndpoint()).status).toBe("pending");
    await expect(scheduler.resumeTask(taskId)).rejects.toThrow(/reconcile/);
    await expect(
      deleteAutomation({ db, taskId, actor: { userId: "owner" }, scheduler: { removeTaskRuntime } }),
    ).resolves.toEqual({ kind: "deleted" });
    expect(removeTaskRuntime).toHaveBeenCalledOnce();
  });

  it("only treats a ClickUp DELETE 404 as proof of absence, not a Canvas mint 404", async () => {
    await register();
    const getCanvasAccessToken = vi.fn().mockRejectedValue(Object.assign(new Error("mint failed"), { status: 404 }));
    await expect(executeClickUpApi(request("DELETE"), { ...deps, getCanvasAccessToken })).rejects.toThrow(
      "mint failed",
    );
    expect((await storedEndpoint()).source_binding).not.toBeNull();
    expect((await storedEndpoint()).status).toBe("active_signed");
    expect(decrypt((await storedEndpoint()).signing_secret_encrypted ?? "", KEY)).toBe(SIGNING_SECRET);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(executeClickUpApi(request("DELETE"), deps)).resolves.toMatchObject({ deleted: true });
    expect((await storedEndpoint()).source_binding).toBeNull();
  });

  it("captures PUT secrets but refuses callback changes", async () => {
    await register();
    await expect(executeClickUpApi({ ...request("PUT"), body: { events: ["taskUpdated"] } }, deps)).rejects.toThrow(
      /endpoint must match/,
    );
    await expect(
      executeClickUpApi({ ...request("PUT"), body: { endpoint: "https://other.example.test" } }, deps),
    ).rejects.toThrow(/callback changes/);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ webhook: remote({ secret: "rotated-secret" }) })),
    );
    const result = await executeClickUpApi(request("PUT"), deps);
    expect(JSON.stringify(result)).not.toContain("rotated-secret");
    expect(decrypt((await storedEndpoint()).signing_secret_encrypted ?? "", KEY)).toBe("rotated-secret");
  });

  it.each(["GET", "PUT", "DELETE"] as const)(
    "retains ciphertext after an uncertain %s and requires reconciliation",
    async (method) => {
      await register();
      const before = await storedEndpoint();
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("connection lost"));
      await expect(executeClickUpApi(request(method), deps)).rejects.toThrow("connection lost");
      expect(await storedEndpoint()).toMatchObject({
        status: "pending",
        signing_secret_encrypted: before.signing_secret_encrypted,
      });
      await expect(scheduler.resumeTask(taskId)).rejects.toThrow(/reconcile/);
    },
  );

  it("restores the usable binding after a definite rejected update", async () => {
    await register();
    const before = await storedEndpoint();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    await expect(
      executeClickUpApi({ ...request("PUT"), body: { endpoint: callbackUrl, events: ["taskCreated"] } }, deps),
    ).rejects.toThrow("HTTP 400");
    expect(await storedEndpoint()).toMatchObject({
      status: "active_signed",
      source_binding: before.source_binding,
      signing_secret_encrypted: before.signing_secret_encrypted,
    });
    await expect(scheduler.resumeTask(taskId)).resolves.toBeUndefined();
  });

  it.each([{ events: ["taskCreated"] }, { list_id: "999" }])(
    "does not activate an uncertain create with different subscription %j",
    async (differentSubscription) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("unknown create"));
      await expect(executeClickUpApi(request(), deps)).rejects.toThrow("unknown create");
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ webhooks: [remote(differentSubscription)] })));
      await expect(executeClickUpApi(request("GET"), deps)).rejects.toThrow(/differ from the requested subscription/);
      const saved = await storedEndpoint();
      expect(saved.status).toBe("pending");
      expect(JSON.parse(saved.source_binding ?? "{}")).toMatchObject({
        resourceId: "hook-1",
        subscription: { events: ["taskStatusUpdated"], scope: { field: "list_id", id: "456" } },
      });
      await expect(scheduler.resumeTask(taskId)).rejects.toThrow(/reconcile/);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(executeClickUpApi(request("DELETE"), deps)).resolves.toMatchObject({ deleted: true });
    },
  );

  it.each([{ verification_json: "{}" }, { signing_secret_encrypted: "enc:garbage" }])(
    "refuses activation when stored verification cannot run: %j",
    async (corruption) => {
      await register();
      await db.updateTable("webhook_endpoints").set(corruption).where("id", "=", endpointId).execute();
      await expect(scheduler.resumeTask(taskId)).rejects.toThrow(/reconcile/);
      await expect(
        updateAutomationDefinition({
          db,
          taskId,
          actor: { userId: "owner", source: "internal" },
          patch: { status: "active" },
          brokerCapable: false,
          encryptionKey: KEY,
        }),
      ).rejects.toMatchObject({ issues: [{ code: "WEBHOOK_NOT_READY" }] });
      expect((await createScheduledTaskRepository(db).getById(taskId))?.status).toBe("paused");
    },
  );

  it("fences a late provider response after the endpoint generation changes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      await createWebhookEndpointRepository(db).deactivateForTask(taskId);
      return success();
    });
    const result = await handleClickUpApi(request(), deps);
    expect(JSON.stringify(result)).toContain("webhook changed");
    expect(JSON.stringify(result)).not.toContain(SIGNING_SECRET);
    expect((await storedEndpoint()).source_binding).not.toBeNull();
    expect((await storedEndpoint()).signing_secret_encrypted).toBeNull();
    await expect(scheduler.resumeTask(taskId)).rejects.toThrow(/reconcile/);
  });

  it("reconciles duplicate provider configuration errors without reopening POST", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ECODE: "OAUTH_171" }), { status: 400 }));
    await expect(executeClickUpApi(request(), deps)).rejects.toThrow("OAUTH_171");
    expect((await storedEndpoint()).source_binding).not.toBeNull();
    await expect(executeClickUpApi(request(), deps)).rejects.toThrow(/do not repeat POST/);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ webhooks: [remote()] })));
    await expect(executeClickUpApi(request("GET"), deps)).resolves.toMatchObject({
      webhookBinding: { status: "active_signed" },
    });
  });

  it("permits a corrected create only after a definite provider rejection", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("invalid request", { status: 400 }));
    await expect(executeClickUpApi(request(), deps)).rejects.toThrow("HTTP 400");
    expect((await storedEndpoint()).source_binding).toBeNull();
    expect((await storedEndpoint()).status).toBe("revoked");
    fetchMock.mockResolvedValueOnce(success());
    await expect(executeClickUpApi(request(), deps)).resolves.toMatchObject({
      webhookBinding: { status: "active_signed" },
    });
  });
});
