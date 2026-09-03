import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeClickUpApi } from "../../agent/tools/clickup-api";
import { UploadCollector } from "../../agent/tools/types";
import { automationWebhookRoutes } from "../../api/webhooks";
import { createTestDb, createTestPgDb } from "../../test-utils";
import { createScheduledTaskRepository } from "../repositories/scheduled-tasks";
import { createWebhookEndpointRepository } from "../repositories/webhook-endpoints";
import type { DB } from "../schema";
import * as migration from "./222-webhook-verification";

describe.each([
  ["SQLite", createTestDb],
  ["Postgres", createTestPgDb],
] as const)("signed webhook storage on %s", (_name, createDb) => {
  let db: Kysely<DB>;
  beforeEach(async () => {
    db = await createDb();
    await db.insertInto("users").values({ id: "owner", name: "Owner" }).execute();
    await createScheduledTaskRepository(db).add({
      id: "task",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D1",
      thread_ts: null,
      prompt: "Summarize status changes",
      schedule_type: "external",
      schedule_value: "webhook",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: "owner",
      status: "paused",
      next_run_at: null,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("preserves unsigned endpoints across an empty reversible upgrade", async () => {
    const repo = createWebhookEndpointRepository(db);
    const endpoint = await repo.ensureForTask("task");
    expect(endpoint).toMatchObject({
      status: "active",
      verification_json: null,
      signing_secret_encrypted: null,
      source_binding: null,
    });
    await migration.down(db as unknown as Kysely<unknown>);
    await migration.up(db as unknown as Kysely<unknown>);
    expect(await repo.getById(endpoint.id)).toMatchObject({
      id: endpoint.id,
      status: "active",
      verification_json: null,
    });
  });

  it("blocks downgrade for pending and revoked signed metadata", async () => {
    const endpoint = await createWebhookEndpointRepository(db).ensureForTask("task");
    await db
      .updateTable("webhook_endpoints")
      .set({ verification_json: "{}", status: "pending" })
      .where("id", "=", endpoint.id)
      .execute();
    await expect(migration.down(db as unknown as Kysely<unknown>)).rejects.toThrow("before downgrading");
    await db.updateTable("webhook_endpoints").set({ status: "revoked" }).where("id", "=", endpoint.id).execute();
    await expect(migration.down(db as unknown as Kysely<unknown>)).rejects.toThrow("before downgrading");
    await createWebhookEndpointRepository(db).deleteByTaskId("task");
    await expect(migration.down(db as unknown as Kysely<unknown>)).resolves.toBeUndefined();
  });

  it("captures a minted API response and durably deduplicates signed deliveries without a provider table", async () => {
    const key = "2".repeat(64);
    const secret = "provider-test-signing-secret";
    const repo = createWebhookEndpointRepository(db);
    const endpoint = await repo.ensureForTask("task");
    const callback = `https://sketch.example.test/api/webhooks/v1/${endpoint.id}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          webhook: { id: "hook", team_id: "123", endpoint: callback, secret, events: ["taskStatusUpdated"] },
        }),
      ),
    );
    const result = await executeClickUpApi(
      {
        method: "POST",
        path: "/team/123/webhook",
        accountId: "opaque-account",
        webhookEndpointId: endpoint.id,
        body: { endpoint: callback, events: ["taskStatusUpdated"] },
      },
      {
        db,
        uploadCollector: new UploadCollector(),
        workspaceDir: "/tmp/sketch-webhook-storage-test",
        currentUserId: "owner",
        currentUserEmail: "owner@example.test",
        availableManagedIntegrations: new Set(["clickup"]),
        settingsEncryptionKey: key,
        toolConfig: { BASE_URL: "https://sketch.example.test", PORT: 3000 },
        taskContext: { platform: "slack", contextType: "dm", deliveryTarget: "D1", createdBy: "owner" },
        getCanvasAccessToken: async () => ({ accessToken: "minted-for-test" }),
      },
    );
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await repo.getById(endpoint.id)).toMatchObject({
      status: "active_signed",
      signing_secret_encrypted: expect.stringMatching(/^enc:/),
    });
    await expect(repo.deleteByTaskId("task")).rejects.toThrow("remote webhook");
    const enqueue = vi.fn().mockResolvedValue(true);
    const app = new Hono().route(
      "/api/webhooks",
      automationWebhookRoutes({ db, encryptionKey: key, scheduler: { enqueueWebhookDelivery: enqueue } }),
    );
    const body = JSON.stringify({ event: "taskStatusUpdated", webhook_id: "hook", history_items: [{ id: "h1" }] });
    const send = () =>
      app.request(`/api/webhooks/v1/${endpoint.id}`, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Signature": createHmac("sha256", secret).update(body).digest("hex"),
        },
      });
    expect((await send()).status).toBe(202);
    await createScheduledTaskRepository(db).updateStatus("task", "active", { incrementRevision: true });
    const replay = await send();
    expect((await replay.json()).duplicate).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    const deliveries = await db.selectFrom("webhook_deliveries").selectAll().execute();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("cancelled");
    expect(deliveries[0].trigger_data).not.toContain(secret);
  });
});
