import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clickUpContainerObservation } from "../../connectors/clickup";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createContainerRepository } from "./containers";

const USER_ID = "containers-user";

async function seedUser(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Containers User",
      email: "containers@example.com",
      password_hash: "hash",
      email_verified_at: "2026-08-22T00:00:00.000Z",
      auth_role: "admin",
    })
    .execute();
}

async function seedConnector(db: Kysely<DB>, id: string, connectorType: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: connectorType,
      auth_type: "api_key",
      credentials: "{}",
      created_by: USER_ID,
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, id: string, sourceType: string, sourceRefId?: string | null): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name: id,
      source_type: sourceType,
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: sourceRefId ?? null,
      status: "confirmed",
      hotness: 0,
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    })
    .execute();
}

async function seedGraphVerdict(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("graph_verdict_runs")
    .values({
      id: `${id}-run`,
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
      id,
      run_id: `${id}-run`,
      action: "test",
      subject_entity_id: "classified-entity",
      subject_name: null,
      subject_entity_type: null,
      target_entity_id: null,
      resolved_target_entity_id: null,
      reason: "test",
      evidence_json: "{}",
      evidence_fingerprint: "fingerprint-1",
      validation_status: "valid",
      validation_reason: null,
      would_change_json: null,
      status: "approved",
      superseded_at: null,
      decided_at: null,
      decided_by_user_id: null,
      applied_ledger_ref: null,
    })
    .execute();
}

describe("createContainerRepository", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("upserts observations while preserving discovery and classification fields", async () => {
    await seedConnector(db, "clickup-1", "clickup");
    await seedEntity(db, "classified-entity", "project");
    await seedGraphVerdict(db, "verdict-1");
    const repo = createContainerRepository(db);

    const first = await repo.observeContainer({
      connectorConfigId: "clickup-1",
      connectorType: "clickup",
      externalId: "list-1",
      levelKey: "list",
      name: "Launch",
      pathIds: ["workspace-1", "space-1"],
      pathNames: ["Workspace", "Space"],
      itemCount: 1,
      firstItemAt: "2026-08-20T00:00:00.000Z",
      lastItemAt: "2026-08-20T01:00:00.000Z",
      observedAt: "2026-08-22T01:00:00.000Z",
    });

    await db
      .updateTable("containers")
      .set({
        classification: "project",
        classification_status: "active",
        classified_entity_id: "classified-entity",
        verdict_id: "verdict-1",
        last_reviewed_fingerprint: "fingerprint-1",
      })
      .where("id", "=", first.id)
      .execute();

    const second = await repo.observeContainer({
      connectorConfigId: "clickup-1",
      connectorType: "clickup",
      externalId: "list-1",
      levelKey: "list",
      name: "Launch Renamed",
      pathIds: ["workspace-1", "space-1", "folder-1"],
      pathNames: ["Workspace", "Space", "Folder"],
      itemCount: 3,
      firstItemAt: "2026-08-19T00:00:00.000Z",
      lastItemAt: "2026-08-21T00:00:00.000Z",
      providerArchived: true,
      providerTypedKind: "typed",
      hasDates: true,
      observedAt: "2026-08-22T02:00:00.000Z",
    });

    expect(second.id).toBe(first.id);
    expect(second.discovered_at).toBe("2026-08-22T01:00:00.000Z");
    expect(second.last_seen_at).toBe("2026-08-22T02:00:00.000Z");
    expect(second.name).toBe("Launch Renamed");
    expect(JSON.parse(second.path_ids)).toEqual(["workspace-1", "space-1", "folder-1"]);
    expect(second.item_count).toBe(3);
    expect(second.first_item_at).toBe("2026-08-19T00:00:00.000Z");
    expect(second.last_item_at).toBe("2026-08-21T00:00:00.000Z");
    expect(second.provider_archived).toBe(1);
    expect(second.provider_typed_kind).toBe("typed");
    expect(second.has_dates).toBe(1);
    expect(second.classification).toBe("project");
    expect(second.classification_status).toBe("active");
    expect(second.classified_entity_id).toBe("classified-entity");
    expect(second.verdict_id).toBe("verdict-1");
    expect(second.last_reviewed_fingerprint).toBe("fingerprint-1");

    const statless = await repo.observeContainer({
      connectorConfigId: "clickup-1",
      connectorType: "clickup",
      externalId: "list-1",
      levelKey: "list",
      name: "Launch Renamed",
      pathIds: ["workspace-1", "space-1", "folder-1"],
      pathNames: ["Workspace", "Space", "Folder"],
      observedAt: "2026-08-22T03:00:00.000Z",
    });
    expect(statless.item_count).toBe(3);
    expect(statless.first_item_at).toBe("2026-08-19T00:00:00.000Z");
    expect(statless.last_item_at).toBe("2026-08-21T00:00:00.000Z");
    expect(statless.provider_archived).toBe(1);
    expect(statless.has_dates).toBe(1);
    expect(statless.last_seen_at).toBe("2026-08-22T03:00:00.000Z");
  });

  it("preserves ClickUp provider ids, verbatim names, and provider facts", async () => {
    await seedConnector(db, "clickup-1", "clickup");
    const repo = createContainerRepository(db);

    const workspace = clickUpContainerObservation({
      levelKey: "workspace",
      node: { id: "workspace-1", name: "Workspace / ACME " },
      ancestors: [],
    });
    const folder = clickUpContainerObservation({
      levelKey: "folder",
      node: { id: "folder-1", name: "Client / Alpha ", archived: true },
      ancestors: [{ id: "workspace-1", name: "Workspace / ACME " }],
    });
    const docFolder = clickUpContainerObservation({
      levelKey: "doc",
      node: { id: "doc-folder-1", name: "Docs / Archive ", archived: true },
      ancestors: [{ id: "workspace-1", name: "Workspace / ACME " }],
      providerTypedKind: "doc",
    });
    const list = clickUpContainerObservation({
      levelKey: "list",
      node: { id: "list-1", name: "Sprint 01 " },
      ancestors: [
        { id: "workspace-1", name: "Workspace / ACME " },
        { id: "folder-1", name: "Client / Alpha " },
      ],
      itemCount: 2,
      firstItemAt: "2026-08-20T00:00:00.000Z",
      lastItemAt: "2026-08-21T00:00:00.000Z",
      hasDates: true,
    });

    for (const observation of [workspace, folder, docFolder, list]) {
      await repo.observeContainer({ connectorConfigId: "clickup-1", connectorType: "clickup", ...observation });
    }

    const rows = await repo.listByConnector("clickup-1");
    const byExternalId = new Map(rows.map((row) => [row.external_id, row]));
    expect(byExternalId.get("workspace-1")?.name).toBe("Workspace / ACME ");
    expect(byExternalId.get("folder-1")).toMatchObject({
      external_id: "folder-1",
      level_key: "folder",
      name: "Client / Alpha ",
      provider_archived: 1,
    });
    expect(JSON.parse(byExternalId.get("folder-1")?.path_names ?? "[]")).toEqual(["Workspace / ACME "]);
    expect(byExternalId.get("doc-folder-1")).toMatchObject({
      level_key: "doc",
      provider_archived: 1,
      provider_typed_kind: "doc",
      name: "Docs / Archive ",
    });
    expect(byExternalId.get("list-1")).toMatchObject({
      external_id: "list-1",
      item_count: 2,
      has_dates: 1,
      first_item_at: "2026-08-20T00:00:00.000Z",
      last_item_at: "2026-08-21T00:00:00.000Z",
    });
    expect(JSON.parse(byExternalId.get("list-1")?.path_ids ?? "[]")).toEqual(["workspace-1", "folder-1"]);
  });

  it("links Linear containers through entity_source_refs without matching entities.source_ref_id", async () => {
    await seedConnector(db, "linear-1", "linear");
    await seedEntity(db, "team-from-ref", "team");
    await seedEntity(db, "legacy-source-ref-only", "team", "lin-team-legacy");
    await db
      .insertInto("entity_source_refs")
      .values({
        id: "team-source-ref",
        entity_id: "team-from-ref",
        source: "linear",
        source_id: "lin-team-1",
        source_url: null,
        last_seen_at: "2026-08-22T00:00:00.000Z",
      })
      .execute();

    const repo = createContainerRepository(db);
    const linked = await repo.observeContainer({
      connectorConfigId: "linear-1",
      connectorType: "linear",
      externalId: "lin-team-1",
      levelKey: "team",
      name: "Platform",
      pathIds: [],
      pathNames: [],
      providerTypedKind: "team",
    });
    const sourceRefOnly = await repo.observeContainer({
      connectorConfigId: "linear-1",
      connectorType: "linear",
      externalId: "lin-team-legacy",
      levelKey: "team",
      name: "Legacy Platform",
      pathIds: [],
      pathNames: [],
      providerTypedKind: "team",
    });
    const unlinked = await repo.observeContainer({
      connectorConfigId: "linear-1",
      connectorType: "linear",
      externalId: "lin-team-unlinked",
      levelKey: "team",
      name: "Unlinked",
      pathIds: [],
      pathNames: [],
      providerTypedKind: "team",
    });

    expect(linked.classified_entity_id).toBe("team-from-ref");
    expect(sourceRefOnly.classified_entity_id).toBeNull();
    expect(unlinked.classified_entity_id).toBeNull();
  });
});
