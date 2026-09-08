import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSearch, handleSearchEntities } from "../agent/tools/search";
import { UploadCollector } from "../agent/tools/types";
import { EMBEDDING_DIMENSIONS } from "../db";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestPgDb, spyOnExecutedSql } from "../test-utils";
import { hybridSearch, search } from "./search";
import { filterAccessibleFileIds } from "./sync-utils";

const FILE_COUNT = 70_000;
const ENTITY_ID = "entity-scale-overflow";
const USER_ID = "user-scale-overflow";
const USER_EMAIL = "scale-reader@example.com";

describe("search entity scale", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await createTestPgDb();
  }, 30_000);

  afterAll(async () => {
    await db.destroy();
  });

  it("handles 70,000 entity-scoped file IDs across search and visibility paths", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("users")
      .values({ id: USER_ID, name: "Scale Reader", email: USER_EMAIL, auth_role: "member" })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: "connector-scale-overflow",
        connector_type: "zoho_crm",
        auth_type: "oauth",
        credentials: "{}",
        created_by: USER_ID,
      })
      .execute();
    await db
      .insertInto("entities")
      .values({
        id: ENTITY_ID,
        name: "Overflow Scale Company",
        source_type: "company",
        status: "confirmed",
        hotness: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await sql`
        INSERT INTO indexed_files (
          id,
          connector_config_id,
          provider_file_id,
          file_name,
          file_type,
          content_category,
          source,
          source_updated_at,
          synced_at
        )
        SELECT
          'scale-file-' || value::text,
          'connector-scale-overflow',
          'scale-provider-' || value::text,
          'overflow scale needle file ' || value::text,
          'crm_contact',
          'structured',
          'zoho_crm',
          ${now},
          ${now}
        FROM generate_series(1, ${FILE_COUNT}) AS value
      `.execute(db);
    await sql`
        INSERT INTO entity_mentions (
          id,
          entity_id,
          indexed_file_id,
          chunk_index,
          context_snippet,
          confidence,
          source,
          relation,
          mentioned_at
        )
        SELECT
          'scale-mention-' || value::text,
          ${ENTITY_ID},
          'scale-file-' || value::text,
          NULL,
          'scale mention',
          'EXTRACTED',
          'test',
          'mentioned',
          ${now}
        FROM generate_series(1, ${FILE_COUNT}) AS value
      `.execute(db);

    const entityResult = await handleSearchEntities(
      { queries: ["Overflow Scale"] },
      {
        uploadCollector: new UploadCollector(),
        workspaceDir: "/tmp",
        db,
        currentUserId: USER_ID,
        userRepo: createUserRepository(db),
        slackEntitySyncEnabled: false,
        adminReadAllEnabled: false,
        publicMcp: { userPrincipals: [USER_EMAIL], filterEntityMetadata: true },
      },
    );
    expect(entityResult.content[0]?.text).toContain(ENTITY_ID);

    const toolSearchResult = await handleSearch(
      { query: "Overflow Scale", limit: 5 },
      {
        uploadCollector: new UploadCollector(),
        workspaceDir: "/tmp",
        db,
        currentUserId: USER_ID,
        userRepo: createUserRepository(db),
        slackEntitySyncEnabled: false,
        adminReadAllEnabled: false,
        publicMcp: { userPrincipals: [USER_EMAIL], filterEntityMetadata: true },
      },
    );
    expect(toolSearchResult.content[0]?.text).toContain("scale-file-");

    const autoBoosted = await search(db, "Overflow Scale", { limit: 5 });
    expect(autoBoosted).toHaveLength(5);

    const recent = await search(db, "", { entityIds: [ENTITY_ID], sortBy: "recency", limit: 3 });
    expect(recent).toHaveLength(3);

    const keyword = await search(db, "needle", { entityIds: [ENTITY_ID], limit: 5 });
    expect(keyword).toHaveLength(5);

    const fileIds = Array.from({ length: FILE_COUNT }, (_, index) => `scale-file-${index + 1}`);
    const queryEmbedding = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    queryEmbedding[0] = 1;
    await expect(hybridSearch(db, "needle", { fileIds, queryEmbedding, limit: 5 })).resolves.toBeDefined();

    const repeatedFileIds = [...fileIds, ...fileIds];
    const executed = spyOnExecutedSql(db);
    const visible = await filterAccessibleFileIds(db, repeatedFileIds, [USER_EMAIL], false);
    expect(visible.size).toBe(FILE_COUNT);
    expect(executed.count).toBe(1);

    await db
      .insertInto("entities")
      .values([
        {
          id: "entity-scope-a",
          name: "Scope Contract A",
          source_type: "company",
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
        {
          id: "entity-scope-b",
          name: "Scope Contract B",
          source_type: "company",
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto("indexed_files")
      .values(
        ["scope-only-a", "scope-only-b", "scope-both", "scope-neither"].map((id) => ({
          id,
          connector_config_id: "connector-scale-overflow",
          provider_file_id: id,
          file_name: `joincontract ${id}`,
          file_type: "crm_contact",
          content_category: "structured",
          source: "zoho_crm",
          source_updated_at: now,
          synced_at: now,
        })),
      )
      .execute();
    await db
      .insertInto("entity_mentions")
      .values([
        mention("scope-mention-a", "entity-scope-a", "scope-only-a", now),
        mention("scope-mention-b", "entity-scope-b", "scope-only-b", now),
        mention("scope-mention-both-a", "entity-scope-a", "scope-both", now),
        mention("scope-mention-both-a-authored", "entity-scope-a", "scope-both", now, "authored"),
        mention("scope-mention-both-b", "entity-scope-b", "scope-both", now),
      ])
      .execute();

    const andResults = await search(db, "joincontract", {
      entityIds: ["entity-scope-a", "entity-scope-b"],
      entityIdsMode: "and",
      limit: 10,
    });
    const orResults = await search(db, "joincontract", {
      entityIds: ["entity-scope-a", "entity-scope-b"],
      entityIdsMode: "or",
      limit: 10,
    });
    expect(andResults.map((result) => result.id)).toEqual(["scope-both"]);
    expect(orResults.map((result) => result.id).sort()).toEqual(["scope-both", "scope-only-a", "scope-only-b"]);
    expect(new Set(orResults.map((result) => result.id)).size).toBe(orResults.length);

    await db
      .insertInto("entities")
      .values([
        {
          id: "visibility-visible",
          name: "Visibility Contract Visible",
          source_type: "company",
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
        {
          id: "visibility-hidden",
          name: "Visibility Contract Hidden",
          source_type: "company",
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
        {
          id: "visibility-mixed",
          name: "Visibility Contract Mixed",
          source_type: "company",
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto("indexed_files")
      .values(
        ["visibility-allowed-file", "visibility-blocked-file"].map((id) => ({
          id,
          connector_config_id: "connector-scale-overflow",
          provider_file_id: id,
          file_name: id,
          file_type: "crm_contact",
          content_category: "structured",
          source: "zoho_crm",
          source_updated_at: now,
          synced_at: now,
        })),
      )
      .execute();
    await db
      .insertInto("file_access")
      .values([
        {
          indexed_file_id: "visibility-allowed-file",
          principal_type: "email",
          principal_value: USER_EMAIL,
        },
        {
          indexed_file_id: "visibility-blocked-file",
          principal_type: "email",
          principal_value: "someone-else@example.com",
        },
      ])
      .execute();
    await db
      .insertInto("entity_mentions")
      .values([
        mention("visibility-mention-visible", "visibility-visible", "visibility-allowed-file", now),
        mention("visibility-mention-hidden", "visibility-hidden", "visibility-blocked-file", now),
        mention("visibility-mention-mixed-visible", "visibility-mixed", "visibility-allowed-file", now),
        mention("visibility-mention-mixed-hidden", "visibility-mixed", "visibility-blocked-file", now),
      ])
      .execute();

    const expectedVisible = await sql<{ entity_id: string }>`
      SELECT DISTINCT em.entity_id
      FROM entity_mentions em
      INNER JOIN entities e ON e.id = em.entity_id
      INNER JOIN indexed_files f ON f.id = em.indexed_file_id
      WHERE lower(e.name) LIKE ${"%visibility contract%"}
        AND f.is_archived = 0
        AND EXISTS (
          SELECT 1
          FROM file_access fa
          WHERE fa.indexed_file_id = f.id
            AND fa.principal_type = 'email'
            AND fa.principal_value = ${USER_EMAIL}
        )
      ORDER BY em.entity_id
    `.execute(db);
    const restrictedResult = await handleSearchEntities(
      { queries: ["Visibility Contract"] },
      {
        uploadCollector: new UploadCollector(),
        workspaceDir: "/tmp",
        db,
        currentUserId: USER_ID,
        userRepo: createUserRepository(db),
        slackEntitySyncEnabled: false,
        adminReadAllEnabled: false,
        publicMcp: { userPrincipals: [USER_EMAIL], filterEntityMetadata: true },
      },
    );
    const actualVisible = (JSON.parse(restrictedResult.content[0]?.text ?? "[]") as Array<{ id: string }>)
      .map((entity) => entity.id)
      .sort();
    expect(actualVisible).toEqual(expectedVisible.rows.map((row) => row.entity_id));
  }, 120_000);
});

function mention(
  id: string,
  entityId: string,
  indexedFileId: string,
  mentionedAt: string,
  relation: "mentioned" | "authored" = "mentioned",
) {
  return {
    id,
    entity_id: entityId,
    indexed_file_id: indexedFileId,
    chunk_index: null,
    context_snippet: "scale mention",
    confidence: "EXTRACTED" as const,
    source: "test",
    relation,
    mentioned_at: mentionedAt,
  };
}
