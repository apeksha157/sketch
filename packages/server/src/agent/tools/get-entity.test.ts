import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createTestDb } from "../../test-utils";
import { handleGetEntity } from "./get-entity";
import { UploadCollector } from "./types";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
  await seedEntity(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("GetEntity public handler", () => {
  it("filters timeline files and relation counterparts by visibility and fails closed with no principals", async () => {
    const result = await handleGetEntity({ entityId: "entity-client" }, deps());
    const body = JSON.parse(result.content[0]?.text ?? "{}") as {
      relations: { outgoing: Array<{ other: { id: string } }> };
      timeline: { items: Array<{ fileId: string }> };
    };

    expect(body.timeline.items.map((item) => item.fileId)).toEqual(["file-visible"]);
    expect(body.relations.outgoing.map((relation) => relation.other.id)).not.toContain("entity-hidden-counterpart");

    const closed = await handleGetEntity({ entityId: "entity-client" }, zeroEmailDeps());
    expect(closed.content[0]?.text).toBe("Entity entity-client not found.");
  });
});

function deps() {
  return {
    uploadCollector: new UploadCollector(),
    workspaceDir: "/tmp",
    db,
    userRepo: createUserRepository(db),
    publicMcp: {
      userPrincipals: ["alice@example.com"],
      filterEntityMetadata: true,
      maxFileContentChars: 50,
    },
  };
}

function zeroEmailDeps() {
  return {
    ...deps(),
    publicMcp: {
      userPrincipals: [],
      filterEntityMetadata: true,
      maxFileContentChars: 50,
    },
  };
}

async function seedEntity(db: Kysely<DB>) {
  const now = "2026-09-07T10:00:00.000Z";
  await db
    .insertInto("users")
    .values({ id: "owner", name: "Owner", email: "owner@example.com", created_at: now })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "owner",
    })
    .execute();
  await db
    .insertInto("access_scopes")
    .values([
      {
        id: "scope-visible",
        connector_config_id: "cfg",
        scope_type: "drive",
        provider_scope_id: "drive-visible",
      },
      {
        id: "scope-hidden",
        connector_config_id: "cfg",
        scope_type: "drive",
        provider_scope_id: "drive-hidden",
      },
    ])
    .execute();
  await db
    .insertInto("access_scope_members")
    .values({ access_scope_id: "scope-visible", principal_type: "email", principal_value: "alice@example.com" })
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      {
        id: "file-visible",
        connector_config_id: "cfg",
        provider_file_id: "provider-visible",
        file_name: "Visible client file",
        file_type: "doc",
        content_category: "document",
        source: "google_drive",
        content: "visible client notes",
        access_scope_id: "scope-visible",
        source_updated_at: "2026-09-07T12:00:00.000Z",
        synced_at: now,
      },
      {
        id: "file-hidden",
        connector_config_id: "cfg",
        provider_file_id: "provider-hidden",
        file_name: "Hidden client file",
        file_type: "doc",
        content_category: "document",
        source: "google_drive",
        content: "hidden client notes",
        access_scope_id: "scope-hidden",
        source_updated_at: "2026-09-07T13:00:00.000Z",
        synced_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("entities")
    .values([
      {
        id: "entity-client",
        name: "Client",
        source_type: "company",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: "entity-hidden-counterpart",
        name: "Hidden Counterpart",
        source_type: "company",
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
        id: "mention-client-visible",
        entity_id: "entity-client",
        indexed_file_id: "file-visible",
        confidence: "EXTRACTED",
        source: "test",
        relation: "mentioned",
        mentioned_at: now,
      },
      {
        id: "mention-client-hidden",
        entity_id: "entity-client",
        indexed_file_id: "file-hidden",
        confidence: "EXTRACTED",
        source: "test",
        relation: "mentioned",
        mentioned_at: now,
      },
      {
        id: "mention-counterpart-hidden",
        entity_id: "entity-hidden-counterpart",
        indexed_file_id: "file-hidden",
        confidence: "EXTRACTED",
        source: "test",
        relation: "mentioned",
        mentioned_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("entity_relationships")
    .values({
      id: "rel-hidden",
      source_entity_id: "entity-client",
      target_entity_id: "entity-hidden-counterpart",
      relationship_type: "engaged_with",
      confidence: "EXTRACTED",
      confidence_score: 0.9,
      source: "test",
    })
    .execute();
}
