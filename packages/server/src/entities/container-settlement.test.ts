import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { settleContainersFromProviderFacts } from "./container-settlement";

const USER_ID = "container-settlement-user";
const CONNECTOR_ID = "container-settlement-connector";
const NOW = "2026-08-22T00:00:00.000Z";

async function seedUser(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: USER_ID, name: "Container Settlement User" }).execute();
}

async function seedConnector(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "clickup",
      auth_type: "api_key",
      credentials: "{}",
      created_by: USER_ID,
    })
    .execute();
}

async function seedGraphVerdict(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("graph_verdict_runs")
    .values({
      id: "settlement-human-run",
      source: "test",
      proposed_by_user_id: USER_ID,
      token_id: null,
      note: null,
      verdicts_proposed: 1,
      verdicts_stored: 1,
      verdicts_bounced: 0,
    })
    .execute();
  await db
    .insertInto("graph_verdicts")
    .values({
      id: "settlement-human-verdict",
      run_id: "settlement-human-run",
      action: "classify_container",
      subject_entity_id: null,
      subject_container_id: "human-doc",
      subject_name: "Human Doc",
      subject_entity_type: "container_classification",
      target_entity_id: null,
      resolved_target_entity_id: null,
      target_name: null,
      reason: "Human decision.",
      evidence_json: "{}",
      evidence_fingerprint: "human-fingerprint",
      validation_status: "ok",
      validation_reason: null,
      would_change_json: null,
      status: "applied",
      superseded_at: null,
      decided_at: NOW,
      decided_by_user_id: USER_ID,
      applied_ledger_ref: "label:team",
    })
    .execute();
}

async function seedContainer(
  db: Kysely<DB>,
  input: {
    id: string;
    externalId: string;
    levelKey: string;
    providerTypedKind?: string | null;
    hasDates?: boolean;
    archived?: boolean;
    classification?: string | null;
    classificationStatus?: string | null;
    verdictId?: string | null;
  },
): Promise<void> {
  await db
    .insertInto("containers")
    .values({
      id: input.id,
      connector_config_id: CONNECTOR_ID,
      connector_type: "clickup",
      external_id: input.externalId,
      level_key: input.levelKey,
      name: input.id,
      path_ids: "[]",
      path_names: "[]",
      provider_archived: input.archived ? 1 : 0,
      provider_typed_kind: input.providerTypedKind ?? null,
      has_dates: input.hasDates ? 1 : 0,
      classification: input.classification ?? null,
      classification_status: input.classificationStatus ?? null,
      verdict_id: input.verdictId ?? null,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

describe("settleContainersFromProviderFacts", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db);
    await seedConnector(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("settles provider facts without overwriting human decisions", async () => {
    await seedContainer(db, {
      id: "typed-team",
      externalId: "typed-team",
      levelKey: "team",
      providerTypedKind: "team",
    });
    await seedContainer(db, { id: "dated-list", externalId: "dated-list", levelKey: "list", hasDates: true });
    await seedContainer(db, { id: "doc-folder", externalId: "doc-folder", levelKey: "doc", providerTypedKind: "doc" });
    await seedContainer(db, {
      id: "archived-folder",
      externalId: "archived-folder",
      levelKey: "folder",
      archived: true,
    });
    await seedContainer(db, { id: "plain-folder", externalId: "plain-folder", levelKey: "folder" });
    await seedContainer(db, {
      id: "human-doc",
      externalId: "human-doc",
      levelKey: "doc",
      providerTypedKind: "doc",
      classification: "team",
      classificationStatus: "active",
    });
    await seedGraphVerdict(db);
    await db
      .updateTable("containers")
      .set({ verdict_id: "settlement-human-verdict" })
      .where("id", "=", "human-doc")
      .execute();

    await settleContainersFromProviderFacts(db, CONNECTOR_ID);

    const rows = await db
      .selectFrom("containers")
      .select(["id", "classification", "classification_status", "verdict_id"])
      .orderBy("id", "asc")
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("typed-team")).toMatchObject({ classification: "team", classification_status: "active" });
    expect(byId.get("dated-list")).toMatchObject({ classification: "time_box", classification_status: "active" });
    expect(byId.get("doc-folder")).toMatchObject({ classification: "ignore", classification_status: "active" });
    expect(byId.get("archived-folder")).toMatchObject({
      classification: "ignore",
      classification_status: "historical",
    });
    expect(byId.get("plain-folder")).toMatchObject({ classification: null, classification_status: null });
    expect(byId.get("human-doc")).toMatchObject({
      classification: "team",
      classification_status: "active",
      verdict_id: "settlement-human-verdict",
    });

    await db
      .updateTable("containers")
      .set({ provider_typed_kind: "doc", updated_at: "2026-08-22T01:00:00.000Z" })
      .where("id", "=", "typed-team")
      .execute();
    await settleContainersFromProviderFacts(db, CONNECTOR_ID);

    await expect(
      db
        .selectFrom("containers")
        .select(["classification", "classification_status"])
        .where("id", "=", "typed-team")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ classification: "ignore", classification_status: "active" });
  });
});
