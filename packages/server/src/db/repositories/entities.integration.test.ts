import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityRepository } from "./entities";

describe("createEntityRepository deleteEntitiesForFiles postgres", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
    await db
      .insertInto("connector_configs")
      .values({
        id: "pg-config-test",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: JSON.stringify({ type: "api_key", apiKey: "x" }),
        created_by: "user-1",
        scope_config: JSON.stringify({}),
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "pg-file-1",
        connector_config_id: "pg-config-test",
        provider_file_id: "provider-pg-file-1",
        file_name: "pg-file-1.md",
        file_type: "meeting_transcript",
        content_category: "document",
        source: "fireflies",
        source_path: null,
        provider_url: null,
        content: null,
        summary: null,
        context_note: null,
        access_scope_id: null,
        content_hash: null,
        source_updated_at: null,
        source_created_at: null,
        synced_at: new Date().toISOString(),
        embedding_status: "pending",
      })
      .execute();
  }, 30000);

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("deletes relation endpoint entities whose only support is deleted file evidence", async () => {
    const repo = createEntityRepository(db);
    const source = await repo.upsertPersonEntity({
      name: "PG Source Person",
      subtype: "external",
      source: "llm_relation",
      sourceId: "pg-relation:source",
    });
    const target = await repo.upsertPersonEntity({
      name: "PG Target Person",
      subtype: "external",
      source: "llm_relation",
      sourceId: "pg-relation:target",
    });
    await db
      .insertInto("entity_relationships")
      .values({
        id: "pg-rel-1",
        source_entity_id: source.id,
        target_entity_id: target.id,
        relationship_type: "knows",
        confidence: "INFERRED",
        confidence_score: 0.8,
        source: "llm_relation",
      })
      .execute();
    await db
      .insertInto("entity_relationship_evidence")
      .values({
        id: "pg-rel-ev-1",
        relationship_id: "pg-rel-1",
        indexed_file_id: "pg-file-1",
        note: null,
        source_fact_id: null,
      })
      .execute();

    await expect(repo.deleteEntitiesForFiles(["pg-file-1"])).resolves.toBe(2);
    await expect(repo.getEntity(target.id)).resolves.toBeUndefined();
  });

  it("finds batched people by metadata email fallback in postgres", async () => {
    const repo = createEntityRepository(db);
    const metadataOnly = await repo.upsertPersonEntity({
      name: "PG Metadata Person",
      email: "pg-metadata@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "pg-seed:metadata",
    });

    const matches = await repo.getPersonEntitiesByEmails(["PG-METADATA@example.com"]);

    expect(matches.get("pg-metadata@example.com")).toMatchObject([{ id: metadataOnly.id }]);
  });

  it("searches names and aliases case-insensitively in postgres", async () => {
    const repo = createEntityRepository(db);
    const entity = await repo.upsertEntity({
      name: "Oxane Partners",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
      aliases: ["OxanePartners"],
    });

    const nameMatches = await repo.searchEntities("oxane");
    expect(nameMatches.map((match) => match.id)).toContain(entity.id);

    const aliasMatches = await repo.searchEntities("oXaNeP");
    expect(aliasMatches.map((match) => match.id)).toContain(entity.id);
  });

  it("recomputes entity touch stats from distinct files and LinkedIn manifests", async () => {
    const repo = createEntityRepository(db);
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    const entity = await repo.upsertEntity({
      name: "Touch Stats Entity",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });
    const archived = await repo.upsertEntity({
      name: "Archived Touch Stats Entity",
      sourceType: "company",
      subtype: "external",
      status: "archived",
    });
    const dormant = await repo.upsertEntity({
      name: "Dormant Touch Stats Entity",
      sourceType: "company",
      subtype: "external",
      status: "confirmed",
    });

    await db
      .insertInto("indexed_files")
      .values([
        touchFile("touch-file-10", "linkedin_conversation", "linkedin", daysAgo(10), {
          linkedinAimfox: {
            segmentManifest: {
              lastInboundAt: "2026-05-27T20:00:00.000Z",
              lastOutboundAt: "2026-05-27T19:55:00.000Z",
            },
          },
        }),
        touchFile("touch-file-60", "meeting_transcript", "fireflies", daysAgo(60), null),
        touchFile("touch-file-200", "meeting_transcript", "fireflies", daysAgo(200), null),
        touchFile("touch-file-archived", "meeting_transcript", "fireflies", daysAgo(10), null),
        touchFile("touch-file-dormant", "meeting_transcript", "fireflies", daysAgo(1500), null),
      ])
      .execute();
    await db
      .insertInto("entity_mentions")
      .values([
        touchMention("touch-mention-10", entity.id, "touch-file-10", daysAgo(10), "mentioned"),
        touchMention("touch-mention-10-related", entity.id, "touch-file-10", daysAgo(10), "corresponded"),
        touchMention("touch-mention-60", entity.id, "touch-file-60", daysAgo(60), "mentioned"),
        touchMention("touch-mention-200", entity.id, "touch-file-200", daysAgo(200), "mentioned"),
        touchMention("touch-mention-archived", archived.id, "touch-file-archived", daysAgo(10), "mentioned"),
        touchMention("touch-mention-dormant", dormant.id, "touch-file-dormant", daysAgo(1500), "mentioned"),
      ])
      .execute();

    await repo.recomputeAllHotness();

    await expect(
      db.selectFrom("entity_touch_stats").selectAll().where("entity_id", "=", entity.id).executeTakeFirst(),
    ).resolves.toMatchObject({
      touch_count_30d: 1,
      touch_count_90d: 2,
      last_inbound_at: "2026-05-27T20:00:00.000Z",
    });
    await expect(
      db.selectFrom("entity_touch_stats").selectAll().where("entity_id", "=", archived.id).executeTakeFirst(),
    ).resolves.toBeUndefined();
    await expect(
      db.selectFrom("entities").select("hotness").where("id", "=", dormant.id).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ hotness: 0 });
    await expect(
      db.selectFrom("entity_touch_stats").selectAll().where("entity_id", "=", dormant.id).executeTakeFirst(),
    ).resolves.toMatchObject({ touch_count_30d: 0, touch_count_90d: 0 });
  });
});

function touchFile(id: string, fileType: string, source: string, sourceUpdatedAt: string, sourceMeta: unknown) {
  return {
    id,
    connector_config_id: "pg-config-test",
    provider_file_id: `provider-${id}`,
    file_name: `${id}.md`,
    file_type: fileType,
    content_category: "document",
    source,
    source_path: null,
    provider_url: null,
    content: null,
    summary: null,
    context_note: null,
    access_scope_id: null,
    content_hash: null,
    source_meta: sourceMeta ? JSON.stringify(sourceMeta) : null,
    source_updated_at: sourceUpdatedAt,
    source_created_at: null,
    synced_at: new Date().toISOString(),
    embedding_status: "pending",
  };
}

function touchMention(id: string, entityId: string, indexedFileId: string, mentionedAt: string, relation: string) {
  return {
    id,
    entity_id: entityId,
    indexed_file_id: indexedFileId,
    chunk_index: null,
    context_snippet: null,
    confidence: "EXTRACTED",
    source: "test",
    relation,
    mentioned_at: mentionedAt,
  };
}
