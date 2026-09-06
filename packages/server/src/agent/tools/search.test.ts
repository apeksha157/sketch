import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { search } from "../../connectors/search";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createTestDb, spyOnExecutedSql } from "../../test-utils";
import {
  handleGetEntityContext,
  handleGetFileContent,
  handleSearch,
  handleSearchEntities,
  searchToolSchema,
} from "./search";
import { UploadCollector } from "./types";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg-search-tools",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin",
    })
    .execute();
  await db
    .insertInto("access_scopes")
    .values([
      {
        id: "scope-alice",
        connector_config_id: "cfg-search-tools",
        scope_type: "drive",
        provider_scope_id: "drive-alice",
      },
      {
        id: "scope-bob",
        connector_config_id: "cfg-search-tools",
        scope_type: "drive",
        provider_scope_id: "drive-bob",
      },
    ])
    .execute();
  await db
    .insertInto("access_scope_members")
    .values({ access_scope_id: "scope-alice", principal_type: "email", principal_value: "alice@example.com" })
    .execute();

  const now = new Date().toISOString();
  const baseFile = {
    connector_config_id: "cfg-search-tools",
    file_type: "doc",
    content_category: "document",
    source: "google_drive",
    synced_at: now,
    source_updated_at: now,
  };
  await db
    .insertInto("indexed_files")
    .values([
      {
        id: "file-alice",
        ...baseFile,
        provider_file_id: "file-alice",
        file_name: "Alice project",
        content: "A".repeat(120),
        access_scope_id: "scope-alice",
      },
      {
        id: "file-bob",
        ...baseFile,
        provider_file_id: "file-bob",
        file_name: "Bob project",
        content: "secret",
        access_scope_id: "scope-bob",
      },
    ])
    .execute();
  await db
    .insertInto("entities")
    .values([
      {
        id: "entity-alice",
        name: "Project Alice",
        source_type: "project",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: "entity-bob",
        name: "Project Bob",
        source_type: "project",
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
        id: "mention-alice",
        entity_id: "entity-alice",
        indexed_file_id: "file-alice",
        chunk_index: 0,
        context_snippet: "alice context",
        confidence: "INFERRED",
        source: "llm_extraction",
        relation: "mentioned",
        mentioned_at: now,
      },
      {
        id: "mention-bob",
        entity_id: "entity-bob",
        indexed_file_id: "file-bob",
        chunk_index: 0,
        context_snippet: "bob context",
        confidence: "INFERRED",
        source: "llm_extraction",
        relation: "mentioned",
        mentioned_at: now,
      },
    ])
    .execute();
});

afterEach(async () => {
  await db.destroy();
});

it("accepts Teams as a search source filter and returns only Teams files", async () => {
  const now = new Date().toISOString();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg-search-tools-teams",
      connector_type: "teams",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      {
        id: "file-teams-source",
        connector_config_id: "cfg-search-tools-teams",
        provider_file_id: "file-teams-source",
        file_name: "Teams source reachability",
        file_type: "meeting_transcript",
        content_category: "document",
        source: "teams",
        content: "source filter reachability marker",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-drive-source",
        connector_config_id: "cfg-search-tools",
        provider_file_id: "file-drive-source",
        file_name: "Drive source reachability",
        file_type: "doc",
        content_category: "document",
        source: "google_drive",
        content: "source filter reachability marker",
        source_updated_at: now,
        synced_at: now,
      },
    ])
    .execute();

  const parsed = z.object(searchToolSchema).parse({ query: "reachability marker", source: "teams", limit: 10 });
  const result = await handleSearch(parsed, deps());
  const text = result.content[0]?.text ?? "";

  expect(text).toContain("Teams source reachability");
  expect(text).not.toContain("Drive source reachability");
});

it("reaches Outlook emails through kind: email and keeps chat out of it", async () => {
  const now = new Date().toISOString();
  await db
    .insertInto("connector_configs")
    .values([
      {
        id: "cfg-search-tools-outlook",
        connector_type: "outlook",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      },
      {
        id: "cfg-search-tools-whatsapp",
        connector_type: "whatsapp",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      },
      {
        id: "cfg-search-tools-gmail",
        connector_type: "gmail",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      },
    ])
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      {
        id: "file-outlook-email",
        connector_config_id: "cfg-search-tools-outlook",
        provider_file_id: "file-outlook-email",
        file_name: "Outlook email kind reachability",
        file_type: "email_message",
        content_category: "document",
        source: "outlook",
        content: "email kind reachability marker",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-whatsapp-chat",
        connector_config_id: "cfg-search-tools-whatsapp",
        provider_file_id: "file-whatsapp-chat",
        file_name: "WhatsApp chat kind reachability",
        file_type: "conversation",
        content_category: "document",
        source: "whatsapp",
        content: "email kind reachability marker",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-gmail-email",
        connector_config_id: "cfg-search-tools-gmail",
        provider_file_id: "file-gmail-email",
        file_name: "Gmail email kind reachability",
        file_type: "email_message",
        content_category: "document",
        source: "gmail",
        content: "email kind reachability marker",
        source_updated_at: now,
        synced_at: now,
      },
    ])
    .execute();

  const parsed = z
    .object(searchToolSchema)
    .parse({ query: "email kind reachability marker", kind: "email", limit: 10 });
  const result = await handleSearch(parsed, deps());
  const text = result.content[0]?.text ?? "";

  expect(text).toContain("Outlook email kind reachability");
  expect(text).toContain("Gmail email kind reachability");
  expect(text).not.toContain("WhatsApp chat kind reachability");

  const narrowed = z
    .object(searchToolSchema)
    .parse({ query: "email kind reachability marker", kind: "email", source: "outlook", limit: 10 });
  const narrowedResult = await handleSearch(narrowed, deps());
  const narrowedText = narrowedResult.content[0]?.text ?? "";

  expect(narrowedText).toContain("Outlook email kind reachability");
  expect(narrowedText).not.toContain("Gmail email kind reachability");
});

it("keeps the local-specific error for kind=email with source: local", async () => {
  const parsed = z.object(searchToolSchema).parse({ query: "anything", kind: "email", source: "local" });
  const result = await handleSearch(parsed, deps());
  const text = result.content[0]?.text ?? "";

  expect(text).toContain("local files have no kind taxonomy");
});

it("rejects a kind×source pair that compiles to an empty intersection, naming the right kind", async () => {
  const parsed = z.object(searchToolSchema).parse({ query: "anything", kind: "message", source: "outlook" });
  const result = await handleSearch(parsed, deps());
  const text = result.content[0]?.text ?? "";

  expect(text).toContain("can never match");
  expect(text).toContain("'email'");
});

it("lists the applied filters on an empty result instead of a bare no-results line", async () => {
  const parsed = z.object(searchToolSchema).parse({
    query: "no such content anywhere",
    kind: "email",
    after: "2020-01-01",
    before: "2020-01-02",
  });
  const result = await handleSearch(parsed, deps());
  const text = result.content[0]?.text ?? "";

  expect(text).toContain("Filters applied: kind=email");
  expect(text).toContain("Try broader query terms, or relax a filter");
});

it("normalizes legacy person subtypes in search and context output", async () => {
  await db
    .insertInto("entities")
    .values({
      id: "legacy-person",
      name: "Legacy Person",
      source_type: "person",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      provenance_tier: "inferred",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  await db
    .insertInto("entity_mentions")
    .values({
      id: "mention-legacy-person",
      entity_id: "legacy-person",
      indexed_file_id: "file-alice",
      chunk_index: 0,
      context_snippet: "legacy person context",
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
      mentioned_at: new Date().toISOString(),
    })
    .execute();

  const entitySearch = await handleSearchEntities({ queries: ["Legacy Person"] }, deps());
  expect(entitySearch.content[0]?.text).toContain('"subtype": "external"');

  const context = await handleGetEntityContext({ entityId: "legacy-person" }, deps());
  expect(context.content[0]?.text).toContain("Type: person (external)");

  const searchResult = await handleSearch({ query: "Legacy Person" }, deps());
  expect(searchResult.content[0]?.text).toContain("(external)");
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

describe("public search handlers", () => {
  it("resolves boost entities once and preserves search() result order", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("indexed_files")
      .values(
        Array.from({ length: 30 }, (_, index) => ({
          id: `alice-strong-${index}`,
          connector_config_id: "cfg-search-tools",
          provider_file_id: `alice-strong-${index}`,
          file_name: `Alice evidence ${index}`,
          file_type: "doc",
          content_category: "document",
          source: "google_drive",
          content: "Alice ".repeat(20),
          access_scope_id: "scope-alice",
          source_updated_at: now,
          synced_at: now,
        })),
      )
      .execute();
    await db
      .updateTable("indexed_files")
      .set({ file_name: "Weak entity-linked record", content: "Alice", summary: "Alice" })
      .where("id", "=", "file-alice")
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "alice-linked-weak",
        connector_config_id: "cfg-search-tools",
        provider_file_id: "alice-linked-weak",
        file_name: "Weak linked evidence",
        file_type: "doc",
        content_category: "document",
        source: "google_drive",
        content: "Alice",
        summary: "Alice",
        access_scope_id: "scope-alice",
        source_updated_at: now,
        synced_at: now,
      })
      .execute();
    await db.deleteFrom("entity_mentions").where("id", "=", "mention-alice").execute();
    await db
      .insertInto("entity_mentions")
      .values({
        id: "mention-alice-linked-weak",
        entity_id: "entity-alice",
        indexed_file_id: "alice-linked-weak",
        chunk_index: 0,
        context_snippet: "alice context",
        confidence: "INFERRED",
        source: "llm_extraction",
        relation: "mentioned",
        mentioned_at: now,
      })
      .execute();

    const expected = await search(db, "Alice", {
      limit: 40,
      userPrincipals: ["alice@example.com"],
      boostEntityIds: ["entity-alice"],
    });
    const executed = spyOnExecutedSql(db);

    const result = await handleSearch({ query: "Alice", limit: 40 }, deps());
    const actualOrder = [...(result.content[0]?.text ?? "").matchAll(/ {2}sketchId: ([^\n]+)/g)].map(
      (match) => match[1],
    );
    const entityResolutionQueries = executed.queries.filter((query) => query.sql.includes("entity_search_tier"));
    const boostQuery = executed.queries.find((query) =>
      query.sql.includes('select distinct "indexed_file_id" from "entity_mentions"'),
    );

    expect(entityResolutionQueries).toHaveLength(1);
    expect(boostQuery?.parameters).toContain("entity-alice");
    expect(actualOrder).toEqual(expected.map((row) => row.id));
    expect(actualOrder[0]).not.toBe("alice-linked-weak");
    expect(actualOrder).toContain("alice-linked-weak");
  });

  it("filters entity search results to RBAC-accessible mentions", async () => {
    const result = await handleSearchEntities({ queries: ["Project"] }, deps());
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Project Alice");
    expect(text).not.toContain("Project Bob");
  });

  it("does not reveal inaccessible entity context", async () => {
    const result = await handleGetEntityContext({ entityId: "entity-bob" }, deps());
    expect(result.content[0]?.text).toBe("Entity entity-bob not found.");
  });

  it("applies mention visibility before the requested limit", async () => {
    const hiddenFileIds = Array.from({ length: 101 }, (_, index) => `newer-hidden-${index}`);
    await db
      .insertInto("indexed_files")
      .values(
        hiddenFileIds.map((id) => ({
          id,
          connector_config_id: "cfg-search-tools",
          provider_file_id: id,
          file_name: id,
          file_type: "doc",
          content_category: "document",
          source: "google_drive",
          access_scope_id: "scope-bob",
          source_updated_at: "2030-01-01T00:00:00.000Z",
          synced_at: "2030-01-01T00:00:00.000Z",
        })),
      )
      .execute();
    await db
      .insertInto("entity_mentions")
      .values(
        hiddenFileIds.map((indexedFileId, index) => ({
          id: `newer-hidden-mention-${index}`,
          entity_id: "entity-alice",
          indexed_file_id: indexedFileId,
          chunk_index: null,
          context_snippet: null,
          confidence: "INFERRED" as const,
          source: "test",
          relation: "mentioned" as const,
          mentioned_at: "2030-01-01T00:00:00.000Z",
        })),
      )
      .execute();

    const result = await handleGetEntityContext({ entityId: "entity-alice", limit: 1 }, deps());

    expect(result.content[0]?.text).toContain('Google_drive: "Alice project"');
    expect(result.content[0]?.text).not.toContain("newer-hidden");
  });

  it("caps public file content responses", async () => {
    const result = await handleGetFileContent({ fileId: "file-alice" }, deps());
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("[Content truncated to 50 characters.]");
    expect(text.length).toBeLessThan(300);
  });

  it("denies all public handlers when the caller has no verified emails", async () => {
    await createUserRepository(db).create({
      name: "Directory Alice",
      email: "directory@example.com",
      emailVerified: true,
    });

    const searchResult = await handleSearch({ query: "Alice" }, zeroEmailDeps());
    const entitiesResult = await handleSearchEntities({ queries: ["Directory"] }, zeroEmailDeps());
    const contextResult = await handleGetEntityContext({ entityId: "entity-alice" }, zeroEmailDeps());
    const contentResult = await handleGetFileContent({ fileId: "file-alice" }, zeroEmailDeps());

    expect(searchResult.content[0]?.text).toBe('No results found for "Alice".');
    expect(entitiesResult.content[0]?.text).toBe("No entities found matching those queries.");
    expect(contextResult.content[0]?.text).toBe("No mentions found for this entity.");
    expect(contentResult.content[0]?.text).toBe("File file-alice not found.");
  });
});

describe("GetFileContent view: full", () => {
  async function seedRaw(content: string): Promise<void> {
    await db
      .insertInto("indexed_file_raw_contents")
      .values({
        indexed_file_id: "file-alice",
        kind: "transcript",
        content,
        char_length: content.length,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
  }

  it("returns the raw stored version, bypassing the public MCP summary cap", async () => {
    await seedRaw("## Transcript\n[00:01] Sanaa: A full sentence far longer than the 50-char public cap allows.");
    const result = await handleGetFileContent({ fileId: "file-alice", view: "full" }, deps());
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Sanaa: A full sentence far longer");
    expect(text).not.toContain("Content truncated");
    expect(text).toContain("[Total length:");
  });

  it("falls back to indexed content with a note when no raw version is stored", async () => {
    const result = await handleGetFileContent({ fileId: "file-alice", view: "full" }, deps());
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("(no separate raw version stored — returning indexed content)");
    expect(text).toContain("A".repeat(120));
  });

  it("pages content larger than one page and reports the continuation offset", async () => {
    const big = `## Transcript\n${"S: word\n".repeat(9000)}`;
    await seedRaw(big);
    const page1 = await handleGetFileContent({ fileId: "file-alice", view: "full" }, deps());
    const text1 = page1.content[0]?.text ?? "";
    expect(text1).toContain(`[Showing characters 0-50000 of ${big.length}. Pass offset: 50000 for the next page.]`);

    const page2 = await handleGetFileContent({ fileId: "file-alice", view: "full", offset: 50000 }, deps());
    const text2 = page2.content[0]?.text ?? "";
    expect(text2).toContain(`[Total length: ${big.length} characters.]`);
    expect(text2).not.toContain("Pass offset:");

    const past = await handleGetFileContent({ fileId: "file-alice", view: "full", offset: big.length + 5 }, deps());
    expect(past.content[0]?.text).toContain("(offset is past the end of the content)");
  });

  it("rejects offset without view: full as a tool error, and enforces RBAC before the raw lookup", async () => {
    const bad = await handleGetFileContent({ fileId: "file-alice", offset: 10 }, deps());
    expect(bad.isError).toBe(true);

    await db
      .insertInto("indexed_file_raw_contents")
      .values({
        indexed_file_id: "file-bob",
        kind: "transcript",
        content: "bob secret transcript",
        char_length: 21,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    const denied = await handleGetFileContent({ fileId: "file-bob", view: "full" }, deps());
    expect(denied.content[0]?.text).toBe("File file-bob not found.");
  });
});
