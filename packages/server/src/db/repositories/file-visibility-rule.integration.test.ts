import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AccessPrincipal } from "../../connectors/types";
import { getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { fileVisibilityRuleSql, visibleFileIdsSql } from "./file-visibility-rule";

describe("visibleFileIdsSql on Postgres", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
    await seedVisibilityFixture(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("matches the predicate form for the primary principal across every visibility door", async () => {
    await expectVisibleSets([emailPrincipal("viewer@example.com")], true, [
      "f-entity-email",
      "f-entity-org",
      "f-manual-share",
      "f-org-wide",
      "f-overlap",
      "f-per-file-viewer",
      "f-scope-member",
      "f-unrestricted",
    ]);
  });

  it("matches the predicate form for a second principal", async () => {
    await expectVisibleSets([emailPrincipal("other@example.com")], true, [
      "f-entity-org",
      "f-org-wide",
      "f-overlap",
      "f-per-file-other",
      "f-unrestricted",
    ]);
  });

  it("matches the predicate form for principals without email grants", async () => {
    await expectVisibleSets([{ type: "phone", value: "+15551234567" }], true, [
      "f-entity-org",
      "f-org-wide",
      "f-overlap",
      "f-unrestricted",
    ]);
  });

  it("keeps the Slack source exclusion equivalent in both forms", async () => {
    await expectVisibleSets([emailPrincipal("viewer@example.com")], false, [
      "f-entity-email",
      "f-entity-org",
      "f-manual-share",
      "f-org-wide",
      "f-overlap",
      "f-per-file-viewer",
      "f-scope-member",
      "f-slack-source",
      "f-unrestricted",
    ]);
  });

  it("dedupes branch-local repeats while preserving explicit cross-door overlap", async () => {
    const input = {
      principals: [emailPrincipal("viewer@example.com")],
      slackEntitySyncEnabled: true,
      archived: "include" as const,
    };
    const predicateRows = await sql<{ id: string }>`
      SELECT indexed_files.id
      FROM indexed_files
      WHERE ${fileVisibilityRuleSql(input)}
    `.execute(db);
    const setRows = await visibleFileIdsSql(input, 100).execute(db);

    const rawSetIds = setRows.rows.map((row) => row.id);
    const setIds = [...new Set(rawSetIds)].sort();
    const predicateIds = [...new Set(predicateRows.rows.map((row) => row.id))].sort();
    const rawCounts = rawSetIds.reduce(
      (counts, id) => counts.set(id, (counts.get(id) ?? 0) + 1),
      new Map<string, number>(),
    );

    expect(predicateIds).toEqual([
      "f-archived",
      "f-entity-email",
      "f-entity-org",
      "f-manual-share",
      "f-org-wide",
      "f-overlap",
      "f-per-file-viewer",
      "f-scope-member",
      "f-unrestricted",
    ]);
    expect(setIds).toEqual(predicateIds);
    expect(rawSetIds.length).toBeGreaterThanOrEqual(setIds.length);
    expect(rawCounts.get("f-overlap")).toBe(3);
    expect(rawSetIds.length).toBe(setIds.length + 2);
    expect(setIds).not.toContain("f-entity-merged");
  });

  it("returns only public doors in the predicate and set forms when no principals survive normalisation", async () => {
    await expectVisibleSets([], true, ["f-archived", "f-entity-org", "f-org-wide", "f-overlap", "f-unrestricted"], {
      archived: "include",
    });
  });

  async function expectVisibleSets(
    principals: AccessPrincipal[],
    slackEntitySyncEnabled: boolean,
    expected: string[],
    overrides: Partial<Pick<Parameters<typeof fileVisibilityRuleSql>[0], "archived">> = {},
  ): Promise<void> {
    const input = { principals, slackEntitySyncEnabled, archived: overrides.archived ?? ("exclude" as const) };
    const predicateRows = await sql<{ id: string }>`
      SELECT indexed_files.id
      FROM indexed_files
      WHERE ${fileVisibilityRuleSql(input)}
    `.execute(db);
    const setRows = await visibleFileIdsSql(input, 100).execute(db);

    expect([...new Set(predicateRows.rows.map((row) => row.id))].sort()).toEqual(expected);
    expect([...new Set(setRows.rows.map((row) => row.id))].sort()).toEqual(expected);
  }
});

function emailPrincipal(value: string): AccessPrincipal {
  return { type: "email", value };
}

async function seedVisibilityFixture(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db.insertInto("users").values({ id: "visibility-granter", name: "Visibility Granter", email: null }).execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "visibility-cfg",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "visibility-granter",
    })
    .execute();
  await db
    .insertInto("access_scopes")
    .values([
      {
        id: "visibility-scope-member",
        connector_config_id: "visibility-cfg",
        scope_type: "drive",
        provider_scope_id: "member-drive",
      },
      {
        id: "visibility-scope-other",
        connector_config_id: "visibility-cfg",
        scope_type: "drive",
        provider_scope_id: "other-drive",
      },
    ])
    .execute();
  await db
    .insertInto("access_scope_members")
    .values({
      access_scope_id: "visibility-scope-member",
      principal_type: "email",
      principal_value: "viewer@example.com",
    })
    .execute();

  const baseFile = {
    connector_config_id: "visibility-cfg",
    file_type: "text",
    content_category: "document",
    source: "google_drive",
    synced_at: now,
    source_updated_at: now,
  };
  await db
    .insertInto("indexed_files")
    .values([
      {
        ...baseFile,
        id: "f-unrestricted",
        provider_file_id: "f-unrestricted",
        file_name: "f-unrestricted",
        access_scope_id: null,
      },
      {
        ...baseFile,
        id: "f-scope-member",
        provider_file_id: "f-scope-member",
        file_name: "f-scope-member",
        access_scope_id: "visibility-scope-member",
      },
      {
        ...baseFile,
        id: "f-scope-other",
        provider_file_id: "f-scope-other",
        file_name: "f-scope-other",
        access_scope_id: "visibility-scope-other",
      },
      {
        ...baseFile,
        id: "f-per-file-viewer",
        provider_file_id: "f-per-file-viewer",
        file_name: "f-per-file-viewer",
        access_scope_id: null,
      },
      {
        ...baseFile,
        id: "f-per-file-other",
        provider_file_id: "f-per-file-other",
        file_name: "f-per-file-other",
        access_scope_id: null,
      },
      {
        ...baseFile,
        id: "f-manual-share",
        provider_file_id: "f-manual-share",
        file_name: "f-manual-share",
        access_scope_id: "visibility-scope-other",
      },
      {
        ...baseFile,
        id: "f-org-wide",
        provider_file_id: "f-org-wide",
        file_name: "f-org-wide",
        access_scope_id: "visibility-scope-other",
        share_with_everyone: 1,
      },
      {
        ...baseFile,
        id: "f-overlap",
        provider_file_id: "f-overlap",
        file_name: "f-overlap",
        access_scope_id: null,
        share_with_everyone: 1,
      },
      {
        ...baseFile,
        id: "f-entity-org",
        provider_file_id: "f-entity-org",
        file_name: "f-entity-org",
        access_scope_id: "visibility-scope-other",
      },
      {
        ...baseFile,
        id: "f-entity-email",
        provider_file_id: "f-entity-email",
        file_name: "f-entity-email",
        access_scope_id: "visibility-scope-other",
      },
      {
        ...baseFile,
        id: "f-entity-deleted",
        provider_file_id: "f-entity-deleted",
        file_name: "f-entity-deleted",
        access_scope_id: "visibility-scope-other",
      },
      {
        ...baseFile,
        id: "f-entity-merged",
        provider_file_id: "f-entity-merged",
        file_name: "f-entity-merged",
        access_scope_id: "visibility-scope-other",
      },
      {
        ...baseFile,
        id: "f-slack-source",
        provider_file_id: "f-slack-source",
        file_name: "f-slack-source",
        source: "slack",
        access_scope_id: null,
      },
      {
        ...baseFile,
        id: "f-archived",
        provider_file_id: "f-archived",
        file_name: "f-archived",
        access_scope_id: null,
        is_archived: 1,
      },
    ])
    .execute();
  await db
    .insertInto("file_access")
    .values([
      {
        indexed_file_id: "f-per-file-viewer",
        principal_type: "email",
        principal_value: "viewer@example.com",
      },
      {
        indexed_file_id: "f-per-file-other",
        principal_type: "email",
        principal_value: "other@example.com",
      },
      {
        indexed_file_id: "f-slack-source",
        principal_type: "email",
        principal_value: "viewer@example.com",
      },
    ])
    .execute();
  await db
    .insertInto("file_share_emails")
    .values({
      indexed_file_id: "f-manual-share",
      email: "viewer@example.com",
      granted_by_user_id: "visibility-granter",
    })
    .execute();
  await db
    .insertInto("entities")
    .values([
      entity("visibility-entity-org", "Visibility Entity Org", now, { share_with_everyone: 1 }),
      entity("visibility-entity-email", "Visibility Entity Email", now),
      entity("visibility-entity-deleted", "Visibility Entity Deleted", now, {
        share_with_everyone: 1,
        deleted_at: now,
      }),
      entity("visibility-entity-survivor", "Visibility Entity Survivor", now),
      entity("visibility-entity-merged", "Visibility Entity Merged", now, {
        share_with_everyone: 1,
        merged_into_entity_id: "visibility-entity-survivor",
      }),
    ])
    .execute();
  await db
    .insertInto("entity_share_emails")
    .values({
      entity_id: "visibility-entity-email",
      email: "viewer@example.com",
      granted_by_user_id: "visibility-granter",
    })
    .execute();
  await db
    .insertInto("entity_mentions")
    .values([
      mention("visibility-mention-org", "visibility-entity-org", "f-entity-org", now),
      mention("visibility-mention-email", "visibility-entity-email", "f-entity-email", now),
      mention("visibility-mention-deleted", "visibility-entity-deleted", "f-entity-deleted", now),
      mention("visibility-mention-overlap-mentions", "visibility-entity-org", "f-overlap", now, "mentions"),
      mention("visibility-mention-overlap-related", "visibility-entity-org", "f-overlap", now, "related"),
      mention("visibility-mention-merged", "visibility-entity-merged", "f-entity-merged", now),
    ])
    .execute();
}

function mention(id: string, entityId: string, fileId: string, now: string, relation = "mentions") {
  return {
    id,
    entity_id: entityId,
    indexed_file_id: fileId,
    chunk_index: null,
    context_snippet: null,
    confidence: "confirmed",
    source: "test",
    relation,
    mentioned_at: now,
  };
}

function entity(
  id: string,
  name: string,
  now: string,
  overrides: Partial<{
    share_with_everyone: number;
    deleted_at: string | null;
    merged_into_entity_id: string | null;
  }> = {},
) {
  return {
    id,
    name,
    source_type: "company",
    subtype: null,
    aliases: null,
    metadata: null,
    source_ref_id: null,
    status: "confirmed",
    project_lifecycle_status: null,
    hotness: 0,
    created_at: now,
    updated_at: now,
    ai_brief: null,
    deleted_at: null,
    merged_into_entity_id: null,
    ...overrides,
  };
}
