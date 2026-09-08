import { randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql } from "kysely";
import type { DB, WebhookEndpointsTable } from "../schema";

export const WEBHOOK_ENDPOINT_STATUS_ACTIVE = "active" as const;
export const WEBHOOK_ENDPOINT_STATUS_SIGNED = "active_signed" as const;
export const WEBHOOK_ENDPOINT_STATUS_PENDING = "pending" as const;
export const WEBHOOK_ENDPOINT_STATUS_REVOKED = "revoked" as const;

export type WebhookEndpointStatus =
  | typeof WEBHOOK_ENDPOINT_STATUS_ACTIVE
  | typeof WEBHOOK_ENDPOINT_STATUS_SIGNED
  | typeof WEBHOOK_ENDPOINT_STATUS_PENDING
  | typeof WEBHOOK_ENDPOINT_STATUS_REVOKED;

export function isWebhookEndpointActive(status: string): boolean {
  return status === WEBHOOK_ENDPOINT_STATUS_ACTIVE || status === WEBHOOK_ENDPOINT_STATUS_SIGNED;
}
export type WebhookEndpointRow = Selectable<WebhookEndpointsTable>;

export interface WebhookEndpointRepositoryOptions {
  readonly now?: () => string;
  readonly idGenerator?: () => string;
}

export interface WebhookEndpointProvisionResult extends WebhookEndpointRow {
  readonly endpoint: WebhookEndpointRow;
  readonly created: boolean;
}

function parseOptions(
  legacyEncryptionKeyOrOptions?: string | WebhookEndpointRepositoryOptions,
  options?: Omit<WebhookEndpointRepositoryOptions, never>,
): WebhookEndpointRepositoryOptions {
  if (typeof legacyEncryptionKeyOrOptions === "string" || legacyEncryptionKeyOrOptions === undefined) {
    return options ?? {};
  }
  return legacyEncryptionKeyOrOptions;
}

function provisionResult(endpoint: WebhookEndpointRow, created: boolean): WebhookEndpointProvisionResult {
  return { ...endpoint, endpoint, created };
}

export function createWebhookEndpointsRepository(
  db: Kysely<DB>,
  legacyEncryptionKeyOrOptions?: string | WebhookEndpointRepositoryOptions,
  options?: Omit<WebhookEndpointRepositoryOptions, never>,
) {
  const repositoryOptions = parseOptions(legacyEncryptionKeyOrOptions, options);
  const now = repositoryOptions.now ?? (() => new Date().toISOString());
  const idGenerator = repositoryOptions.idGenerator ?? randomUUID;

  async function getById(id: string): Promise<WebhookEndpointRow | undefined> {
    return db.selectFrom("webhook_endpoints").selectAll().where("id", "=", id).executeTakeFirst();
  }

  async function getByTaskId(taskId: string, slot = "default"): Promise<WebhookEndpointRow | undefined> {
    return db
      .selectFrom("webhook_endpoints")
      .selectAll()
      .where("task_id", "=", taskId)
      .where("slot", "=", slot)
      .executeTakeFirst();
  }

  async function activate(endpoint: WebhookEndpointRow): Promise<WebhookEndpointRow> {
    if (isWebhookEndpointActive(endpoint.status) || endpoint.status === WEBHOOK_ENDPOINT_STATUS_PENDING)
      return endpoint;
    await db
      .updateTable("webhook_endpoints")
      .set({
        status:
          endpoint.verification_json || endpoint.slot !== "default"
            ? WEBHOOK_ENDPOINT_STATUS_PENDING
            : WEBHOOK_ENDPOINT_STATUS_ACTIVE,
        generation: sql<number>`generation + 1`,
        updated_at: now(),
      })
      .where("id", "=", endpoint.id)
      .execute();
    const refreshed = await getById(endpoint.id);
    if (!refreshed) throw new Error(`Webhook endpoint ${endpoint.id} disappeared while activating`);
    return refreshed;
  }

  return {
    async ensureForTask(taskId: string, slot = "default"): Promise<WebhookEndpointProvisionResult> {
      const existing = await getByTaskId(taskId, slot);
      if (existing) return provisionResult(await activate(existing), false);

      const timestamp = now();
      const result = await db
        .insertInto("webhook_endpoints")
        .values({
          id: idGenerator(),
          task_id: taskId,
          slot,
          status: slot === "default" ? WEBHOOK_ENDPOINT_STATUS_ACTIVE : WEBHOOK_ENDPOINT_STATUS_PENDING,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .onConflict((oc) => oc.columns(["task_id", "slot"]).doNothing())
        .executeTakeFirst();
      const created = Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
      const row = await getByTaskId(taskId, slot);
      if (!row) throw new Error(`Webhook endpoint could not be ensured for task ${taskId}`);
      return provisionResult(await activate(row), created);
    },

    async deactivateForTask(taskId: string): Promise<WebhookEndpointRow | undefined> {
      await db
        .updateTable("webhook_endpoints")
        .set({
          status: WEBHOOK_ENDPOINT_STATUS_REVOKED,
          generation: sql<number>`generation + 1`,
          updated_at: now(),
        })
        .where("task_id", "=", taskId)
        .execute();
      return getByTaskId(taskId);
    },

    async listByTaskId(taskId: string): Promise<WebhookEndpointRow[]> {
      return db.selectFrom("webhook_endpoints").selectAll().where("task_id", "=", taskId).orderBy("slot").execute();
    },

    async getById(id: string): Promise<WebhookEndpointRow | undefined> {
      return getById(id);
    },

    async getByTaskId(taskId: string): Promise<WebhookEndpointRow | undefined> {
      return getByTaskId(taskId);
    },

    async deleteByTaskId(taskId: string): Promise<void> {
      await db.transaction().execute(async (trx) => {
        const endpoint = await trx
          .selectFrom("webhook_endpoints")
          .select("source_binding")
          .where("task_id", "=", taskId)
          .where("source_binding", "is not", null)
          .executeTakeFirst();
        if (endpoint?.source_binding != null) {
          throw new Error("Delete the remote webhook through its provider API before deleting this endpoint.");
        }
        await trx.deleteFrom("webhook_deliveries").where("task_id", "=", taskId).execute();
        await trx.deleteFrom("webhook_endpoints").where("task_id", "=", taskId).execute();
      });
    },
  };
}

export const createWebhookEndpointRepository = createWebhookEndpointsRepository;
