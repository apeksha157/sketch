import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSearchEntities } from "../agent/tools/search";
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
          'overflow needle file ' || value::text,
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
  }, 120_000);
});
