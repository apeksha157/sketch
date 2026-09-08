import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { type TimelineCursor, createEntityTimelineRepository } from "./entity-timeline";

describe("entity timeline repository", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedTimeline(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("pages a grouped file timeline by timestamp and file id without repeats", async () => {
    const repo = createEntityTimelineRepository(db);
    let cursor: TimelineCursor | undefined;
    const seen: string[] = [];

    for (let i = 0; i < 3; i += 1) {
      const page = await repo.listTimelinePage({ entityIds: ["entity-a", "entity-b"], limit: 2, cursor });
      seen.push(...page.items.map((item) => item.fileId));
      cursor = page.nextCursor ?? undefined;
    }

    expect(new Set(seen)).toEqual(new Set(["file-1", "file-2", "file-3", "file-4", "file-shared"]));
    expect(seen).toHaveLength(new Set(seen).size);

    const shared = await repo.listTimelinePage({ entityIds: ["entity-a", "entity-b"], limit: 10 });
    expect(shared.items.find((item) => item.fileId === "file-shared")?.viaEntityIds).toEqual(["entity-a", "entity-b"]);

    const profiles = await repo.listTimelinePage({
      entityIds: ["entity-a"],
      limit: 10,
      fileTypes: ["linkedin_profile"],
    });
    expect(profiles.items.map((item) => item.fileId)).toEqual(["file-profile"]);
  });
});

async function seedTimeline(db: Kysely<DB>) {
  const now = "2026-09-07T10:00:00.000Z";
  await db
    .insertInto("users")
    .values({ id: "owner", name: "Owner", email: "owner@example.com", created_at: now })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg",
      connector_type: "linkedin_aimfox",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "owner",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      {
        id: "file-1",
        connector_config_id: "cfg",
        provider_file_id: "provider-1",
        file_name: "File 1",
        file_type: "linkedin_conversation",
        content_category: "document",
        source: "linkedin_aimfox",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-2",
        connector_config_id: "cfg",
        provider_file_id: "provider-2",
        file_name: "File 2",
        file_type: "linkedin_conversation",
        content_category: "document",
        source: "linkedin_aimfox",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-3",
        connector_config_id: "cfg",
        provider_file_id: "provider-3",
        file_name: "File 3",
        file_type: "linkedin_conversation",
        content_category: "document",
        source: "linkedin_aimfox",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-4",
        connector_config_id: "cfg",
        provider_file_id: "provider-4",
        file_name: "File 4",
        file_type: "linkedin_conversation",
        content_category: "document",
        source: "linkedin_aimfox",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-shared",
        connector_config_id: "cfg",
        provider_file_id: "provider-shared",
        file_name: "Shared file",
        file_type: "linkedin_conversation",
        content_category: "document",
        source: "linkedin_aimfox",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-profile",
        connector_config_id: "cfg",
        provider_file_id: "provider-profile",
        file_name: "Profile file",
        file_type: "linkedin_profile",
        content_category: "document",
        source: "linkedin_aimfox",
        source_updated_at: now,
        synced_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("entities")
    .values([
      {
        id: "entity-a",
        name: "Entity A",
        source_type: "company",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: "entity-b",
        name: "Entity B",
        source_type: "person",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("entity_mentions")
    .values([
      {
        id: "mention-1",
        entity_id: "entity-a",
        indexed_file_id: "file-1",
        confidence: "INFERRED",
        source: "test",
        relation: "mentioned",
        mentioned_at: now,
      },
      {
        id: "mention-2",
        entity_id: "entity-a",
        indexed_file_id: "file-2",
        confidence: "INFERRED",
        source: "test",
        relation: "mentioned",
        mentioned_at: now,
      },
      {
        id: "mention-3",
        entity_id: "entity-a",
        indexed_file_id: "file-3",
        confidence: "INFERRED",
        source: "test",
        relation: "mentioned",
        mentioned_at: now,
      },
      {
        id: "mention-4",
        entity_id: "entity-a",
        indexed_file_id: "file-4",
        confidence: "INFERRED",
        source: "test",
        relation: "mentioned",
        mentioned_at: now,
      },
      {
        id: "mention-shared-a",
        entity_id: "entity-a",
        indexed_file_id: "file-shared",
        confidence: "EXTRACTED",
        source: "test",
        relation: "mentioned",
        mentioned_at: now,
      },
      {
        id: "mention-shared-b",
        entity_id: "entity-b",
        indexed_file_id: "file-shared",
        confidence: "INFERRED",
        source: "test",
        relation: "mentioned",
        mentioned_at: now,
      },
      {
        id: "mention-profile",
        entity_id: "entity-a",
        indexed_file_id: "file-profile",
        confidence: "EXTRACTED",
        source: "test",
        relation: "mentioned",
        mentioned_at: now,
      },
    ])
    .execute();
}
