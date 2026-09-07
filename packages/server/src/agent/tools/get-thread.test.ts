import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createTestDb, spyOnExecutedSql } from "../../test-utils";
import { handleGetThread } from "./get-thread";
import { UploadCollector } from "./types";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

describe("GetThread public handler", () => {
  it("returns only visible email messages, withholds partial summaries, and stops after an invisible anchor", async () => {
    await seedAccess();
    await seedEmailThread();

    const partialResult = await handleGetThread({ fileId: "email-2" }, deps(["alice@example.com"]));
    const partial = JSON.parse(partialResult.content[0]?.text ?? "{}") as {
      kind: string;
      threadKey: string;
      total: number;
      summary: string | null;
      summaryWithheld?: boolean;
      messages: Array<{ fileId: string; title: string; author: string | null }>;
    };

    expect(partial.kind).toBe("email_thread");
    expect(partial.threadKey).toBe("cfg-email:thread-a");
    expect(partial.total).toBe(2);
    expect(partial.summary).toBeNull();
    expect(partial.summaryWithheld).toBe(true);
    expect(partial.messages.map((message) => message.fileId)).toEqual(["email-1", "email-2"]);
    expect(partial.messages.map((message) => message.author)).toEqual(["Alice", "Alice"]);

    const fullResult = await handleGetThread({ fileId: "email-2" }, deps(["alice@example.com", "bob@example.com"]));
    const full = JSON.parse(fullResult.content[0]?.text ?? "{}") as {
      summary: string | null;
      summaryWithheld?: boolean;
      messages: Array<{ fileId: string }>;
    };

    expect(full.summary).toBe("Full email thread summary");
    expect(full.summaryWithheld).toBeUndefined();
    expect(full.messages.map((message) => message.fileId)).toEqual(["email-1", "email-2", "email-3"]);

    const spy = spyOnExecutedSql(db);
    try {
      const hidden = await handleGetThread({ fileId: "email-3" }, deps(["alice@example.com"]));
      expect(hidden.content[0]?.text).toBe("Thread not found.");
      expect(spy.count).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("dispatches LinkedIn conversations and CRM rollups", async () => {
    await seedLinkedInConversation();
    await seedCrmRollup();

    const linkedinResult = await handleGetThread({ fileId: "linkedin-2" }, deps(["alice@example.com"]));
    const linkedin = JSON.parse(linkedinResult.content[0]?.text ?? "{}") as {
      kind: string;
      total: number;
      messages: Array<{ fileId: string }>;
    };

    expect(linkedin.kind).toBe("linkedin_conversation");
    expect(linkedin.total).toBe(3);
    expect(linkedin.messages.map((message) => message.fileId)).toEqual(["linkedin-1", "linkedin-2", "linkedin-3"]);

    const crmResult = await handleGetThread({ fileId: "crm-note" }, deps(["alice@example.com"]));
    const crm = JSON.parse(crmResult.content[0]?.text ?? "{}") as {
      kind: string;
      threadKey: string;
      summary: string | null;
      messages: Array<{ fileId: string }>;
    };

    expect(crm.kind).toBe("crm_record");
    expect(crm.threadKey).toBe("cfg-crm:contact-1");
    expect(crm.summary).toBe("CRM rollup summary");
    expect(crm.messages.map((message) => message.fileId)).toEqual(["crm-contact", "crm-task", "crm-note"]);
  });

  it("cuts message content and pages long threads without overlap", async () => {
    await seedLongThread();

    const firstResult = await handleGetThread(
      { fileId: "long-1", limit: 2, offset: 0, maxCharsPerMessage: 4 },
      deps(["alice@example.com"], 7),
    );
    const first = JSON.parse(firstResult.content[0]?.text ?? "{}") as {
      truncated?: boolean;
      messages: Array<{ fileId: string; content: string; contentTruncated: boolean }>;
    };

    expect(first.messages.map((message) => message.fileId)).toEqual(["long-1", "long-2"]);
    expect(first.messages[0]).toMatchObject({ content: "1111", contentTruncated: true });
    expect(first.messages[1]).toMatchObject({ content: "222", contentTruncated: true });
    expect(first.truncated).toBe(true);

    const secondResult = await handleGetThread({ fileId: "long-1", limit: 2, offset: 2 }, deps(["alice@example.com"]));
    const second = JSON.parse(secondResult.content[0]?.text ?? "{}") as { messages: Array<{ fileId: string }> };

    expect(second.messages.map((message) => message.fileId)).toEqual(["long-3", "long-4"]);
  });
});

function deps(userPrincipals: string[], maxFileContentChars = 50_000) {
  return {
    uploadCollector: new UploadCollector(),
    workspaceDir: "/tmp",
    db,
    userRepo: createUserRepository(db),
    publicMcp: {
      userPrincipals,
      filterEntityMetadata: true,
      maxFileContentChars,
    },
  };
}

async function seedAccess() {
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg-email",
      connector_type: "gmail",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "owner",
    })
    .execute();
  await db
    .insertInto("access_scopes")
    .values([
      {
        id: "scope-alice",
        connector_config_id: "cfg-email",
        scope_type: "mailbox",
        provider_scope_id: "alice",
      },
      {
        id: "scope-bob",
        connector_config_id: "cfg-email",
        scope_type: "mailbox",
        provider_scope_id: "bob",
      },
    ])
    .execute();
  await db
    .insertInto("access_scope_members")
    .values([
      { access_scope_id: "scope-alice", principal_type: "email", principal_value: "alice@example.com" },
      { access_scope_id: "scope-bob", principal_type: "email", principal_value: "bob@example.com" },
    ])
    .execute();
}

async function seedEmailThread() {
  const now = "2026-09-07T09:00:00.000Z";
  await db
    .insertInto("indexed_files")
    .values([
      emailFile("email-1", "First", "2026-09-07T09:00:00.000Z", "scope-alice", "one"),
      emailFile("email-2", "Second", "2026-09-07T10:00:00.000Z", "scope-alice", "two"),
      emailFile("email-3", "Third", "2026-09-07T11:00:00.000Z", "scope-bob", "three"),
    ])
    .execute();
  await db
    .insertInto("email_message_envelopes")
    .values([
      envelope("email-1", "First", "2026-09-07T09:00:00.000Z"),
      envelope("email-2", "Second", "2026-09-07T10:00:00.000Z"),
      envelope("email-3", "Third", "2026-09-07T11:00:00.000Z"),
    ])
    .execute();
  await db
    .insertInto("email_thread_summaries")
    .values({
      connector_config_id: "cfg-email",
      thread_id: "thread-a",
      summary: "Full email thread summary",
      message_count: 3,
      basis_first_sent_at: now,
      basis_last_sent_at: "2026-09-07T11:00:00.000Z",
      basis_hash: "email-hash",
    })
    .execute();
}

async function seedLinkedInConversation() {
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg-linkedin",
      connector_type: "linkedin_aimfox",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "owner",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      linkedinFile("linkedin-1", "2026-09-07T09:00:00.000Z"),
      linkedinFile("linkedin-2", "2026-09-07T10:00:00.000Z"),
      linkedinFile("linkedin-3", "2026-09-07T11:00:00.000Z"),
    ])
    .execute();
}

async function seedCrmRollup() {
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg-crm",
      connector_type: "zoho_crm",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "owner",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      crmFile("crm-contact", "contact-1", "contact-1", "Contact", "contact", "2026-09-07T08:00:00.000Z"),
      crmFile("crm-note", "note-1", "contact-1", "Note", "crm_note", "2026-09-07T10:00:00.000Z"),
      crmFile("crm-task", "task-1", "contact-1", "Task", "crm_task", "2026-09-07T09:00:00.000Z"),
    ])
    .execute();
  await db
    .insertInto("crm_object_summaries")
    .values({
      connector_config_id: "cfg-crm",
      group_id: "contact-1",
      summary: "CRM rollup summary",
      activity_count: 2,
      basis_first_at: "2026-09-07T09:00:00.000Z",
      basis_last_at: "2026-09-07T10:00:00.000Z",
      basis_hash: "crm-hash",
    })
    .execute();
}

async function seedLongThread() {
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg-long",
      connector_type: "gmail",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "owner",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      longFile("long-1", "2026-09-07T09:00:00.000Z", "111111"),
      longFile("long-2", "2026-09-07T10:00:00.000Z", "222222"),
      longFile("long-3", "2026-09-07T11:00:00.000Z", "333333"),
      longFile("long-4", "2026-09-07T12:00:00.000Z", "444444"),
    ])
    .execute();
  await db
    .insertInto("email_message_envelopes")
    .values([
      longEnvelope("long-1", "2026-09-07T09:00:00.000Z"),
      longEnvelope("long-2", "2026-09-07T10:00:00.000Z"),
      longEnvelope("long-3", "2026-09-07T11:00:00.000Z"),
      longEnvelope("long-4", "2026-09-07T12:00:00.000Z"),
    ])
    .execute();
}

function emailFile(id: string, name: string, at: string, accessScopeId: string, content: string) {
  return {
    id,
    connector_config_id: "cfg-email",
    provider_file_id: id,
    provider_message_id: id,
    thread_id: "thread-a",
    file_name: name,
    file_type: "email_message",
    content_category: "document",
    source: "gmail",
    content,
    access_scope_id: accessScopeId,
    source_created_at: at,
    source_updated_at: at,
    synced_at: at,
  };
}

function envelope(id: string, subject: string, sentAt: string) {
  return {
    indexed_file_id: id,
    connector_config_id: "cfg-email",
    provider_file_id: id,
    provider_message_id: id,
    thread_id: "thread-a",
    subject,
    sent_at: sentAt,
    from_json: JSON.stringify({ name: "Alice", email: "alice@example.com" }),
    to_json: "[]",
    cc_json: "[]",
    provider_url: `https://mail.example/${id}`,
  };
}

function linkedinFile(id: string, at: string) {
  return {
    id,
    connector_config_id: "cfg-linkedin",
    provider_file_id: id,
    thread_id: "account-1:conversation-1",
    file_name: id,
    file_type: "linkedin_conversation",
    content_category: "document",
    source: "linkedin_aimfox",
    content: id,
    source_created_at: at,
    source_updated_at: at,
    synced_at: at,
  };
}

function crmFile(id: string, providerFileId: string, groupId: string, name: string, fileType: string, at: string) {
  return {
    id,
    connector_config_id: "cfg-crm",
    provider_file_id: providerFileId,
    rollup_group_id: groupId,
    file_name: name,
    file_type: fileType,
    content_category: "document",
    source: "zoho_crm",
    content: name,
    source_created_at: at,
    source_updated_at: at,
    synced_at: at,
  };
}

function longFile(id: string, at: string, content: string) {
  return {
    id,
    connector_config_id: "cfg-long",
    provider_file_id: id,
    provider_message_id: id,
    thread_id: "long-thread",
    file_name: id,
    file_type: "email_message",
    content_category: "document",
    source: "gmail",
    content,
    source_created_at: at,
    source_updated_at: at,
    synced_at: at,
  };
}

function longEnvelope(id: string, sentAt: string) {
  return {
    indexed_file_id: id,
    connector_config_id: "cfg-long",
    provider_file_id: id,
    provider_message_id: id,
    thread_id: "long-thread",
    subject: id,
    sent_at: sentAt,
    from_json: JSON.stringify({ name: "Alice", email: "alice@example.com" }),
    to_json: "[]",
    cc_json: "[]",
  };
}
