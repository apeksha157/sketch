import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import { createScheduledTaskRepository } from "../repositories/scheduled-tasks";
import { createWebhookDeliveryRepository } from "../repositories/webhook-deliveries";
import { createWebhookEndpointRepository } from "../repositories/webhook-endpoints";
import type { DB } from "../schema";
import { down, up } from "./233-webhook-endpoint-slots";

describe.each(["SQLite", "Postgres"])("webhook endpoint slot migration on %s", (dialect) => {
  it("preserves callbacks, ciphertext, generations and delivery foreign keys across upgrades and guarded downgrades", async () => {
    const db: Kysely<DB> = await (dialect === "SQLite" ? createTestDb() : createTestPgDb());
    try {
      await db.insertInto("users").values({ id: "owner", name: "Owner" }).execute();
      const taskId = "task";
      await createScheduledTaskRepository(db).add({
        id: taskId,
        platform: "slack",
        context_type: "dm",
        delivery_target: "D1",
        thread_ts: null,
        prompt: "Webhook",
        schedule_type: "external",
        schedule_value: "webhook",
        timezone: "UTC",
        session_mode: "fresh",
        created_by: "owner",
        status: "paused",
        next_run_at: null,
      });
      const endpoints = createWebhookEndpointRepository(db);
      const endpoint = await endpoints.ensureForTask(taskId);
      await db
        .updateTable("webhook_endpoints")
        .set({
          generation: 7,
          source_binding: "binding",
          verification_json: "verification",
          signing_secret_encrypted: "encrypted-secret",
          status: "pending",
        })
        .where("id", "=", endpoint.id)
        .execute();
      await createWebhookDeliveryRepository(db).insertOrGet({
        endpointId: endpoint.id,
        taskId,
        eventId: "event",
        payloadHash: "hash",
        triggerData: { data: { task_id: "provider-task" } },
        taskRevision: 3,
        endpointGeneration: 7,
        status: "cancelled",
      });
      const beforeEndpoint = await endpoints.getById(endpoint.id);
      const beforeDeliveries = await db.selectFrom("webhook_deliveries").selectAll().execute();
      await db.transaction().execute((trx) => down(trx as unknown as Kysely<unknown>));
      await db.transaction().execute((trx) => up(trx as unknown as Kysely<unknown>));
      expect(await endpoints.getById(endpoint.id)).toEqual(beforeEndpoint);
      expect(await db.selectFrom("webhook_deliveries").selectAll().execute()).toEqual(beforeDeliveries);
      const second = await endpoints.ensureForTask(taskId, "second-list");
      expect(second.id).not.toBe(endpoint.id);
      expect((await endpoints.ensureForTask(taskId, "second-list")).id).toBe(second.id);
      await expect(db.transaction().execute((trx) => down(trx as unknown as Kysely<unknown>))).rejects.toThrow(
        "additional endpoint slots",
      );
      expect(await endpoints.getById(endpoint.id)).toEqual(beforeEndpoint);
      await db.deleteFrom("scheduled_tasks").where("id", "=", taskId).execute();
      expect(await db.selectFrom("webhook_endpoints").selectAll().execute()).toEqual([]);
      expect(await db.selectFrom("webhook_deliveries").selectAll().execute()).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});
