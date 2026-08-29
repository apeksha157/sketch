import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMembershipSuppressionRepository } from "../db/repositories/membership-suppressions";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { deriveContainerMembership, proposeContainerMaturityReopens } from "./container-membership";

const USER_ID = "container-membership-user";
const CONNECTOR_ID = "container-membership-connector";
const NOW = "2026-08-22T00:00:00.000Z";

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: USER_ID, name: "Container Membership User" }).execute();
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
}

async function seedEntity(db: Kysely<DB>, input: { id: string; name: string; sourceType: string }): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: input.sourceType,
      subtype: input.sourceType === "person" ? "internal" : null,
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
}

async function seedPerson(db: Kysely<DB>, id: string, email: string): Promise<void> {
  await seedEntity(db, { id, name: id, sourceType: "person" });
  await db
    .insertInto("entity_contact_points")
    .values({
      id: `contact-${id}`,
      entity_id: id,
      kind: "email",
      value: email,
      display_value: null,
      label: null,
      is_primary: 1,
      source: "test",
      connector_config_id: CONNECTOR_ID,
      created_by_user_id: USER_ID,
      verified_at: null,
      last_contacted_at: null,
    })
    .execute();
}

async function seedTeamContainer(
  db: Kysely<DB>,
  input: {
    id: string;
    externalId: string;
    teamEntityId: string;
    itemCount?: number;
    firstItemAt?: string | null;
  },
): Promise<void> {
  await seedEntity(db, { id: input.teamEntityId, name: input.teamEntityId, sourceType: "team" });
  await db
    .insertInto("containers")
    .values({
      id: input.id,
      connector_config_id: CONNECTOR_ID,
      connector_type: "clickup",
      external_id: input.externalId,
      level_key: "folder",
      name: input.id,
      path_ids: JSON.stringify([]),
      path_names: JSON.stringify(["Workspace", "Space"]),
      parent_container_id: null,
      item_count: input.itemCount ?? 0,
      first_item_at: input.firstItemAt ?? null,
      last_item_at: null,
      provider_archived: 0,
      provider_typed_kind: null,
      has_dates: 0,
      classification: "team",
      classification_status: "active",
      classified_entity_id: input.teamEntityId,
      verdict_id: null,
      last_reviewed_fingerprint: null,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

async function seedFile(
  db: Kysely<DB>,
  input: { id: string; containerExternalId: string; month: string; sourceMeta?: Record<string, unknown> | null },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: input.id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: input.id,
      provider_message_id: null,
      thread_id: null,
      provider_url: null,
      file_name: input.id,
      file_type: "task",
      content_category: "structured",
      content: null,
      summary: null,
      source: "clickup",
      source_path: null,
      source_meta: JSON.stringify(input.sourceMeta ?? { containerId: input.containerExternalId }),
      rollup_group_id: null,
      content_hash: `hash-${input.id}`,
      is_archived: 0,
      source_created_at: `${input.month}-10T00:00:00.000Z`,
      source_updated_at: null,
      is_all_day: 0,
      synced_at: `${input.month}-10T00:00:00.000Z`,
      context_note: null,
      access_scope_id: null,
      mime_type: null,
      share_with_everyone: 0,
    })
    .execute();
}

async function seedAttribution(
  db: Kysely<DB>,
  input: { fileId: string; email: string; kind?: "assignee" | "author" },
): Promise<void> {
  const kind = input.kind ?? "assignee";
  await db
    .insertInto("indexed_file_facts")
    .values({
      id: `fact-${input.fileId}-${kind}-${input.email}`,
      indexed_file_id: input.fileId,
      connector_config_id: CONNECTOR_ID,
      created_by_user_id: USER_ID,
      source: "clickup",
      fact_type: kind,
      relation: kind === "assignee" ? "assigned" : "authored",
      subject_name: input.email,
      subject_email: input.email,
      subject_source: "clickup",
      subject_source_id: input.email,
      context_snippet: null,
      raw: "{}",
      fact_key: `key-${input.fileId}-${kind}-${input.email}`,
      last_seen_sync_run_id: null,
      deleted_at: null,
      content_hash: null,
      materialization_input_hash: null,
      normalized_subject_name: null,
      normalized_mention_name: null,
      raw_mention_type: null,
      mention_type: null,
      feature_corroboration_key: null,
      normalization_projected_at: null,
      materialized_at: null,
    })
    .execute();
}

async function seedAssignedFile(db: Kysely<DB>, id: string, containerExternalId: string, month: string, email: string) {
  await seedFile(db, { id, containerExternalId, month });
  await seedAttribution(db, { fileId: id, email });
}

async function relationships(db: Kysely<DB>) {
  return db
    .selectFrom("entity_relationships")
    .selectAll()
    .where("relationship_type", "=", "member_of")
    .orderBy("source_entity_id", "asc")
    .orderBy("valid_from", "asc")
    .execute();
}

async function evidence(db: Kysely<DB>) {
  return db.selectFrom("entity_relationship_evidence").selectAll().orderBy("relationship_id", "asc").execute();
}

describe("deriveContainerMembership", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("collapses roster touchers into home members with entry windows and refreshed lead evidence", async () => {
    await seedTeamContainer(db, { id: "team-container", externalId: "team-ext", teamEntityId: "team-entity" });
    for (const [id, email] of [
      ["alice", "alice@example.com"],
      ["bob", "bob@example.com"],
      ["charlie", "charlie@example.com"],
      ["dave", "dave@example.com"],
      ["eve", "eve@example.com"],
      ["bot", "bot@example.com"],
    ]) {
      await seedPerson(db, id, email);
    }
    await createMembershipSuppressionRepository(db).suppress({
      connectorConfigId: CONNECTOR_ID,
      email: "bot@example.com",
    });

    await seedAssignedFile(db, "team-a1", "team-ext", "2026-01", "alice@example.com");
    await seedAssignedFile(db, "team-a2", "team-ext", "2026-01", "alice@example.com");
    await seedAssignedFile(db, "other-a1", "other-ext", "2026-01", "alice@example.com");
    await seedAssignedFile(db, "team-b1", "team-ext", "2026-01", "bob@example.com");
    await seedAssignedFile(db, "team-b2", "team-ext", "2026-01", "bob@example.com");
    await seedAssignedFile(db, "other-b1", "other-ext", "2026-01", "bob@example.com");
    await seedAssignedFile(db, "other-b2", "other-ext", "2026-01", "bob@example.com");
    await seedAssignedFile(db, "team-c1", "team-ext", "2026-01", "charlie@example.com");
    await seedAssignedFile(db, "other-c1", "other-ext", "2026-01", "charlie@example.com");
    await seedAssignedFile(db, "other-c2", "other-ext", "2026-01", "charlie@example.com");
    await seedAssignedFile(db, "other-c3", "other-ext", "2026-01", "charlie@example.com");
    await seedAssignedFile(db, "team-d1", "team-ext", "2026-01", "dave@example.com");
    await seedAssignedFile(db, "team-e1", "team-ext", "2026-01", "eve@example.com");
    await seedAssignedFile(db, "team-e2", "team-ext", "2026-01", "eve@example.com");
    await seedAssignedFile(db, "team-bot1", "team-ext", "2026-01", "bot@example.com");
    await seedAssignedFile(db, "team-bot2", "team-ext", "2026-01", "bot@example.com");
    await seedAttribution(db, { fileId: "team-a1", email: "alice@example.com", kind: "author" });

    await deriveContainerMembership({ db, logger: createTestLogger() }, CONNECTOR_ID);

    const initial = await relationships(db);
    expect(initial).toHaveLength(3);
    expect(initial.map((row) => row.source_entity_id).sort()).toEqual(["alice", "bob", "eve"]);
    expect(initial).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_entity_id: "alice",
          target_entity_id: "team-entity",
          relationship_type: "member_of",
          source: "derived_membership",
          confidence: "EXTRACTED",
          confidence_score: 2 / 3,
          valid_from: "2026-01-01T00:00:00.000Z",
          valid_to: null,
        }),
        expect.objectContaining({
          source_entity_id: "bob",
          target_entity_id: "team-entity",
          confidence_score: 0.5,
        }),
      ]),
    );
    const initialEvidence = await evidence(db);
    expect(initialEvidence).toHaveLength(3);
    expect(initialEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence_key: "membership:team-ext",
          source_fact_id: null,
        }),
      ]),
    );
    expect(initialEvidence.map((row) => JSON.parse(row.note ?? "{}"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ itemCount: 2, share: 2 / 3, authoredShare: 0.5 })]),
    );

    await createMembershipSuppressionRepository(db).suppress({
      connectorConfigId: CONNECTOR_ID,
      email: "eve@example.com",
    });
    await deriveContainerMembership({ db, logger: createTestLogger() }, CONNECTOR_ID);

    const rerun = await relationships(db);
    const eve = rerun.find((row) => row.source_entity_id === "eve");
    expect(eve?.valid_to).not.toBeNull();
    expect(
      rerun
        .filter((row) => row.valid_to === null)
        .map((row) => row.source_entity_id)
        .sort(),
    ).toEqual(["alice", "bob"]);
  });

  it("keeps one-month dips open, ignores non-observation months, closes sustained exits, and re-enters later", async () => {
    await seedTeamContainer(db, { id: "team-container", externalId: "team-ext", teamEntityId: "team-entity" });
    await seedPerson(db, "member", "member@example.com");
    await seedAssignedFile(db, "jan-team-1", "team-ext", "2026-01", "member@example.com");
    await seedAssignedFile(db, "jan-team-2", "team-ext", "2026-01", "member@example.com");
    await seedAssignedFile(db, "feb-other-1", "other-ext", "2026-02", "member@example.com");
    await seedAssignedFile(db, "mar-other-1", "other-ext", "2026-03", "member@example.com");
    await seedAssignedFile(db, "mar-other-2", "other-ext", "2026-03", "member@example.com");

    await deriveContainerMembership({ db, logger: createTestLogger() }, CONNECTOR_ID);
    expect(await relationships(db)).toEqual([expect.objectContaining({ valid_to: null })]);

    await seedAssignedFile(db, "apr-other-1", "other-ext", "2026-04", "member@example.com");
    await seedAssignedFile(db, "apr-other-2", "other-ext", "2026-04", "member@example.com");
    await deriveContainerMembership({ db, logger: createTestLogger() }, CONNECTOR_ID);
    expect(await relationships(db)).toEqual([
      expect.objectContaining({
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_to: "2026-04-30T23:59:59.999Z",
      }),
    ]);

    await seedAssignedFile(db, "may-team-1", "team-ext", "2026-05", "member@example.com");
    await seedAssignedFile(db, "may-team-2", "team-ext", "2026-05", "member@example.com");
    await deriveContainerMembership({ db, logger: createTestLogger() }, CONNECTOR_ID);
    expect(await relationships(db)).toEqual([
      expect.objectContaining({
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_to: "2026-04-30T23:59:59.999Z",
      }),
      expect.objectContaining({
        valid_from: "2026-05-01T00:00:00.000Z",
        valid_to: null,
      }),
    ]);
  });

  it("proposes mature zero-member team reopens once per maturity fingerprint including rejected evidence", async () => {
    await seedTeamContainer(db, {
      id: "mature-container",
      externalId: "mature-ext",
      teamEntityId: "mature-team",
      itemCount: 30,
      firstItemAt: "2026-01-01T00:00:00.000Z",
    });

    expect(await proposeContainerMaturityReopens({ db, logger: createTestLogger() }, CONNECTOR_ID)).toBe(1);
    expect(await proposeContainerMaturityReopens({ db, logger: createTestLogger() }, CONNECTOR_ID)).toBe(0);
    let verdicts = await db
      .selectFrom("graph_verdicts")
      .selectAll()
      .where("action", "=", "classify_container")
      .execute();
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      status: "awaiting_human",
      subject_container_id: "mature-container",
      evidence_fingerprint: expect.any(String),
    });
    expect(JSON.parse(verdicts[0].evidence_json).maturity).toEqual(
      expect.objectContaining({ rule: "dead_team", memberCount: 0, maturityFingerprint: expect.any(String) }),
    );

    await db
      .updateTable("graph_verdicts")
      .set({ status: "rejected", decided_at: NOW, decided_by_user_id: USER_ID })
      .where("id", "=", verdicts[0].id)
      .execute();
    expect(await proposeContainerMaturityReopens({ db, logger: createTestLogger() }, CONNECTOR_ID)).toBe(0);

    await seedPerson(db, "late-member", "late@example.com");
    await seedAssignedFile(db, "late-team-1", "mature-ext", "2026-05", "late@example.com");
    await seedAssignedFile(db, "late-team-2", "mature-ext", "2026-05", "late@example.com");
    await deriveContainerMembership({ db, logger: createTestLogger() }, CONNECTOR_ID);
    expect(await proposeContainerMaturityReopens({ db, logger: createTestLogger() }, CONNECTOR_ID)).toBe(0);
    await seedAssignedFile(db, "late-other-1", "other-ext", "2026-06", "late@example.com");
    await seedAssignedFile(db, "late-other-2", "other-ext", "2026-06", "late@example.com");
    await seedAssignedFile(db, "late-other-3", "other-ext", "2026-07", "late@example.com");
    await seedAssignedFile(db, "late-other-4", "other-ext", "2026-07", "late@example.com");
    await deriveContainerMembership({ db, logger: createTestLogger() }, CONNECTOR_ID);

    expect(await proposeContainerMaturityReopens({ db, logger: createTestLogger() }, CONNECTOR_ID)).toBe(1);
    expect(await proposeContainerMaturityReopens({ db, logger: createTestLogger() }, CONNECTOR_ID)).toBe(0);
    verdicts = await db
      .selectFrom("graph_verdicts")
      .selectAll()
      .where("action", "=", "classify_container")
      .orderBy("created_at", "asc")
      .execute();
    expect(verdicts).toHaveLength(2);
    expect(verdicts.map((row) => row.status).sort()).toEqual(["awaiting_human", "rejected"]);
    expect(JSON.parse(verdicts[0].evidence_json).maturity.maturityFingerprint).not.toBe(
      JSON.parse(verdicts[1].evidence_json).maturity.maturityFingerprint,
    );
  });
});
