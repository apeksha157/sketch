import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import type { LinkedinAimfoxMeta, LinkedinAimfoxSegmentManifest } from "../../connectors/linkedin-aimfox";
import { search } from "../../connectors/search";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createTestDb, spyOnExecutedSql } from "../../test-utils";
import { handleGetThread } from "./get-thread";
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

it("filters empty-query search by fileTypes as a narrowing predicate", async () => {
  const now = new Date().toISOString();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg-search-tools-zoho-file-types",
      connector_type: "zoho_crm",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      {
        id: "file-zoho-call",
        connector_config_id: "cfg-search-tools-zoho-file-types",
        provider_file_id: "Calls:1",
        file_name: "Zoho call record",
        file_type: "crm_call",
        content_category: "document",
        source: "zoho_crm",
        content: "latest zoho activity",
        source_updated_at: "2026-01-03T00:00:00.000Z",
        synced_at: now,
      },
      {
        id: "file-zoho-note",
        connector_config_id: "cfg-search-tools-zoho-file-types",
        provider_file_id: "Notes:1",
        file_name: "Zoho note record",
        file_type: "crm_note",
        content_category: "document",
        source: "zoho_crm",
        content: "latest zoho activity",
        source_updated_at: "2026-01-04T00:00:00.000Z",
        synced_at: now,
      },
    ])
    .execute();

  const result = await handleSearch({ fileTypes: ["crm_call"], sortBy: "recency", limit: 10 }, deps());
  const text = result.content[0]?.text ?? "";

  expect(text).toContain("Zoho call record");
  expect(text).not.toContain("Zoho note record");
});

it("filters Zoho CRM records by current-value fields", async () => {
  const now = new Date().toISOString();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg-search-tools-zoho-crm-fields",
      connector_type: "zoho_crm",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      {
        id: "file-crm-linkedin-open",
        connector_config_id: "cfg-search-tools-zoho-crm-fields",
        provider_file_id: "Leads:linkedin-open",
        file_name: "CRM field marker LinkedIn open lead",
        file_type: "crm_lead",
        content_category: "document",
        source: "zoho_crm",
        content: "crm field marker",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-crm-referral-open",
        connector_config_id: "cfg-search-tools-zoho-crm-fields",
        provider_file_id: "Leads:referral-open",
        file_name: "CRM field marker Referral open lead",
        file_type: "crm_lead",
        content_category: "document",
        source: "zoho_crm",
        content: "crm field marker",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-crm-linkedin-closed",
        connector_config_id: "cfg-search-tools-zoho-crm-fields",
        provider_file_id: "Leads:linkedin-closed",
        file_name: "CRM field marker LinkedIn closed lead",
        file_type: "crm_lead",
        content_category: "document",
        source: "zoho_crm",
        content: "crm field marker",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-crm-body-only",
        connector_config_id: "cfg-search-tools-zoho-crm-fields",
        provider_file_id: "Leads:body-only",
        file_name: "CRM field marker body-only mention",
        file_type: "crm_lead",
        content_category: "document",
        source: "zoho_crm",
        content: "crm field marker linkedin eligible",
        source_updated_at: now,
        synced_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("crm_record_fields")
    .values([
      {
        indexed_file_id: "file-crm-linkedin-open",
        field: "leadSource",
        value: "LinkedIn",
        value_norm: "linkedin",
      },
      { indexed_file_id: "file-crm-linkedin-open", field: "status", value: "Open", value_norm: "open" },
      { indexed_file_id: "file-crm-linkedin-open", field: "tag", value: "Eligible", value_norm: "eligible" },
      {
        indexed_file_id: "file-crm-referral-open",
        field: "leadSource",
        value: "Referral",
        value_norm: "referral",
      },
      { indexed_file_id: "file-crm-referral-open", field: "status", value: "Open", value_norm: "open" },
      {
        indexed_file_id: "file-crm-linkedin-closed",
        field: "leadSource",
        value: "LinkedIn",
        value_norm: "linkedin",
      },
      { indexed_file_id: "file-crm-linkedin-closed", field: "status", value: "Closed", value_norm: "closed" },
    ])
    .execute();

  const byLeadSource = await handleSearch(
    z
      .object(searchToolSchema)
      .parse({ query: "crm field marker", source: "zoho_crm", crmFields: { leadSource: "linkedin" } }),
    deps(),
  );
  const byLeadSourceText = byLeadSource.content[0]?.text ?? "";
  expect(byLeadSourceText).toContain("LinkedIn open lead");
  expect(byLeadSourceText).toContain("LinkedIn closed lead");
  expect(byLeadSourceText).not.toContain("Referral open lead");
  expect(byLeadSourceText).not.toContain("body-only mention");

  const byTwoKeys = await handleSearch(
    { query: "crm field marker", source: "zoho_crm", crmFields: { leadSource: "linkedin", status: "open" } },
    deps(),
  );
  const byTwoKeysText = byTwoKeys.content[0]?.text ?? "";
  expect(byTwoKeysText).toContain("LinkedIn open lead");
  expect(byTwoKeysText).not.toContain("LinkedIn closed lead");

  const byTag = await handleSearch(
    { query: "crm field marker", source: "zoho_crm", crmFields: { tag: "eligible" } },
    deps(),
  );
  const byTagText = byTag.content[0]?.text ?? "";
  expect(byTagText).toContain("LinkedIn open lead");
  expect(byTagText).not.toContain("body-only mention");
});

it("filters by participantEmail and domain facts without matching body-only mentions", async () => {
  const now = new Date().toISOString();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg-search-tools-outlook-participants",
      connector_type: "outlook",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      {
        id: "file-fact-correspondent",
        connector_config_id: "cfg-search-tools-outlook-participants",
        provider_file_id: "msg-fact",
        file_name: "Participant filter marker with matching correspondent fact",
        file_type: "email_message",
        content_category: "document",
        source: "outlook",
        content: "participant filter marker",
        thread_id: "thread-participant-a",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-body-only-correspondent",
        connector_config_id: "cfg-search-tools-outlook-participants",
        provider_file_id: "msg-body",
        file_name: "Participant filter marker that only mentions the address",
        file_type: "email_message",
        content_category: "document",
        source: "outlook",
        content: "participant filter marker vip@example.com",
        thread_id: "thread-participant-b",
        source_updated_at: now,
        synced_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("indexed_file_facts")
    .values({
      id: "fact-correspondent-vip",
      indexed_file_id: "file-fact-correspondent",
      connector_config_id: "cfg-search-tools-outlook-participants",
      source: "outlook",
      fact_type: "correspondent",
      relation: "sent",
      subject_name: "VIP",
      subject_email: "vip@example.com",
      fact_key: "fact-correspondent-vip",
    })
    .execute();

  const byEmail = await handleSearch(
    { query: "participant filter marker", participantEmail: "VIP@example.com" },
    deps(),
  );
  const byEmailText = byEmail.content[0]?.text ?? "";
  expect(byEmailText).toContain("with matching correspondent fact");
  expect(byEmailText).not.toContain("that only mentions the address");

  const byDomain = await handleSearch({ query: "participant filter marker", domain: "@example.com" }, deps());
  const byDomainText = byDomain.content[0]?.text ?? "";
  expect(byDomainText).toContain("with matching correspondent fact");
  expect(byDomainText).not.toContain("that only mentions the address");

  const rejected = await handleSearch(
    { query: "participant filter marker", participantEmail: "vip@example.com", domain: "example.com" },
    deps(),
  );
  expect(rejected.content[0]?.text).toContain("participantEmail and domain cannot both be provided");
});

it("filters by threadId and parentRecordId and prints chainable IDs", async () => {
  const now = new Date().toISOString();
  await db
    .insertInto("connector_configs")
    .values([
      {
        id: "cfg-search-tools-outlook-thread",
        connector_type: "outlook",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      },
      {
        id: "cfg-search-tools-zoho-parent",
        connector_type: "zoho_crm",
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
        id: "file-thread-target",
        connector_config_id: "cfg-search-tools-outlook-thread",
        provider_file_id: "msg-thread-target",
        file_name: "Target thread email",
        file_type: "email_message",
        content_category: "document",
        source: "outlook",
        content: "thread exact marker",
        thread_id: "thread-target",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-thread-neighbour",
        connector_config_id: "cfg-search-tools-outlook-thread",
        provider_file_id: "msg-thread-neighbour",
        file_name: "Neighbour thread email",
        file_type: "email_message",
        content_category: "document",
        source: "outlook",
        content: "thread exact marker",
        thread_id: "thread-neighbour",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-parent-target",
        connector_config_id: "cfg-search-tools-zoho-parent",
        provider_file_id: "Calls:parent-target",
        file_name: "Target parent activity",
        file_type: "crm_call",
        content_category: "document",
        source: "zoho_crm",
        content: "parent exact marker",
        rollup_group_id: "Contacts:parent-target",
        source_updated_at: now,
        synced_at: now,
      },
      {
        id: "file-parent-neighbour",
        connector_config_id: "cfg-search-tools-zoho-parent",
        provider_file_id: "Calls:parent-neighbour",
        file_name: "Neighbour parent activity",
        file_type: "crm_call",
        content_category: "document",
        source: "zoho_crm",
        content: "parent exact marker",
        rollup_group_id: "Contacts:parent-neighbour",
        source_updated_at: now,
        synced_at: now,
      },
    ])
    .execute();

  const byThread = await handleSearch({ query: "thread exact marker", threadId: "thread-target" }, deps());
  const threadText = byThread.content[0]?.text ?? "";
  expect(threadText).toContain("Target thread email");
  expect(threadText).toContain("threadId: thread-target");
  expect(threadText).not.toContain("Neighbour thread email");

  const byParent = await handleSearch(
    { query: "parent exact marker", parentRecordId: "Contacts:parent-target" },
    deps(),
  );
  const parentText = byParent.content[0]?.text ?? "";
  expect(parentText).toContain("Target parent activity");
  expect(parentText).toContain("rollupGroupId: Contacts:parent-target");
  expect(parentText).not.toContain("Neighbour parent activity");
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

it("collapses LinkedIn thread segments, expands on request, and still collapses email threads", async () => {
  const now = new Date().toISOString();
  await db
    .insertInto("connector_configs")
    .values([
      {
        id: "cfg-search-tools-linkedin",
        connector_type: "linkedin_aimfox",
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
        id: "linkedin-segment-1",
        connector_config_id: "cfg-search-tools-linkedin",
        provider_file_id: "linkedin-segment-1",
        thread_id: "linkedin-thread-1",
        file_name: "LinkedIn thread with Maya 1",
        file_type: "linkedin_conversation",
        content_category: "document",
        source: "linkedin_aimfox",
        content: "linkedin collapse marker first segment",
        summary: "First LinkedIn segment summary",
        access_scope_id: "scope-alice",
        source_created_at: "2026-09-01T10:00:00.000Z",
        source_updated_at: "2026-09-01T10:00:00.000Z",
        source_meta: JSON.stringify({
          linkedinAimfox: {
            accountId: "acct-1",
            conversationUrn: "urn:li:conversation:1",
            kind: "conversation_segment",
            segmentManifest: {
              messageCount: 5,
              inboundCount: 3,
              outboundCount: 2,
              lastInboundAt: "2026-09-01T10:00:00.000Z",
              lastOutboundAt: "2026-09-01T09:00:00.000Z",
            },
          },
        }),
        synced_at: now,
      },
      {
        id: "linkedin-segment-2",
        connector_config_id: "cfg-search-tools-linkedin",
        provider_file_id: "linkedin-segment-2",
        thread_id: "linkedin-thread-1",
        file_name: "LinkedIn thread with Maya 2",
        file_type: "linkedin_conversation",
        content_category: "document",
        source: "linkedin_aimfox",
        content: "linkedin collapse marker second segment",
        summary: "Second LinkedIn segment summary",
        access_scope_id: "scope-alice",
        source_created_at: "2026-09-03T10:00:00.000Z",
        source_updated_at: "2026-09-03T10:00:00.000Z",
        source_meta: JSON.stringify({
          linkedinAimfox: {
            accountId: "acct-1",
            conversationUrn: "urn:li:conversation:1",
            kind: "conversation_segment",
            segmentManifest: {
              messageCount: 3,
              inboundCount: 2,
              outboundCount: 1,
              lastInboundAt: "2026-09-03T10:00:00.000Z",
              lastOutboundAt: "2026-09-03T09:00:00.000Z",
            },
          },
        }),
        synced_at: now,
      },
      {
        id: "linkedin-segment-3",
        connector_config_id: "cfg-search-tools-linkedin",
        provider_file_id: "linkedin-segment-3",
        thread_id: "linkedin-thread-1",
        file_name: "Maya follow-up part 3",
        file_type: "linkedin_conversation",
        content_category: "document",
        source: "linkedin_aimfox",
        content: "visible unscored segment",
        summary: "Third Maya segment summary",
        access_scope_id: "scope-alice",
        source_created_at: "2026-09-02T10:00:00.000Z",
        source_updated_at: "2026-09-02T10:00:00.000Z",
        source_meta: JSON.stringify({
          linkedinAimfox: {
            accountId: "acct-1",
            conversationUrn: "urn:li:conversation:1",
            kind: "conversation_segment",
            segmentManifest: {
              messageCount: 2,
              inboundCount: 1,
              outboundCount: 1,
              lastInboundAt: null,
              lastOutboundAt: "2026-09-02T10:00:00.000Z",
            },
          },
        }),
        synced_at: now,
      },
      {
        id: "email-thread-1",
        connector_config_id: "cfg-search-tools-gmail",
        provider_file_id: "email-thread-1",
        provider_message_id: "<email-thread-1@example.com>",
        thread_id: "email-thread-1",
        file_name: "Email thread first",
        file_type: "email_message",
        content_category: "document",
        source: "gmail",
        content: "email collapse marker first",
        summary: "First email summary",
        access_scope_id: "scope-alice",
        source_created_at: "2026-09-01T10:00:00.000Z",
        source_updated_at: "2026-09-01T10:00:00.000Z",
        synced_at: now,
      },
      {
        id: "email-thread-2",
        connector_config_id: "cfg-search-tools-gmail",
        provider_file_id: "email-thread-2",
        provider_message_id: "<email-thread-2@example.com>",
        thread_id: "email-thread-1",
        file_name: "Email thread second",
        file_type: "email_message",
        content_category: "document",
        source: "gmail",
        content: "email collapse marker second",
        summary: "Second email summary",
        access_scope_id: "scope-alice",
        source_created_at: "2026-09-02T10:00:00.000Z",
        source_updated_at: "2026-09-02T10:00:00.000Z",
        synced_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("email_message_envelopes")
    .values([
      {
        indexed_file_id: "email-thread-1",
        connector_config_id: "cfg-search-tools-gmail",
        provider_file_id: "email-thread-1",
        provider_message_id: "<email-thread-1@example.com>",
        thread_id: "email-thread-1",
        subject: "Email first",
        sent_at: "2026-09-01T10:00:00.000Z",
        from_json: JSON.stringify({ name: "Maya", email: "maya@example.com" }),
        to_json: JSON.stringify([{ name: "Owner", email: "owner@example.com" }]),
        cc_json: JSON.stringify([]),
        owner_email: "owner@example.com",
        provider_url: null,
      },
      {
        indexed_file_id: "email-thread-2",
        connector_config_id: "cfg-search-tools-gmail",
        provider_file_id: "email-thread-2",
        provider_message_id: "<email-thread-2@example.com>",
        thread_id: "email-thread-1",
        subject: "Email second",
        sent_at: "2026-09-02T10:00:00.000Z",
        from_json: JSON.stringify({ name: "Maya", email: "maya@example.com" }),
        to_json: JSON.stringify([{ name: "Owner", email: "owner@example.com" }]),
        cc_json: JSON.stringify([]),
        owner_email: "owner@example.com",
        provider_url: null,
      },
    ])
    .execute();

  const collapsed = await handleSearch({ query: "linkedin collapse marker", source: "linkedin_aimfox" }, deps());
  const collapsedText = collapsed.content[0]?.text ?? "";
  expect(collapsedText).toContain("LinkedIn thread with Maya");
  expect(collapsedText).toContain("thread: 10 messages, 6 in / 4 out, last from them (2026-09-03)");
  expect(collapsedText.match(/sketchId: linkedin-segment-/g)).toHaveLength(1);

  const bestId = collapsedText.match(/sketchId: (linkedin-segment-\d)/)?.[1];
  expect(bestId).toBeTruthy();
  const thread = await handleGetThread({ fileId: bestId ?? "" }, deps());
  const parsedThread = JSON.parse(thread.content[0]?.text ?? "{}") as { total: number };
  expect(parsedThread.total).toBe(3);

  const expanded = await handleSearch(
    {
      query: "linkedin collapse marker",
      source: "linkedin_aimfox",
      expandThreads: true,
    },
    deps(),
  );
  const expandedText = expanded.content[0]?.text ?? "";
  expect(expandedText.match(/sketchId: linkedin-segment-/g)).toHaveLength(2);

  const email = await handleSearch({ query: "email collapse marker", kind: "email" }, deps());
  const emailText = email.content[0]?.text ?? "";
  expect(emailText.match(/sketchId: email-thread-/g)).toHaveLength(1);
  expect(emailText).toContain("Email second");
});

it("reads segment stats from the source_meta shape the LinkedIn connector writes", async () => {
  const segmentManifest: LinkedinAimfoxSegmentManifest = {
    segmentIndex: 0,
    terminalMessageId: "urn:li:message:9",
    messageCount: 4,
    algorithmVersion: 1,
    sealed: true,
    inboundCount: 3,
    outboundCount: 1,
    lastInboundAt: "2026-09-05T10:00:00.000Z",
    lastOutboundAt: "2026-09-04T10:00:00.000Z",
  };
  const sourceMeta: LinkedinAimfoxMeta = {
    linkedinAimfox: {
      accountId: "acct-1",
      conversationUrn: "urn:li:conversation:2",
      kind: "conversation_segment",
      segmentManifest,
    },
  };
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg-search-tools-linkedin-shape",
      connector_type: "linkedin_aimfox",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "linkedin-shape-1",
      connector_config_id: "cfg-search-tools-linkedin-shape",
      provider_file_id: "linkedin-shape-1",
      thread_id: "acct-1:urn:li:conversation:2",
      file_name: "LinkedIn thread with Priya",
      file_type: "linkedin_conversation",
      content_category: "document",
      source: "linkedin_aimfox",
      content: "linkedin manifest shape marker",
      access_scope_id: "scope-alice",
      source_created_at: "2026-09-04T10:00:00.000Z",
      source_updated_at: "2026-09-05T10:00:00.000Z",
      source_meta: JSON.stringify(sourceMeta),
      synced_at: new Date().toISOString(),
    })
    .execute();

  const result = await handleSearch({ query: "linkedin manifest shape marker", source: "linkedin_aimfox" }, deps());
  expect(result.content[0]?.text ?? "").toContain("thread: 4 messages, 3 in / 1 out, last from them (2026-09-05)");
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

describe("GetFileContent argument normalization", () => {
  it("uses single mode when the batch is empty or repeats the single id", async () => {
    await db
      .insertInto("indexed_file_raw_contents")
      .values({
        indexed_file_id: "file-alice",
        kind: "transcript",
        content: "full normalized content",
        char_length: 23,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    const emptyBatch = await handleGetFileContent(
      { fileId: " file-alice ", fileIds: [""], view: "full", maxCharsPerFile: 1 },
      deps(),
    );
    const repeated = await handleGetFileContent({ fileId: "file-alice", fileIds: ["file-alice"] }, deps());

    expect(emptyBatch.content[0]?.text).toContain("full normalized content");
    expect(repeated.content[0]?.text).toContain("# Alice project");
  });

  it("uses batch mode for a blank single id and for fileIds-only calls", async () => {
    const merged = await handleGetFileContent({ fileId: "", fileIds: ["file-alice", "file-bob"] }, deps());
    const singleton = await handleGetFileContent({ fileIds: ["file-alice"] }, deps());
    const mergedParsed = JSON.parse(merged.content[0]?.text ?? "{}");
    const singletonParsed = JSON.parse(singleton.content[0]?.text ?? "{}");

    expect(mergedParsed.files.map((file: { fileId: string }) => file.fileId)).toEqual(["file-alice", "file-bob"]);
    expect(singletonParsed.files).toHaveLength(1);
    expect(singletonParsed.files[0]).toMatchObject({ fileId: "file-alice", found: true });
  });

  it("merges distinct ids in single-first order and preserves duplicates", async () => {
    const result = await handleGetFileContent(
      { fileId: "file-alice", fileIds: ["file-bob", "file-alice"], view: "full" },
      deps(),
    );
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");

    expect(parsed.files.map((file: { fileId: string }) => file.fileId)).toEqual([
      "file-alice",
      "file-bob",
      "file-alice",
    ]);
  });

  it("rejects empty and over-cap normalized inputs", async () => {
    const empty = await handleGetFileContent({ fileId: "", fileIds: [""] }, deps());
    const overCap = await handleGetFileContent(
      { fileId: "file-alice", fileIds: Array.from({ length: 20 }, (_, index) => `file-${index}`) },
      deps(),
    );

    expect(empty).toMatchObject({
      isError: true,
      content: [{ text: "Provide fileId (one id) or fileIds (a list of ids)." }],
    });
    expect(overCap).toMatchObject({ isError: true, content: [{ text: "At most 20 file ids per call." }] });
  });
});

describe("GetFileContent fileIds batch", () => {
  it("returns three files in request order with per-file truncation", async () => {
    await db
      .insertInto("indexed_files")
      .values([
        {
          id: "batch-short-a",
          connector_config_id: "cfg-search-tools",
          provider_file_id: "batch-short-a",
          file_name: "Batch short A",
          file_type: "doc",
          content_category: "document",
          source: "google_drive",
          content: "short-a",
          access_scope_id: "scope-alice",
          source_updated_at: new Date().toISOString(),
          synced_at: new Date().toISOString(),
        },
        {
          id: "batch-long",
          connector_config_id: "cfg-search-tools",
          provider_file_id: "batch-long",
          file_name: "Batch long",
          file_type: "doc",
          content_category: "document",
          source: "google_drive",
          content: "0123456789abcdef",
          access_scope_id: "scope-alice",
          source_updated_at: new Date().toISOString(),
          synced_at: new Date().toISOString(),
        },
        {
          id: "batch-short-b",
          connector_config_id: "cfg-search-tools",
          provider_file_id: "batch-short-b",
          file_name: "Batch short B",
          file_type: "doc",
          content_category: "document",
          source: "google_drive",
          content: "short-b",
          access_scope_id: "scope-alice",
          source_updated_at: new Date().toISOString(),
          synced_at: new Date().toISOString(),
        },
      ])
      .execute();

    const result = await handleGetFileContent(
      { fileIds: ["batch-short-b", "batch-long", "batch-short-a"], maxCharsPerFile: 8 },
      {
        ...deps(),
        publicMcp: {
          userPrincipals: ["alice@example.com"],
          filterEntityMetadata: true,
          maxFileContentChars: 1_000,
        },
      },
    );
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");

    expect(parsed.files.map((file: { fileId: string }) => file.fileId)).toEqual([
      "batch-short-b",
      "batch-long",
      "batch-short-a",
    ]);
    expect(parsed.files[0]).toMatchObject({ found: true, content: "short-b", contentTruncated: false });
    expect(parsed.files[1]).toMatchObject({ found: true, content: "01234567", contentTruncated: true });
    expect(parsed.files[2]).toMatchObject({ found: true, content: "short-a", contentTruncated: false });
    expect(parsed.contentTruncated).toBe(true);
  });

  it("keeps hidden batch IDs unfound and fails closed with no principals", async () => {
    const visible = await handleGetFileContent({ fileIds: ["file-alice", "file-bob"] }, deps());
    const visibleParsed = JSON.parse(visible.content[0]?.text ?? "{}");

    expect(visibleParsed.files[0]).toMatchObject({ fileId: "file-alice", found: true });
    expect(visibleParsed.files[0].content).toContain("A");
    expect(visibleParsed.files[1]).toEqual({ fileId: "file-bob", found: false });

    const denied = await handleGetFileContent({ fileIds: ["file-alice", "file-bob"] }, zeroEmailDeps());
    const deniedParsed = JSON.parse(denied.content[0]?.text ?? "{}");

    expect(deniedParsed.files).toEqual([
      { fileId: "file-alice", found: false },
      { fileId: "file-bob", found: false },
    ]);
  });

  it("shares the total cap across files and ignores full view for batches", async () => {
    await db
      .insertInto("indexed_files")
      .values([
        {
          id: "batch-total-a",
          connector_config_id: "cfg-search-tools",
          provider_file_id: "batch-total-a",
          file_name: "Batch total A",
          file_type: "doc",
          content_category: "document",
          source: "google_drive",
          content: "12345",
          access_scope_id: "scope-alice",
          source_updated_at: new Date().toISOString(),
          synced_at: new Date().toISOString(),
        },
        {
          id: "batch-total-b",
          connector_config_id: "cfg-search-tools",
          provider_file_id: "batch-total-b",
          file_name: "Batch total B",
          file_type: "doc",
          content_category: "document",
          source: "google_drive",
          content: "67890",
          access_scope_id: "scope-alice",
          source_updated_at: new Date().toISOString(),
          synced_at: new Date().toISOString(),
        },
      ])
      .execute();

    const capped = await handleGetFileContent(
      { fileIds: ["batch-total-a", "batch-total-b"], maxCharsPerFile: 10 },
      {
        ...deps(),
        publicMcp: {
          userPrincipals: ["alice@example.com"],
          filterEntityMetadata: true,
          maxFileContentChars: 5,
        },
      },
    );
    const cappedParsed = JSON.parse(capped.content[0]?.text ?? "{}");

    expect(cappedParsed.files[0]).toMatchObject({ content: "12345", contentTruncated: false });
    expect(cappedParsed.files[1]).toMatchObject({ content: "", contentTruncated: true });
    expect(cappedParsed.contentTruncated).toBe(true);

    const withView = await handleGetFileContent({ fileIds: ["batch-total-a"], view: "full" }, deps());
    const withViewParsed = JSON.parse(withView.content[0]?.text ?? "{}");
    expect(withView.isError).toBeUndefined();
    expect(withViewParsed.files[0]).toMatchObject({ fileId: "batch-total-a", content: "12345" });
  });
});
