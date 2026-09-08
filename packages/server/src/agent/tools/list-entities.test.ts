import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createTestDb } from "../../test-utils";
import { handleListEntities } from "./list-entities";
import { UploadCollector } from "./types";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
  await seedEntities(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("ListEntities handler", () => {
  it("lists awaiting-reply people and pages equal last-touch timestamps without repeats", async () => {
    const awaiting = await handleListEntities({ type: ["person"], awaitingReply: true }, deps());
    const awaitingBody = JSON.parse(awaiting.content[0]?.text ?? "{}") as {
      entities: Array<{ id: string; company: { id: string; name: string } | null }>;
    };

    expect(awaitingBody.entities).toEqual([
      expect.objectContaining({
        id: "entity-person-awaiting",
        company: { id: "entity-company", name: "Example Co" },
      }),
    ]);

    const first = await handleListEntities({ type: ["person"], sortBy: "lastTouch", limit: 1 }, deps());
    const firstBody = JSON.parse(first.content[0]?.text ?? "{}") as {
      entities: Array<{ id: string; touchStats: { lastTouchAt: string | null } }>;
      nextCursor: string | null;
    };
    const second = await handleListEntities(
      { type: ["person"], sortBy: "lastTouch", limit: 1, cursor: firstBody.nextCursor ?? undefined },
      deps(),
    );
    const secondBody = JSON.parse(second.content[0]?.text ?? "{}") as {
      entities: Array<{ id: string; touchStats: { lastTouchAt: string | null } }>;
      nextCursor: string | null;
    };

    expect(firstBody.entities).toHaveLength(1);
    expect(secondBody.entities).toHaveLength(1);
    expect(firstBody.entities[0]?.touchStats.lastTouchAt).toBe(secondBody.entities[0]?.touchStats.lastTouchAt);
    expect(secondBody.entities[0]?.id).not.toBe(firstBody.entities[0]?.id);
  });

  it("filters restricted principals, hides aggregates, and fails closed with no principals", async () => {
    const restricted = await handleListEntities({}, restrictedDeps());
    const body = JSON.parse(restricted.content[0]?.text ?? "{}") as {
      entities: Array<{ id: string; hotness: number | null; touchStats: unknown; company: unknown }>;
    };

    expect(body.entities).toEqual([
      expect.objectContaining({
        id: "entity-person-awaiting",
        hotness: null,
        touchStats: null,
        company: null,
      }),
    ]);

    const aggregateFilter = await handleListEntities({ awaitingReply: true }, restrictedDeps());
    expect(aggregateFilter.isError).toBe(true);
    expect(aggregateFilter.content[0]?.text).toContain("admin_can_read_all_files");

    const hotnessSort = await handleListEntities({ sortBy: "hotness" }, restrictedDeps());
    expect(hotnessSort.isError).toBe(true);
    expect(hotnessSort.content[0]?.text).toContain("admin_can_read_all_files");

    const closed = await handleListEntities({}, zeroPrincipalDeps());
    expect(JSON.parse(closed.content[0]?.text ?? "{}")).toEqual({ entities: [], nextCursor: null });
  });
});

function deps() {
  return {
    uploadCollector: new UploadCollector(),
    workspaceDir: "/tmp",
    db,
    userRepo: createUserRepository(db),
    currentUserId: "admin",
    adminReadAllEnabled: true,
  };
}

function restrictedDeps() {
  return {
    uploadCollector: new UploadCollector(),
    workspaceDir: "/tmp",
    db,
    userRepo: createUserRepository(db),
    publicMcp: {
      userPrincipals: ["alice@example.com"],
      filterEntityMetadata: true,
    },
  };
}

function zeroPrincipalDeps() {
  return {
    ...restrictedDeps(),
    publicMcp: {
      userPrincipals: [],
      filterEntityMetadata: true,
    },
  };
}

async function seedEntities(db: Kysely<DB>) {
  const now = "2026-09-07T10:00:00.000Z";
  await db
    .insertInto("users")
    .values([
      { id: "admin", name: "Admin", email: "admin@example.com", auth_role: "admin", created_at: now },
      { id: "owner", name: "Owner", email: "owner@example.com", auth_role: "member", created_at: now },
    ])
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg-list-entities",
      connector_type: "outlook",
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
        connector_config_id: "cfg-list-entities",
        scope_type: "mailbox",
        provider_scope_id: "mailbox-visible",
      },
      {
        id: "scope-hidden",
        connector_config_id: "cfg-list-entities",
        scope_type: "mailbox",
        provider_scope_id: "mailbox-hidden",
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
        id: "file-visible-person",
        connector_config_id: "cfg-list-entities",
        provider_file_id: "provider-visible-person",
        file_name: "Visible person email",
        file_type: "email_message",
        content_category: "document",
        source: "outlook",
        content: "visible person",
        access_scope_id: "scope-visible",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-hidden-person",
        connector_config_id: "cfg-list-entities",
        provider_file_id: "provider-hidden-person",
        file_name: "Hidden person email",
        file_type: "email_message",
        content_category: "document",
        source: "outlook",
        content: "hidden person",
        access_scope_id: "scope-hidden",
        source_updated_at: now,
        synced_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("entities")
    .values([
      {
        id: "entity-company",
        name: "Example Co",
        source_type: "company",
        status: "confirmed",
        hotness: 90,
        created_at: now,
        updated_at: now,
      },
      {
        id: "entity-person-awaiting",
        name: "Ada Awaiting",
        source_type: "person",
        status: "confirmed",
        hotness: 80,
        created_at: now,
        updated_at: now,
      },
      {
        id: "entity-person-answered",
        name: "Zed Answered",
        source_type: "person",
        status: "confirmed",
        hotness: 70,
        created_at: now,
        updated_at: now,
      },
      {
        id: "entity-person-hidden",
        name: "Hidden Person",
        source_type: "person",
        status: "confirmed",
        hotness: 60,
        created_at: now,
        updated_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("entity_touch_stats")
    .values([
      {
        entity_id: "entity-person-awaiting",
        last_touch_at: "2026-09-07T12:00:00.000Z",
        last_inbound_at: "2026-09-07T12:00:00.000Z",
        last_outbound_at: "2026-09-07T11:00:00.000Z",
        touch_count_30d: 3,
        touch_count_90d: 5,
        source_last_touch: JSON.stringify({ outlook: "2026-09-07T12:00:00.000Z" }),
        computed_at: now,
      },
      {
        entity_id: "entity-person-answered",
        last_touch_at: "2026-09-07T12:00:00.000Z",
        last_inbound_at: "2026-09-07T10:00:00.000Z",
        last_outbound_at: "2026-09-07T12:00:00.000Z",
        touch_count_30d: 2,
        touch_count_90d: 4,
        source_last_touch: JSON.stringify({ outlook: "2026-09-07T12:00:00.000Z" }),
        computed_at: now,
      },
      {
        entity_id: "entity-person-hidden",
        last_touch_at: "2026-09-07T09:30:00.000Z",
        last_inbound_at: "2026-09-07T09:00:00.000Z",
        last_outbound_at: "2026-09-07T09:30:00.000Z",
        touch_count_30d: 1,
        touch_count_90d: 1,
        source_last_touch: JSON.stringify({ outlook: "2026-09-07T09:00:00.000Z" }),
        computed_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("entity_mentions")
    .values([
      {
        id: "mention-visible-person",
        entity_id: "entity-person-awaiting",
        indexed_file_id: "file-visible-person",
        confidence: "EXTRACTED",
        source: "test",
        relation: "mentioned",
        mentioned_at: now,
      },
      {
        id: "mention-hidden-person",
        entity_id: "entity-person-hidden",
        indexed_file_id: "file-hidden-person",
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
      id: "rel-person-company",
      source_entity_id: "entity-person-awaiting",
      target_entity_id: "entity-company",
      relationship_type: "works_at",
      confidence: "EXTRACTED",
      confidence_score: 0.9,
      source: "test",
    })
    .execute();
}
