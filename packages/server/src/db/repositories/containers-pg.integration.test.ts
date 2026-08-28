/**
 * Postgres coverage for the containers upsert. The re-observation path runs
 * ON CONFLICT DO UPDATE with a COALESCE on classified_entity_id; Postgres
 * rejects an unqualified column there as ambiguous against the excluded row
 * (SQLite resolves it silently), which broke every re-sync on live tenants.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createContainerRepository } from "./containers";

const USER_ID = "pg-container-user";
const CONNECTOR_ID = "pg-container-connector";
const NOW = "2026-08-28T00:00:00.000Z";

async function seedEntityWithRef(db: Kysely<DB>, entityId: string, sourceId: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id: entityId,
      name: entityId,
      source_type: "team",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      project_lifecycle_status: null,
      hotness: 0,
      created_at: NOW,
      updated_at: NOW,
      ai_brief: null,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
  await db
    .insertInto("entity_source_refs")
    .values({ id: randomUUID(), entity_id: entityId, source: "clickup", source_id: sourceId, last_seen_at: NOW })
    .execute();
}

describe("containers repository on shared Postgres", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
    await db.insertInto("users").values({ id: USER_ID, name: USER_ID }).execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: CONNECTOR_ID,
        connector_type: "clickup",
        auth_type: "api_key",
        credentials: "{}",
        scope_config: "{}",
        created_by: USER_ID,
      })
      .execute();
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("re-observes an entity-linked container without ambiguity and keeps the first link", async () => {
    const containers = createContainerRepository(db);
    await seedEntityWithRef(db, "entity-first", "list-linked");
    const observation = {
      connectorConfigId: CONNECTOR_ID,
      connectorType: "clickup" as const,
      externalId: "list-linked",
      levelKey: "list",
      name: "Linked List",
      pathIds: ["space-1", "list-linked"],
      pathNames: ["Space", "Linked List"],
    };

    const first = await containers.observeContainer(observation);
    expect(first.classified_entity_id).toBe("entity-first");

    await db.deleteFrom("entity_source_refs").where("source_id", "=", "list-linked").execute();
    await seedEntityWithRef(db, "entity-second", "list-linked");

    const second = await containers.observeContainer({ ...observation, name: "Linked List Renamed" });
    expect(second.classified_entity_id).toBe("entity-first");
    expect(second.name).toBe("Linked List Renamed");
  });
});
