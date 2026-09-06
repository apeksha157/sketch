import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { fileVisibilityRuleSql } from "../db/repositories/file-visibility-rule";
import type { DB } from "../db/schema";
import {
  attachLinkedinCompanyContinuation,
  attachLinkedinCompanySlug,
} from "../entities/linkedin-company-continuation";
import { confirmReview, rejectReview } from "../entities/resolve";
import { createTestDb, createTestLogger } from "../test-utils";
import { AimfoxClient, type AimfoxConversation, type AimfoxLead } from "./aimfox-client";
import { buildLinkedinSegments, createLinkedinAimfoxConnector, orderLinkedinMessages } from "./linkedin-aimfox";
import { buildPersonSeed } from "./linkedin-aimfox-mappers";
import { resetRpmPacerForTests } from "./rpm-pacer";
import { runConnectorSync } from "./sync";
import { toEmailPrincipals } from "./types";

const HOUR_MS = 60 * 60 * 1000;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
}

describe("AimfoxClient", () => {
  it("lists accounts with bearer auth", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        status: "ok",
        accounts: [
          {
            id: "acct-1",
            urn: "urn:li:1",
            full_name: "Jane",
            public_identifier: "jane",
            picture_url: "",
            state: "active",
            disabled: false,
          },
        ],
      }),
    );

    const accounts = await new AimfoxClient("key", { fetchFn }).listAccounts();

    expect(accounts.map((account) => account.id)).toEqual(["acct-1"]);
    expect(fetchFn.mock.calls[0][0]).toBe("https://api.aimfox.com/api/v2/accounts");
    expect((fetchFn.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer key");
  });

  it("honors Retry-After on 429 before succeeding", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(jsonResponse({ status: "ok", accounts: [] }));
    const sleep = vi.fn(async () => {});

    await new AimfoxClient("key", { fetchFn, sleep }).listAccounts();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("surfaces upstream auth failures", async () => {
    const fetchFn = vi.fn(async () => new Response("revoked", { status: 401 }));

    await expect(new AimfoxClient("bad", { fetchFn }).listAccounts()).rejects.toMatchObject({
      status: 401,
    });
  });

  it("pages the workspace inbox with count and before, never in_app", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        status: "ok",
        conversations: [
          conversationFixture({ leadId: "lead-1", conversationUrn: "urn:conversation:1" }),
          { ...conversationFixture({ leadId: "lead-2", conversationUrn: "urn:conversation:2" }), owner: "acct-2" },
        ],
      }),
    );

    const conversations = await new AimfoxClient("key", { accountId: "acct-1", fetchFn }).listConversationsPage({
      before: 1_779_912_000_000,
      count: 500,
    });

    expect(conversations.map((conversation) => conversation.conversation_urn)).toEqual(["urn:conversation:1"]);
    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(`${url.origin}${url.pathname}`).toBe("https://api.aimfox.com/api/v2/conversations");
    expect(url.searchParams.has("in_app")).toBe(false);
    expect(url.searchParams.get("before")).toBe("1779912000000");
    expect(url.searchParams.get("count")).toBe("100");
  });

  it("reads the conversation urn from the renamed urn field", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ status: "ok", urn: "urn:conversation:renamed" }));

    await expect(new AimfoxClient("key", { accountId: "acct-1", fetchFn }).getConversationUrn("lead-1")).resolves.toBe(
      "urn:conversation:renamed",
    );
  });
});

describe("LinkedIn conversation segmentation", () => {
  it("orders equal-timestamp messages by stable message urn", () => {
    const ordered = orderLinkedinMessages("urn:conversation:stable", [
      { urn: "urn:message:z", body: "Zulu", sender: { id: "lead", full_name: "Lead" }, created_at: 1000 },
      { urn: "urn:message:a", body: "Alpha", sender: { id: "lead", full_name: "Lead" }, created_at: 1000 },
    ]);

    expect(ordered.map((message) => message.identity)).toEqual(["urn:message:a", "urn:message:z"]);
  });

  it("keeps sealed rollover boundaries when segment limits change", () => {
    const ordered = orderLinkedinMessages(
      "urn:conversation:stable",
      Array.from({ length: 5 }, (_, index) => ({
        urn: `urn:message:${index + 1}`,
        body: `Message ${index + 1}`,
        sender: { id: "lead", full_name: "Lead" },
        created_at: 1000 + index,
      })),
    );
    const initial = buildLinkedinSegments(ordered, [], { maxMessages: 2, maxTokens: 10_000, gapMs: 4 * HOUR_MS });
    const sealed = initial.filter((segment) => segment.manifest.sealed).map((segment) => segment.manifest);
    const changed = buildLinkedinSegments(ordered, sealed, { maxMessages: 3, maxTokens: 10_000, gapMs: 4 * HOUR_MS });

    expect(changed.map((segment) => segment.manifest)).toEqual(initial.map((segment) => segment.manifest));
  });

  it("cuts a new segment at the burst gap and replays sealed boundaries across algorithm versions", () => {
    const base = 1_779_900_000_000;
    const burstMessage = (urn: string, createdAt: number) => ({
      urn,
      body: `Body ${urn}`,
      sender: { id: "lead", full_name: "Lead" },
      created_at: createdAt,
    });
    const ordered = orderLinkedinMessages("urn:conversation:burst", [
      burstMessage("urn:message:undated", Number.NaN),
      burstMessage("urn:message:1", base),
      burstMessage("urn:message:2", base + 10 * 60 * 1000),
      burstMessage("urn:message:3", base + 5 * HOUR_MS),
      burstMessage("urn:message:4", base + 5 * HOUR_MS + 10 * 60 * 1000),
    ]);
    const identities = (segments: ReturnType<typeof buildLinkedinSegments>) =>
      segments.map((segment) => segment.messages.map((message) => message.identity));

    const initial = buildLinkedinSegments(ordered, [], { maxMessages: 50, maxTokens: 10_000, gapMs: 4 * HOUR_MS });

    expect(identities(initial)).toEqual([
      ["urn:message:1", "urn:message:2"],
      ["urn:message:3", "urn:message:4", "urn:message:undated"],
    ]);
    expect(initial.map((segment) => segment.manifest.sealed)).toEqual([true, false]);

    const legacySealed = { ...initial[0].manifest, algorithmVersion: 1 };
    const replayed = buildLinkedinSegments(ordered, [legacySealed], {
      maxMessages: 50,
      maxTokens: 10_000,
      gapMs: 10 * 24 * HOUR_MS,
    });

    expect(replayed[0].manifest).toEqual(legacySealed);
    expect(identities(replayed)).toEqual(identities(initial));
  });
});

describe("createLinkedinAimfoxConnector", () => {
  it("validates api-key credentials against listAccounts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        status: "ok",
        accounts: [
          {
            id: "acct-1",
            urn: "urn:li:1",
            full_name: "Jane",
            public_identifier: "jane",
            picture_url: "",
            state: "active",
            disabled: false,
          },
        ],
      }),
    );

    await expect(
      createLinkedinAimfoxConnector().validateCredentials({ type: "api_key", api_key: "key" }),
    ).resolves.toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("completes sync with no conversations", async () => {
    const db = await createTestDb();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ status: "ok", accounts: [], conversations: [] }));
    const connector = createLinkedinAimfoxConnector();
    const items = [];
    for await (const item of connector.sync({
      db,
      credentials: { type: "api_key", api_key: "key" },
      scopeConfig: { accountIds: ["acct-1"], maxRpm: 100_000 },
      cursor: null,
      logger: createTestLogger(),
      ownerEmail: "member@example.com",
    })) {
      items.push(item);
    }

    expect(items).toEqual([]);
    fetchSpy.mockRestore();
    await db.destroy();
  });

  it("retries the overlap boundary when a downstream item fails", async () => {
    const db = await createTestDb();
    mockLeadSync([leadFixture({ id: "lead-retry", fullName: "Retry Lead", publicIdentifier: "retry-lead" })]);
    const connector = createLinkedinAimfoxConnector();
    const syncOptions = {
      db,
      credentials: { type: "api_key" as const, api_key: "key" },
      scopeConfig: { accountIds: ["acct-1"], maxRpm: 100_000 },
      cursor: null,
      logger: createTestLogger(),
      ownerEmail: "member@example.com",
    };
    const first = [];
    for await (const item of connector.sync(syncOptions)) first.push(item);
    await connector.onItemResult?.({ item: first[0], persisted: true });
    await connector.onItemResult?.({ item: first[1], persisted: false, error: "write failed" });
    const cursor = await connector.getCursor({
      credentials: syncOptions.credentials,
      scopeConfig: syncOptions.scopeConfig,
      currentCursor: null,
      logger: syncOptions.logger,
    });
    const second = [];
    for await (const item of connector.sync({ ...syncOptions, cursor })) second.push(item);

    expect(JSON.parse(cursor ?? "{}").accounts["acct-1"]).toMatchObject({
      highWatermark: null,
      backfillBefore: "2026-05-27T20:00:00.001Z",
      backfillDone: false,
    });
    expect(second.map((item) => item.providerFileId)).toEqual(first.map((item) => item.providerFileId));
    await db.destroy();
  });
});

beforeEach(() => resetRpmPacerForTests());

describe("LinkedIn Aimfox conversation ingest", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("bridges a LinkedIn lead to an email-derived person by name and company domain", async () => {
    const { person, company } = await seedPersonAtCompany(db, {
      personName: "Bob Chen",
      email: "bob@acme.com",
      companyName: "Acme",
      domain: "acme.com",
    });
    mockLeadSync([
      leadFixture({
        id: "lead-1",
        fullName: "Robert Chen",
        publicIdentifier: "robert-chen",
        companyName: "Acme Inc.",
      }),
    ]);

    await drainSync(db);

    expect(await personCount(db)).toBe(1);
    const refs = await db
      .selectFrom("entity_source_refs")
      .select(["entity_id", "source", "source_id"])
      .where("source", "in", ["aimfox", "linkedin"])
      .where("source_id", "in", ["lead-1", "robert-chen"])
      .orderBy("source")
      .execute();
    expect(refs).toEqual([
      { entity_id: person.id, source: "aimfox", source_id: "lead-1" },
      { entity_id: person.id, source: "linkedin", source_id: "robert-chen" },
    ]);
    const contact = await db
      .selectFrom("entity_contact_points")
      .select(["entity_id", "kind", "value", "display_value"])
      .where("kind", "=", "linkedin")
      .executeTakeFirstOrThrow();
    expect(contact).toEqual({
      entity_id: person.id,
      kind: "linkedin",
      value: "robert-chen",
      display_value: "https://www.linkedin.com/in/robert-chen",
    });
    const companyRef = await db
      .selectFrom("entity_source_refs")
      .select("entity_id")
      .where("source", "=", "linkedin")
      .where("source_id", "=", "company:acme-inc")
      .executeTakeFirstOrThrow();
    expect(companyRef.entity_id).toBe(company.id);
  });

  it("uses a resolved company's real domain before falling back to a guessed domain", async () => {
    const { person } = await seedPersonAtCompany(db, {
      personName: "Bob Chen",
      email: "bob@acme.com",
      companyName: "Acme Technologies",
      domain: "acme.com",
    });
    mockLeadSync([
      leadFixture({
        id: "lead-real-domain",
        fullName: "Robert Chen",
        publicIdentifier: "real-domain-robert",
        companyName: "Acme Technologies LLC",
      }),
    ]);

    await drainSync(db);

    const ref = await db
      .selectFrom("entity_source_refs")
      .select("entity_id")
      .where("source", "=", "linkedin")
      .where("source_id", "=", "real-domain-robert")
      .executeTakeFirstOrThrow();
    expect(ref.entity_id).toBe(person.id);
    expect(await personCount(db)).toBe(1);
  });

  it("keeps LinkedIn sync idempotent across re-runs", async () => {
    const fetchSpy = mockLeadSync([
      leadFixture({
        id: "lead-idempotent",
        fullName: "Alice Smith",
        publicIdentifier: "alice-idempotent",
        email: "alice@example.com",
        phone: "+1 (415) 555-1234",
      }),
    ]);
    const config = await createLinkedinTestConfig(db);

    const first = await runLinkedinTestSync(db, config.id);
    const leadCallsAfterFirst = fetchSpy.mock.calls.filter((call) => String(call[0]).includes("/leads/")).length;
    const detailCallsAfterFirst = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes("/conversations/"),
    ).length;
    const second = await runLinkedinTestSync(db, config.id);

    expect(first).toMatchObject({ itemsProcessed: 2, itemsCreated: 2, itemsUpdated: 0, errors: [] });
    expect(second).toMatchObject({ itemsProcessed: 2, itemsCreated: 0, itemsUpdated: 0, errors: [] });
    expect(fetchSpy.mock.calls.filter((call) => String(call[0]).includes("/leads/"))).toHaveLength(
      leadCallsAfterFirst + 1,
    );
    expect(fetchSpy.mock.calls.filter((call) => String(call[0]).includes("/conversations/"))).toHaveLength(
      detailCallsAfterFirst + 1,
    );
    expect(await personCount(db)).toBe(1);
    expect(await db.selectFrom("indexed_files").select("id").execute()).toHaveLength(2);
    expect(await db.selectFrom("entity_contact_points").select("id").execute()).toHaveLength(3);
    const refs = await db
      .selectFrom("entity_source_refs")
      .select(["source", "source_id"])
      .where("source", "in", ["aimfox", "linkedin"])
      .orderBy("source")
      .execute();
    expect(refs).toEqual([
      { source: "aimfox", source_id: "lead-idempotent" },
      { source: "linkedin", source_id: "alice-idempotent" },
    ]);
  });

  it("picks up a newer conversation on incremental sync", async () => {
    const conversation = conversationFixture({
      leadId: "lead-reply",
      conversationUrn: "urn:conversation:reply",
      lastActivityAt: 1_779_912_000_000,
    });
    const messages = [
      messageFixture({ id: "msg-1", senderId: "lead-reply", senderName: "Alice Smith", body: "Hello" }),
      messageFixture({ id: "msg-2", senderId: "acct-1", senderName: "Member User", body: "Thanks" }),
    ];
    mockLeadSync([leadFixture({ id: "lead-reply", fullName: "Alice Smith", publicIdentifier: "alice-reply" })], {
      conversations: [conversation],
      messages: { "urn:conversation:reply": messages },
    });
    const config = await createLinkedinTestConfig(db);

    await runLinkedinTestSync(db, config.id);
    conversation.last_activity_at = 1_779_912_300_000;
    conversation.last_message = {
      body: "New reply",
      sender: { id: "lead-reply", full_name: "Alice Smith" },
      created_at: 1_779_912_300_000,
    };
    messages.push(
      messageFixture({
        id: "msg-3",
        senderId: "lead-reply",
        senderName: "Alice Smith",
        body: "New reply",
        createdAt: 1_779_912_300_000,
      }),
    );

    const second = await runLinkedinTestSync(db, config.id);

    expect(second).toMatchObject({ itemsProcessed: 2, itemsCreated: 0, itemsUpdated: 2, errors: [] });
    const files = await db
      .selectFrom("indexed_files")
      .select(["provider_file_id", "provider_message_id"])
      .orderBy("provider_file_id")
      .execute();
    expect(files.map((file) => file.provider_file_id)).toEqual([
      "linkedin:acct-1:profile:lead-reply",
      "linkedin:acct-1:urn:conversation:reply:segment-0",
    ]);
    const linkedin = await db
      .selectFrom("entity_contact_points")
      .select(["kind", "last_contacted_at"])
      .where("kind", "=", "linkedin")
      .executeTakeFirstOrThrow();
    expect(linkedin).toEqual({ kind: "linkedin", last_contacted_at: "2026-05-27T20:05:00.000Z" });
  });

  it("does not advance the cursor past a conversation that failed to fetch", async () => {
    const missingLeadIds = new Set(["lead-high"]);
    mockLeadSync(
      [
        leadFixture({ id: "lead-low", fullName: "Low Activity", publicIdentifier: "low-activity" }),
        leadFixture({ id: "lead-high", fullName: "High Activity", publicIdentifier: "high-activity" }),
      ],
      {
        conversations: [
          conversationFixture({
            leadId: "lead-high",
            conversationUrn: "urn:conversation:high",
            lastActivityAt: 1_779_912_300_000,
          }),
          conversationFixture({
            leadId: "lead-low",
            conversationUrn: "urn:conversation:low",
            lastActivityAt: 1_779_912_000_000,
          }),
        ],
        missingLeadIds,
      },
    );
    const config = await createLinkedinTestConfig(db);

    const first = await runLinkedinTestSync(db, config.id);
    missingLeadIds.clear();
    const second = await runLinkedinTestSync(db, config.id);

    expect(first).toMatchObject({ itemsProcessed: 2, itemsCreated: 2, itemsUpdated: 0, errors: [] });
    expect(second).toMatchObject({ itemsProcessed: 4, itemsCreated: 2, itemsUpdated: 0, errors: [] });
    const files = await db.selectFrom("indexed_files").select("provider_file_id").orderBy("provider_file_id").execute();
    const providerFileIds = files.map((file) => file.provider_file_id);
    expect(providerFileIds).toEqual([
      "linkedin:acct-1:profile:lead-high",
      "linkedin:acct-1:profile:lead-low",
      "linkedin:acct-1:urn:conversation:high:segment-0",
      "linkedin:acct-1:urn:conversation:low:segment-0",
    ]);
  });

  it("namespaces profile and message files across multiple Aimfox accounts", async () => {
    mockLeadSync([leadFixture({ id: "shared-lead", fullName: "Alice Smith", publicIdentifier: "alice-shared" })], {
      accountConversations: {
        "acct-1": [conversationFixture({ leadId: "shared-lead", conversationUrn: "urn:conversation:same" })],
        "acct-2": [conversationFixture({ leadId: "shared-lead", conversationUrn: "urn:conversation:same" })],
      },
      messages: {
        "acct-1:urn:conversation:same": [
          messageFixture({ id: "same-message", senderId: "shared-lead", senderName: "Alice Smith", body: "Hello" }),
        ],
        "acct-2:urn:conversation:same": [
          messageFixture({ id: "same-message", senderId: "shared-lead", senderName: "Alice Smith", body: "Hello" }),
        ],
      },
    });

    await drainSync(db, { accountIds: ["acct-1", "acct-2"] });

    const files = await db
      .selectFrom("indexed_files")
      .select(["provider_file_id", "provider_message_id"])
      .orderBy("provider_file_id")
      .execute();
    expect(files).toEqual([
      { provider_file_id: "linkedin:acct-1:profile:shared-lead", provider_message_id: null },
      { provider_file_id: "linkedin:acct-1:urn:conversation:same:segment-0", provider_message_id: null },
      { provider_file_id: "linkedin:acct-2:profile:shared-lead", provider_message_id: null },
      { provider_file_id: "linkedin:acct-2:urn:conversation:same:segment-0", provider_message_id: null },
    ]);
  });

  it("attaches by an existing LinkedIn source ref before creating a person", async () => {
    const entityRepo = createEntityRepository(db);
    const existing = await entityRepo.createPersonEntity({
      name: "Existing Alice",
      subtype: "external",
      source: "manual",
      sourceId: "manual-alice",
    });
    await entityRepo.upsertSourceRef({
      entityId: existing.id,
      source: "linkedin",
      sourceId: "alice-t0",
    });
    mockLeadSync([
      leadFixture({
        id: "lead-t0-source",
        fullName: "Alice Smith",
        publicIdentifier: "alice-t0",
      }),
    ]);

    await drainSync(db);

    expect(await personCount(db)).toBe(1);
    const ref = await db
      .selectFrom("entity_source_refs")
      .select("entity_id")
      .where("source", "=", "aimfox")
      .where("source_id", "=", "lead-t0-source")
      .executeTakeFirstOrThrow();
    expect(ref.entity_id).toBe(existing.id);
  });

  it("attaches by an existing LinkedIn contact point before creating a person", async () => {
    const entityRepo = createEntityRepository(db);
    const existing = await entityRepo.createPersonEntity({
      name: "Existing Alice",
      subtype: "external",
      source: "manual",
      sourceId: "manual-alice-contact",
    });
    await entityRepo.upsertContactPoint({
      entityId: existing.id,
      kind: "linkedin",
      value: "alice-contact-t0",
      source: "manual",
    });
    mockLeadSync([
      leadFixture({
        id: "lead-t0-contact",
        fullName: "Alice Smith",
        publicIdentifier: "alice-contact-t0",
      }),
    ]);

    await drainSync(db);

    expect(await personCount(db)).toBe(1);
    const ref = await db
      .selectFrom("entity_source_refs")
      .select("entity_id")
      .where("source", "=", "aimfox")
      .where("source_id", "=", "lead-t0-contact")
      .executeTakeFirstOrThrow();
    expect(ref.entity_id).toBe(existing.id);
  });

  it("queues ambiguous LinkedIn contact point matches without creating a new person", async () => {
    const entityRepo = createEntityRepository(db);
    const first = await entityRepo.createPersonEntity({
      name: "First Alice",
      subtype: "external",
      source: "manual",
      sourceId: "manual-first-alice",
    });
    const second = await entityRepo.createPersonEntity({
      name: "Second Alice",
      subtype: "external",
      source: "manual",
      sourceId: "manual-second-alice",
    });
    for (const entity of [first, second]) {
      await entityRepo.upsertContactPoint({
        entityId: entity.id,
        kind: "linkedin",
        value: "ambiguous-alice",
        source: "manual",
      });
    }
    mockLeadSync([
      leadFixture({
        id: "lead-ambiguous-t0",
        fullName: "Alice Smith",
        publicIdentifier: "ambiguous-alice",
      }),
    ]);

    await drainSync(db);

    expect(await personCount(db)).toBe(2);
    expect(
      await db.selectFrom("entity_source_refs").selectAll().where("source_id", "=", "lead-ambiguous-t0").execute(),
    ).toEqual([]);
    const review = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(review).toMatchObject({
      proposed_name: "Alice Smith",
      normalized_name: "alice smith",
      entity_type: "person",
      source: "aimfox",
      source_id: "lead-ambiguous-t0",
      seed_source: "linkedin",
      seed_source_id: "ambiguous-alice",
      candidate_entity_id: null,
      candidate_reason: "exact-ambiguous",
    });
    const evidence = await db
      .selectFrom("entity_review_evidence")
      .select(["source", "indexed_file_id"])
      .where("review_id", "=", review.id)
      .executeTakeFirstOrThrow();
    expect(evidence).toMatchObject({ source: "linkedin_aimfox", indexed_file_id: expect.any(String) });
  });

  it("replays Aimfox profile metadata and contact points after person review", async () => {
    const entityRepo = createEntityRepository(db);
    const candidates = [];
    for (const sourceId of ["review-first", "review-second"]) {
      const candidate = await entityRepo.createPersonEntity({
        name: sourceId,
        subtype: "external",
        source: "manual",
        sourceId,
      });
      await entityRepo.upsertContactPoint({
        entityId: candidate.id,
        kind: "linkedin",
        value: "reviewed-linkedin",
        source: "manual",
      });
      candidates.push(candidate);
    }
    mockLeadSync([
      leadFixture({
        id: "lead-reviewed",
        fullName: "Reviewed Person",
        publicIdentifier: "reviewed-linkedin",
        email: "reviewed@example.com",
        phone: "+1 (415) 555-1234",
      }),
    ]);
    await drainSync(db);
    const review = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();

    await confirmReview({ db, userId: "linkedin-test-user", logger: createTestLogger() }, review.id, {
      candidateGeneratedAt: review.candidate_generated_at as string,
      mergeIntoEntityId: candidates[0].id,
    });

    const resolved = await entityRepo.getEntity(candidates[0].id);
    const metadata = JSON.parse(resolved?.metadata ?? "{}");
    expect(metadata.linkedinAimfox.leads["lead-reviewed"].linkedinPublicIdentifier).toBe("reviewed-linkedin");
    const contacts = await db
      .selectFrom("entity_contact_points")
      .select(["kind", "value"])
      .where("entity_id", "=", candidates[0].id)
      .orderBy("kind")
      .execute();
    expect(contacts).toEqual([
      { kind: "email", value: "reviewed@example.com" },
      { kind: "linkedin", value: "reviewed-linkedin" },
      { kind: "phone", value: "+14155551234" },
    ]);
  });

  it("creates a net-new person when the LinkedIn cascade misses", async () => {
    mockLeadSync([
      leadFixture({
        id: "lead-new",
        fullName: "Net New",
        publicIdentifier: "net-new",
      }),
    ]);

    await drainSync(db);

    expect(await personCount(db)).toBe(1);
    const refs = await db
      .selectFrom("entity_source_refs")
      .select(["source", "source_id"])
      .where("source", "in", ["aimfox", "linkedin"])
      .orderBy("source")
      .execute();
    expect(refs).toEqual([
      { source: "aimfox", source_id: "lead-new" },
      { source: "linkedin", source_id: "net-new" },
    ]);
    const person = await db
      .selectFrom("entities")
      .select("metadata")
      .where("source_type", "=", "person")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(person.metadata ?? "{}").enrichmentCandidate).toBe(true);
  });

  it("queues ambiguous name-domain matches without picking a person", async () => {
    await seedPersonAtCompany(db, {
      personName: "Chris Lee",
      email: "chris.one@acme.com",
      companyName: "Acme",
      domain: "acme.com",
    });
    await seedPersonAtCompany(db, {
      personName: "Chris Lee",
      email: "chris.two@acme.com",
      companyName: "Acme",
      domain: "acme.com",
    });
    mockLeadSync([
      leadFixture({
        id: "lead-ambiguous",
        fullName: "Chris Lee",
        publicIdentifier: "chris-lee",
        companyName: "Acme Inc.",
      }),
    ]);

    await drainSync(db);

    expect(await personCount(db)).toBe(2);
    expect(
      await db.selectFrom("entity_source_refs").selectAll().where("source_id", "=", "chris-lee").execute(),
    ).toEqual([]);
    const review = await db.selectFrom("entity_review_queue").selectAll().executeTakeFirstOrThrow();
    expect(review).toMatchObject({
      proposed_name: "Chris Lee",
      normalized_name: "chris lee",
      entity_type: "person",
      candidate_entity_id: null,
      candidate_reason: "llm-ambiguous",
    });
  });

  it("does not bridge through bogus company strings", async () => {
    await createEntityRepository(db).createPersonEntity({
      name: "Robert Chen",
      email: "robert@gmail.com",
      subtype: "external",
      source: "gmail",
      sourceId: "gmail-robert",
    });
    mockLeadSync([
      leadFixture({
        id: "lead-self",
        fullName: "Robert Chen",
        publicIdentifier: "self-robert",
        companyName: "Self-Employed",
      }),
    ]);

    await drainSync(db);

    expect(await personCount(db)).toBe(2);
    const linked = await db
      .selectFrom("entity_source_refs")
      .select(["entity_id"])
      .where("source", "=", "linkedin")
      .where("source_id", "=", "self-robert")
      .executeTakeFirstOrThrow();
    const entity = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", linked.entity_id)
      .executeTakeFirstOrThrow();
    expect(entity.name).toBe("Robert Chen");
    expect(linked.entity_id).not.toBeUndefined();
  });

  it("normalizes LinkedIn, email, and E.164 phone contact points", async () => {
    mockLeadSync([
      leadFixture({
        id: "lead-contact",
        fullName: "Alice Smith",
        publicIdentifier: "Alice-Smith",
        email: "ALICE@EXAMPLE.COM",
        phone: "+1 (415) 555-1234",
      }),
    ]);

    await drainSync(db);

    const contacts = await db
      .selectFrom("entity_contact_points")
      .select(["kind", "value", "display_value"])
      .orderBy("kind")
      .execute();
    expect(contacts).toEqual([
      { kind: "email", value: "alice@example.com", display_value: null },
      { kind: "linkedin", value: "alice-smith", display_value: "https://www.linkedin.com/in/alice-smith" },
      { kind: "phone", value: "+14155551234", display_value: null },
    ]);
  });

  it("normalizes a national phone number using the provider country", async () => {
    mockLeadSync([
      leadFixture({
        id: "lead-gb-phone",
        fullName: "London Person",
        publicIdentifier: "london-person",
        phone: "020 7946 0018",
        phoneCountry: "gb",
      }),
    ]);

    await drainSync(db);

    const phone = await db
      .selectFrom("entity_contact_points")
      .select("value")
      .where("kind", "=", "phone")
      .executeTakeFirstOrThrow();
    expect(phone.value).toBe("+442079460018");
  });

  it("uses email exact match before name-domain matching", async () => {
    const entityRepo = createEntityRepository(db);
    const bob = await entityRepo.createPersonEntity({
      name: "Bob Chen",
      email: "bob@acme.com",
      subtype: "external",
      source: "gmail",
      sourceId: "gmail-bob",
    });
    await seedPersonAtCompany(db, {
      personName: "Robert Chen",
      email: "robert@acme.com",
      companyName: "Acme",
      domain: "acme.com",
    });
    mockLeadSync([
      leadFixture({
        id: "lead-email",
        fullName: "Robert Chen",
        publicIdentifier: "email-wins",
        companyName: "Acme Inc.",
        email: "BOB@ACME.COM",
      }),
    ]);

    await drainSync(db);

    const ref = await db
      .selectFrom("entity_source_refs")
      .select("entity_id")
      .where("source", "=", "linkedin")
      .where("source_id", "=", "email-wins")
      .executeTakeFirstOrThrow();
    expect(ref.entity_id).toBe(bob.id);
  });

  it("continues sync when one lead detail fetch fails", async () => {
    mockLeadSync(
      [
        leadFixture({ id: "lead-ok", fullName: "Alice Smith", publicIdentifier: "alice-smith" }),
        leadFixture({ id: "lead-missing", fullName: "Missing Lead", publicIdentifier: "missing-lead" }),
      ],
      {
        missingLeadIds: new Set(["lead-missing"]),
      },
    );

    await drainSync(db);

    expect(await personCount(db)).toBe(1);
    const config = await db
      .selectFrom("connector_configs")
      .select("sync_cursor")
      .where("connector_type", "=", "linkedin_aimfox")
      .executeTakeFirstOrThrow();
    expect(config.sync_cursor).toContain("2026-05-27T20:00:00.000Z");
  });

  it("walks the inbox one backfill budget per sync until it runs dry", async () => {
    const leads = [1, 2, 3].map((index) =>
      leadFixture({ id: `lead-${index}`, fullName: `Lead ${index}`, publicIdentifier: `lead-${index}` }),
    );
    const fetchSpy = mockLeadSync(leads, {
      conversations: leads.map((lead, index) =>
        conversationFixture({
          leadId: lead.id,
          conversationUrn: `urn:conversation:${index + 1}`,
          lastActivityAt: 1_779_912_000_000 + index * 60_000,
        }),
      ),
    });
    const config = await createLinkedinTestConfig(db, { backfillBudget: 2 });

    await runLinkedinTestSync(db, config.id);

    expect(await personCount(db)).toBe(2);
    expect(
      leadDetailUrls(fetchSpy)
        .map((url) => url.split("/leads/")[1])
        .sort(),
    ).toEqual(["lead-2", "lead-3"]);
    expect(await storedAccountCursor(db, config.id)).toMatchObject({
      highWatermark: "2026-05-27T20:02:00.000Z",
      backfillBefore: "2026-05-27T20:01:00.000Z",
      backfillDone: false,
    });

    const secondFrom = fetchSpy.mock.calls.length;
    await runLinkedinTestSync(db, config.id);

    expect(await personCount(db)).toBe(3);
    expect(
      leadDetailUrls(fetchSpy, secondFrom)
        .map((url) => url.split("/leads/")[1])
        .sort(),
    ).toEqual(["lead-1", "lead-3"]);
    expect(await storedAccountCursor(db, config.id)).toMatchObject({ backfillDone: true });

    const thirdFrom = fetchSpy.mock.calls.length;
    await runLinkedinTestSync(db, config.id);

    expect(leadDetailUrls(fetchSpy, thirdFrom).map((url) => url.split("/leads/")[1])).toEqual(["lead-3"]);
  });

  it("runs the incremental and backfill passes in one sync without double-processing a thread", async () => {
    const old = conversationFixture({
      leadId: "lead-old",
      conversationUrn: "urn:conversation:old",
      lastActivityAt: 1_779_912_000_000,
    });
    const recent = conversationFixture({
      leadId: "lead-recent",
      conversationUrn: "urn:conversation:recent",
      lastActivityAt: 1_779_912_300_000,
    });
    const recentMessages = [
      messageFixture({ id: "r-1", senderId: "lead-recent", senderName: "Recent Lead", body: "Hello" }),
      messageFixture({
        id: "r-2",
        senderId: "acct-1",
        senderName: "Member User",
        body: "Thanks",
        createdAt: 1_779_912_300_000,
      }),
    ];
    const fetchSpy = mockLeadSync(
      [
        leadFixture({ id: "lead-old", fullName: "Old Lead", publicIdentifier: "old-lead" }),
        leadFixture({ id: "lead-recent", fullName: "Recent Lead", publicIdentifier: "recent-lead" }),
      ],
      { conversations: [old, recent], messages: { "urn:conversation:recent": recentMessages } },
    );
    const config = await createLinkedinTestConfig(db, { backfillBudget: 1 });

    const first = await runLinkedinTestSync(db, config.id);

    expect(first).toMatchObject({ itemsCreated: 2, errors: [] });
    expect(await personCount(db)).toBe(1);

    recent.last_activity_at = 1_779_912_600_000;
    recentMessages.push(
      messageFixture({
        id: "r-3",
        senderId: "lead-recent",
        senderName: "Recent Lead",
        body: "New reply",
        createdAt: 1_779_912_600_000,
      }),
    );
    const secondFrom = fetchSpy.mock.calls.length;
    const second = await runLinkedinTestSync(db, config.id);

    expect(second).toMatchObject({ itemsProcessed: 4, itemsCreated: 2, itemsUpdated: 2, errors: [] });
    expect(await personCount(db)).toBe(2);
    expect(
      leadDetailUrls(fetchSpy, secondFrom)
        .map((url) => url.split("/leads/")[1])
        .sort(),
    ).toEqual(["lead-old", "lead-recent"]);
  });

  it("gives up on a thread that fails every run so the backfill can descend past it", async () => {
    const missingLeadIds = new Set(["lead-dead"]);
    mockLeadSync(
      [
        leadFixture({ id: "lead-live", fullName: "Live Lead", publicIdentifier: "live-lead" }),
        leadFixture({ id: "lead-dead", fullName: "Dead Lead", publicIdentifier: "dead-lead" }),
      ],
      {
        conversations: [
          conversationFixture({
            leadId: "lead-live",
            conversationUrn: "urn:conversation:live",
            lastActivityAt: 1_779_912_300_000,
          }),
          conversationFixture({
            leadId: "lead-dead",
            conversationUrn: "urn:conversation:dead",
            lastActivityAt: 1_779_912_000_000,
          }),
        ],
        missingLeadIds,
      },
    );
    const config = await createLinkedinTestConfig(db);

    await runLinkedinTestSync(db, config.id);
    expect(await storedAccountCursor(db, config.id)).toMatchObject({
      highWatermark: "2026-05-27T20:05:00.000Z",
      backfillBefore: "2026-05-27T20:00:00.001Z",
      backfillDone: false,
      backfillStalls: 0,
    });

    await runLinkedinTestSync(db, config.id);
    await runLinkedinTestSync(db, config.id);
    expect(await storedAccountCursor(db, config.id)).toMatchObject({ backfillDone: false, backfillStalls: 2 });

    await runLinkedinTestSync(db, config.id);
    expect(await storedAccountCursor(db, config.id)).toMatchObject({
      backfillBefore: "2026-05-27T20:00:00.000Z",
      backfillDone: true,
      backfillStalls: 0,
    });
    expect(await personCount(db)).toBe(1);
  });

  it("stores last_contacted_at from conversation recency", async () => {
    mockLeadSync(
      [
        leadFixture({
          id: "lead-recency",
          fullName: "Alice Smith",
          publicIdentifier: "alice-recency",
          email: "alice@example.com",
          phone: "+1 (415) 555-1234",
        }),
      ],
      {
        conversations: [
          conversationFixture({
            leadId: "lead-recency",
            conversationUrn: "urn:conversation:recency",
            lastActivityAt: 1_779_912_000_000,
          }),
        ],
      },
    );

    await drainSync(db);

    const contacts = await db
      .selectFrom("entity_contact_points")
      .select(["kind", "last_contacted_at"])
      .where("kind", "in", ["email", "linkedin"])
      .orderBy("kind")
      .execute();
    expect(contacts).toEqual([
      { kind: "email", last_contacted_at: null },
      { kind: "linkedin", last_contacted_at: "2026-05-27T20:00:00.000Z" },
    ]);
    const phone = await db
      .selectFrom("entity_contact_points")
      .select(["kind", "last_contacted_at"])
      .where("kind", "=", "phone")
      .executeTakeFirstOrThrow();
    expect(phone).toEqual({ kind: "phone", last_contacted_at: null });
  });

  it("yields private profile and message files", async () => {
    mockLeadSync(
      [
        leadFixture({
          id: "lead-thread",
          fullName: "Alice Smith",
          publicIdentifier: "alice-thread",
          email: "alice@example.com",
        }),
      ],
      {
        conversations: [
          conversationFixture({
            leadId: "lead-thread",
            conversationUrn: "urn:conversation:thread",
            lastActivityAt: 1_779_912_000_000,
          }),
        ],
      },
    );

    const items = await collectSyncItems(db);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      providerFileId: "linkedin:acct-1:profile:lead-thread",
      fileName: "LinkedIn profile - Alice Smith",
      fileType: "linkedin_profile",
      contentCategory: "structured",
      rollupGroupId: "linkedin:acct-1:profile:lead-thread",
      accessPrincipals: [{ type: "email", value: "member@example.com" }],
    });
    expect(items[0].contactPoints?.find((point) => point.kind === "linkedin")).toMatchObject({
      value: "alice-thread",
      lastContactedAt: "2026-05-27T20:00:00.000Z",
    });
    expect(items[1]).toMatchObject({
      providerFileId: "linkedin:acct-1:urn:conversation:thread:segment-0",
      threadId: "acct-1:urn:conversation:thread",
      fileName: "LinkedIn: Member User <> Alice Smith · 2026-05-27",
      fileType: "linkedin_conversation",
      contentCategory: "document",
      sourceCreatedAt: "2026-05-27T19:55:00.000Z",
      sourceUpdatedAt: "2026-05-27T20:00:00.000Z",
      rollupGroupId: "linkedin:acct-1:profile:lead-thread",
      accessPrincipals: [{ type: "email", value: "member@example.com" }],
    });
    expect(items[1].content).toBe(
      [
        "LinkedIn conversation: Member User <> Alice Smith",
        "",
        "Transcript:",
        "[2026-05-27 19:55] Alice Smith: Hello",
        "[2026-05-27 20:00] Member User: Thanks",
      ].join("\n"),
    );
    expect(items[1].contactPoints).toBeUndefined();
  });

  it("yields unrestricted profile and message files in workspace visibility mode", async () => {
    mockLeadSync(
      [
        leadFixture({
          id: "lead-workspace",
          fullName: "Workspace Lead",
          publicIdentifier: "workspace-lead",
        }),
      ],
      {
        conversations: [
          conversationFixture({
            leadId: "lead-workspace",
            conversationUrn: "urn:conversation:workspace",
          }),
        ],
      },
    );

    const items = await collectSyncItems(db, { visibility: "workspace" });

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.accessPrincipals)).toEqual([[], []]);
  });

  it("workspace-mode sync clears a stale LinkedIn file grant on a re-listed file", async () => {
    mockLeadSync([leadFixture({ id: "lead-stale", fullName: "Stale Lead", publicIdentifier: "stale-lead" })]);
    const config = await createLinkedinTestConfig(db, { visibility: "workspace" });

    await runLinkedinTestSync(db, config.id);
    const fileIds = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("connector_config_id", "=", config.id)
      .execute();
    await db
      .insertInto("file_access")
      .values(
        fileIds.map((file) => ({
          indexed_file_id: file.id,
          principal_type: "email" as const,
          principal_value: "member@example.com",
        })),
      )
      .execute();

    await runLinkedinTestSync(db, config.id);

    expect(await db.selectFrom("file_access").selectAll().execute()).toEqual([]);
  });

  it("lets a non-owner public-MCP principal see LinkedIn files only in workspace mode", async () => {
    mockLeadSync([leadFixture({ id: "lead-public", fullName: "Public Lead", publicIdentifier: "public-lead" })]);
    const config = await createLinkedinTestConfig(db);

    await runLinkedinTestSync(db, config.id);
    expect(await visibleLinkedinProviderFileIds(db, "other@example.com")).toEqual([]);
    expect(await visibleLinkedinProviderFileIds(db, "member@example.com")).toEqual([
      "linkedin:acct-1:profile:lead-public",
      "linkedin:acct-1:urn:conversation:1:segment-0",
    ]);

    await createConnectorRepository(db).updateConfig(config.id, {
      scopeConfig: JSON.stringify({ accountIds: ["acct-1"], maxRpm: 100_000, visibility: "workspace" }),
    });
    await runLinkedinTestSync(db, config.id);

    expect(await visibleLinkedinProviderFileIds(db, "other@example.com")).toEqual([
      "linkedin:acct-1:profile:lead-public",
      "linkedin:acct-1:urn:conversation:1:segment-0",
    ]);
  });

  it.each(["owner", "workspace"] as const)(
    "confirming LinkedIn review evidence leaves %s-mode grants unchanged",
    async (visibility) => {
      const { fileId, review, expectedGrants } = await seedLinkedinEvidenceReview(db, visibility, "confirm");

      await confirmReview({ db, userId: "linkedin-test-user", logger: createTestLogger() }, review.row.id, {
        candidateGeneratedAt: review.row.candidate_generated_at as string,
      });

      expect(await grantRowsForFile(db, fileId)).toEqual(expectedGrants);
    },
  );

  it.each(["owner", "workspace"] as const)(
    "rejecting LinkedIn review evidence leaves %s-mode grants unchanged",
    async (visibility) => {
      const { fileId, review, expectedGrants } = await seedLinkedinEvidenceReview(db, visibility, "reject");

      await rejectReview({ db, userId: "linkedin-test-user", logger: createTestLogger() }, review.row.id, {
        candidateGeneratedAt: review.row.candidate_generated_at as string,
      });

      expect(await grantRowsForFile(db, fileId)).toEqual(expectedGrants);
    },
  );

  it("retains and labels automated campaign messages", async () => {
    mockLeadSync(
      [leadFixture({ id: "lead-automated", fullName: "Campaign Lead", publicIdentifier: "campaign-lead" })],
      {
        messages: {
          "urn:conversation:1": [
            messageFixture({
              id: "automated-message",
              senderId: "acct-1",
              senderName: "Member User",
              body: "Automated outreach",
              automated: true,
            }),
            messageFixture({
              id: "reply",
              senderId: "lead-automated",
              senderName: "Campaign Lead",
              body: "Interested",
              createdAt: 1_779_912_000_000,
            }),
          ],
        },
      },
    );

    const items = await collectSyncItems(db);

    expect(items[1].content).toContain("[2026-05-27 19:55] Member User (automated): Automated outreach");
    expect(items[1].content).toContain("[2026-05-27 20:00] Campaign Lead: Interested");
  });

  it("skips a thread until the lead replies, without holding the cursor", async () => {
    const quiet = conversationFixture({
      leadId: "lead-quiet",
      conversationUrn: "urn:conversation:quiet",
      lastActivityAt: 1_779_912_300_000,
    });
    const quietMessages = [
      messageFixture({ id: "out-1", senderId: "acct-1", senderName: "Member User", body: "Hi there", automated: true }),
      messageFixture({
        id: "out-2",
        senderId: "acct-1",
        senderName: "Member User",
        body: "Following up",
        createdAt: 1_779_912_300_000,
      }),
    ];
    mockLeadSync(
      [
        leadFixture({
          id: "lead-quiet",
          fullName: "Quiet Lead",
          publicIdentifier: "quiet-lead",
          companyName: "Quiet Co",
        }),
        leadFixture({ id: "lead-talk", fullName: "Talking Lead", publicIdentifier: "talking-lead" }),
      ],
      {
        conversations: [
          quiet,
          conversationFixture({
            leadId: "lead-talk",
            conversationUrn: "urn:conversation:talk",
            lastActivityAt: 1_779_912_000_000,
          }),
        ],
        messages: { "urn:conversation:quiet": quietMessages },
      },
    );
    const config = await createLinkedinTestConfig(db);

    const first = await runLinkedinTestSync(db, config.id);

    expect(first).toMatchObject({ itemsProcessed: 2, itemsCreated: 2, errors: [] });
    const providerFileIds = async () =>
      (await db.selectFrom("indexed_files").select("provider_file_id").orderBy("provider_file_id").execute()).map(
        (file) => file.provider_file_id,
      );
    expect(await providerFileIds()).toEqual([
      "linkedin:acct-1:profile:lead-talk",
      "linkedin:acct-1:urn:conversation:talk:segment-0",
    ]);
    expect(await personCount(db)).toBe(1);
    await expect(
      db
        .selectFrom("entities")
        .select("id")
        .where("source_type", "=", "company")
        .where("name", "=", "Quiet Co")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    const stored = await db
      .selectFrom("connector_configs")
      .select("sync_cursor")
      .where("id", "=", config.id)
      .executeTakeFirstOrThrow();
    expect(stored.sync_cursor).toContain("2026-05-27T20:05:00.000Z");

    quiet.last_activity_at = 1_779_912_600_000;
    quietMessages.push(
      messageFixture({
        id: "in-1",
        senderId: "lead-quiet",
        senderName: "Quiet Lead",
        body: "Sure, let's talk",
        createdAt: 1_779_912_600_000,
      }),
    );

    const second = await runLinkedinTestSync(db, config.id);

    expect(second).toMatchObject({ itemsProcessed: 2, itemsCreated: 2, errors: [] });
    expect(await providerFileIds()).toEqual([
      "linkedin:acct-1:profile:lead-quiet",
      "linkedin:acct-1:profile:lead-talk",
      "linkedin:acct-1:urn:conversation:quiet:segment-0",
      "linkedin:acct-1:urn:conversation:talk:segment-0",
    ]);
    expect(await personCount(db)).toBe(2);
  });

  it("warns when every listed LinkedIn thread is unanswered and nothing persists", async () => {
    mockLeadSync(
      [
        leadFixture({ id: "lead-quiet-1", fullName: "Quiet One", publicIdentifier: "quiet-one" }),
        leadFixture({ id: "lead-quiet-2", fullName: "Quiet Two", publicIdentifier: "quiet-two" }),
      ],
      {
        messages: {
          "urn:conversation:1": [
            messageFixture({ id: "out-1", senderId: "acct-1", senderName: "Member User", body: "Hi one" }),
          ],
          "urn:conversation:2": [
            messageFixture({ id: "out-2", senderId: "acct-1", senderName: "Member User", body: "Hi two" }),
          ],
        },
      },
    );
    const config = await createLinkedinTestConfig(db);
    const { logger, warn } = createSpyingLogger();

    await runConnectorSync(db, config.id, logger);

    const persistedNothing = warn.mock.calls.find(
      (call) => call[1] === "LinkedIn sync walked 2 threads and persisted nothing",
    );
    expect(persistedNothing?.[0]).toMatchObject({ threadsListed: 2, threadsSkippedNoReply: 2 });
  });

  it("does not warn on an unchanged LinkedIn overlap re-run", async () => {
    mockLeadSync([
      leadFixture({ id: "lead-unchanged", fullName: "Unchanged Lead", publicIdentifier: "unchanged-lead" }),
    ]);
    const config = await createLinkedinTestConfig(db);
    const { logger, warn } = createSpyingLogger();

    await runConnectorSync(db, config.id, logger);
    warn.mockClear();
    await runConnectorSync(db, config.id, logger);

    expect(warn.mock.calls.some((call) => String(call[1]).includes("persisted nothing"))).toBe(false);
  });

  it("keeps persisted file grants isolated to each connector owner", async () => {
    mockLeadSync([leadFixture({ id: "lead-private", fullName: "Private Lead", publicIdentifier: "private-lead" })]);
    const first = await createLinkedinTestConfig(db);
    await db
      .insertInto("users")
      .values({
        id: "linkedin-second-user",
        name: "Second Member",
        email: "second@example.com",
        email_verified_at: new Date().toISOString(),
        password_hash: "hash",
        auth_role: "member",
      })
      .execute();
    const second = await createConnectorRepository(db).createConfig({
      connectorType: "linkedin_aimfox",
      authType: "api_key",
      credentials: JSON.stringify({ type: "api_key", api_key: "key" }),
      scopeConfig: JSON.stringify({ accountIds: ["acct-1"] }),
      createdBy: "linkedin-second-user",
    });

    await runLinkedinTestSync(db, first.id);
    await runLinkedinTestSync(db, second.id);

    const grants = await db
      .selectFrom("indexed_files")
      .innerJoin("file_access", "file_access.indexed_file_id", "indexed_files.id")
      .select(["indexed_files.connector_config_id", "file_access.principal_value"])
      .orderBy("indexed_files.connector_config_id")
      .orderBy("file_access.principal_value")
      .execute();
    expect(grants.filter((grant) => grant.connector_config_id === first.id)).toEqual([
      { connector_config_id: first.id, principal_value: "member@example.com" },
      { connector_config_id: first.id, principal_value: "member@example.com" },
    ]);
    expect(grants.filter((grant) => grant.connector_config_id === second.id)).toEqual([
      { connector_config_id: second.id, principal_value: "second@example.com" },
      { connector_config_id: second.id, principal_value: "second@example.com" },
    ]);
  });

  it("mints a domainless company only after conversation engagement", async () => {
    const lead = leadFixture({
      id: "lead-signal",
      fullName: "Signal Person",
      publicIdentifier: "signal-person",
      companyName: "Signal Labs",
    });
    expect(buildPersonSeed(lead)?.currentCompanyWebsiteDomains).toEqual([]);
    mockLeadSync([lead]);

    await drainSync(db);

    const company = await db
      .selectFrom("entities")
      .select(["id", "name"])
      .where("source_type", "=", "company")
      .where("name", "=", "Signal Labs")
      .executeTakeFirstOrThrow();
    const slugRef = await db
      .selectFrom("entity_source_refs")
      .select("entity_id")
      .where("source", "=", "linkedin")
      .where("source_id", "=", "company:signal-labs")
      .executeTakeFirstOrThrow();
    expect(slugRef.entity_id).toBe(company.id);
    expect(await db.selectFrom("entity_domains").select("id").where("entity_id", "=", company.id).execute()).toEqual(
      [],
    );
    await expect(
      db
        .selectFrom("entity_relationships")
        .select("id")
        .where("target_entity_id", "=", company.id)
        .where("relationship_type", "=", "works_at")
        .executeTakeFirst(),
    ).resolves.toBeDefined();
  });

  it("attaches a verified profile website as the authoritative company domain", async () => {
    mockLeadSync([
      leadFixture({
        id: "lead-domain-signal",
        fullName: "Domain Person",
        publicIdentifier: "domain-person",
        companyName: "Northstar",
        websites: ["https://www.northstar.com/about"],
      }),
    ]);

    await drainSync(db);

    const domain = await db
      .selectFrom("entity_domains")
      .innerJoin("entities", "entities.id", "entity_domains.entity_id")
      .select(["entity_domains.domain", "entity_domains.kind", "entity_domains.source", "entities.name"])
      .where("entity_domains.domain", "=", "northstar.com")
      .executeTakeFirstOrThrow();
    expect(domain).toEqual({ domain: "northstar.com", kind: "corporate", source: "linkedin", name: "Northstar" });
  });

  it("never repoints a LinkedIn company slug ref", async () => {
    const repo = createEntityRepository(db);
    const first = await repo.upsertEntityFromTool({
      name: "First Company",
      sourceType: "company",
      source: "test",
      sourceId: "first-company",
    });
    const second = await repo.upsertEntityFromTool({
      name: "Second Company",
      sourceType: "company",
      source: "test",
      sourceId: "second-company",
    });

    await expect(
      attachLinkedinCompanySlug(db, { companyEntityId: first.id, slug: "shared-slug", linkedinUrl: null }),
    ).resolves.toBe("inserted");
    await expect(
      attachLinkedinCompanySlug(db, { companyEntityId: second.id, slug: "shared-slug", linkedinUrl: null }),
    ).resolves.toBe("conflict");
    expect((await repo.getEntityBySourceRef("linkedin", "company:shared-slug"))?.id).toBe(first.id);
  });

  it("finalizes queued company work without stealing a conflicting domain", async () => {
    mockLeadSync([
      leadFixture({ id: "lead-continuation", fullName: "Queued Person", publicIdentifier: "queued-person" }),
    ]);
    await drainSync(db);
    const person = await db
      .selectFrom("entities")
      .select("id")
      .where("source_type", "=", "person")
      .executeTakeFirstOrThrow();
    const file = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("file_type", "=", "linkedin_profile")
      .executeTakeFirstOrThrow();
    const entityRepo = createEntityRepository(db);
    const domainOwner = await entityRepo.upsertEntityFromTool({
      name: "Domain Owner",
      sourceType: "company",
      source: "test",
      sourceId: "domain-owner",
    });
    const target = await entityRepo.upsertEntityFromTool({
      name: "Queued Company",
      sourceType: "company",
      source: "test",
      sourceId: "queued-company",
    });
    await createEntityDomainsRepository(db).upsertAuthoritativeCorporateDomain({
      entityId: domainOwner.id,
      domain: "claimed.com",
      source: "manual",
      isPrimary: true,
    });
    const reviewRepo = createEntityReviewRepo(db);
    const review = await reviewRepo.upsertQueueRow({
      proposedName: "Queued Company",
      normalizedName: "queued company",
      entityType: "company",
      source: "linkedin_company_signal",
      sourceId: "company:queued-company",
      sourceScoped: true,
      candidateEntityId: target.id,
      candidateScore: 1,
      candidateReason: "exact",
      triggeredByUserId: "linkedin-test-user",
      evidenceIndexedFileIds: [file.id],
    });
    await reviewRepo.upsertEvidence({
      reviewId: review.row.id,
      indexedFileId: file.id,
      source: "linkedin_aimfox",
      note: "queued company continuation",
    });
    await attachLinkedinCompanyContinuation(db, {
      reviewId: review.row.id,
      companyName: "Queued Company",
      personEntityId: person.id,
      companySlug: "queued-company",
      companyDomain: "claimed.com",
      companyLinkedinUrl: "https://www.linkedin.com/company/queued-company",
      evidenceFileId: file.id,
    });

    await confirmReview({ db, userId: "linkedin-test-user", logger: createTestLogger() }, review.row.id, {
      candidateGeneratedAt: review.row.candidate_generated_at as string,
    });

    const domain = await db
      .selectFrom("entity_domains")
      .select("entity_id")
      .where("domain", "=", "claimed.com")
      .executeTakeFirstOrThrow();
    expect(domain.entity_id).toBe(domainOwner.id);
    expect((await entityRepo.getEntityBySourceRef("linkedin", "company:queued-company"))?.id).toBe(target.id);
    await expect(
      db
        .selectFrom("entity_relationships")
        .select("id")
        .where("source_entity_id", "=", person.id)
        .where("target_entity_id", "=", target.id)
        .where("relationship_type", "=", "works_at")
        .executeTakeFirst(),
    ).resolves.toBeDefined();
  });
});

function mockLeadSync(
  leads: AimfoxLead[],
  opts?: {
    missingLeadIds?: Set<string>;
    conversations?: ReturnType<typeof conversationFixture>[];
    accountConversations?: Record<string, ReturnType<typeof conversationFixture>[]>;
    messages?: Record<string, AimfoxConversation["messages"]>;
  },
) {
  const byId = new Map(leads.map((lead) => [lead.id, lead]));
  const conversations =
    opts?.conversations ??
    leads.map((lead, index) =>
      conversationFixture({
        leadId: lead.id,
        conversationUrn: `urn:conversation:${index + 1}`,
      }),
    );
  const conversationsForAccount = (accountId: string) => opts?.accountConversations?.[accountId] ?? conversations;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (/\/accounts$/.test(url)) {
      return jsonResponse({ status: "ok", accounts: [{ id: "acct-1", full_name: "Member User" }] });
    }
    if (url.includes("/conversations?")) {
      const workspaceConversations = opts?.accountConversations
        ? Object.entries(opts.accountConversations).flatMap(([accountId, accountConversations]) =>
            accountConversations.map((conversation) => ({ ...conversation, owner: accountId })),
          )
        : conversationsForAccount("acct-1").map((conversation) => ({ ...conversation, owner: "acct-1" }));
      const params = new URL(url).searchParams;
      const before = Number(params.get("before"));
      const count = Number(params.get("count")) || 15;
      const page = workspaceConversations
        .filter((conversation) => conversation.last_activity_at === null || conversation.last_activity_at < before)
        .sort((left, right) => (right.last_activity_at ?? 0) - (left.last_activity_at ?? 0))
        .slice(0, count);
      return jsonResponse({ status: "ok", conversations: page });
    }
    const conversationMatch = url.match(/\/accounts\/([^/]+)\/conversations\/(.+)$/);
    if (conversationMatch) {
      const accountId = decodeURIComponent(conversationMatch[1]);
      const conversationUrn = decodeURIComponent(conversationMatch[2]);
      const accountConversations = conversationsForAccount(accountId);
      const leadId = accountConversations.find((conversation) => conversation.conversation_urn === conversationUrn)
        ?.participants[0]?.id;
      const messages = opts?.messages?.[`${accountId}:${conversationUrn}`] ?? opts?.messages?.[conversationUrn];
      return jsonResponse({
        status: "ok",
        messages: messages ?? [
          messageFixture({ senderId: leadId ?? "lead", senderName: "Alice Smith", body: "Hello" }),
          messageFixture({
            senderId: accountId,
            senderName: "Member User",
            body: "Thanks",
            createdAt: 1_779_912_000_000,
          }),
        ],
      });
    }
    const id = decodeURIComponent(url.split("/leads/")[1] ?? "");
    const lead = byId.get(id);
    if (!lead || opts?.missingLeadIds?.has(id)) return new Response("missing", { status: 404 });
    return jsonResponse({ status: "ok", lead });
  });
}

function messageFixture(input: {
  id?: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt?: number;
  automated?: boolean;
}): AimfoxConversation["messages"][number] {
  return {
    id: input.id,
    body: input.body,
    sender: { id: input.senderId, full_name: input.senderName },
    created_at: input.createdAt ?? 1_779_911_700_000,
    automated: input.automated,
  };
}

async function collectSyncItems(db: Kysely<DB>, opts?: { visibility?: "owner" | "workspace" }) {
  const connector = createLinkedinAimfoxConnector();
  const items = [];
  for await (const item of connector.sync({
    db,
    credentials: { type: "api_key", api_key: "key" },
    scopeConfig: {
      accountIds: ["acct-1"],
      maxRpm: 100_000,
      ...(opts?.visibility ? { visibility: opts.visibility } : {}),
    },
    cursor: null,
    logger: createTestLogger(),
    ownerEmail: "member@example.com",
  })) {
    items.push(item);
  }
  return items;
}

async function drainSync(
  db: Kysely<DB>,
  opts?: { backfillBudget?: number; accountIds?: string[]; visibility?: "owner" | "workspace" },
) {
  const config = await createLinkedinTestConfig(db, opts);
  const result = await runLinkedinTestSync(db, config.id);
  return {
    ...result,
    errors: result.errors.map((error) => ({ itemId: error.fileId, error: error.error })),
  };
}

async function ensureLinkedinTestUser(db: Kysely<DB>): Promise<void> {
  const existing = await db.selectFrom("users").select("id").where("id", "=", "linkedin-test-user").executeTakeFirst();
  if (existing) return;
  await db
    .insertInto("users")
    .values({
      id: "linkedin-test-user",
      name: "Member User",
      email: "member@example.com",
      email_verified_at: new Date().toISOString(),
      password_hash: "hash",
      auth_role: "member",
    })
    .execute();
}

async function createLinkedinTestConfig(
  db: Kysely<DB>,
  opts?: { accountIds?: string[]; backfillBudget?: number; visibility?: "owner" | "workspace" },
) {
  await ensureLinkedinTestUser(db);
  return createConnectorRepository(db).createConfig({
    connectorType: "linkedin_aimfox",
    authType: "api_key",
    credentials: JSON.stringify({ type: "api_key", api_key: "key" }),
    scopeConfig: JSON.stringify({
      accountIds: opts?.accountIds ?? ["acct-1"],
      maxRpm: 100_000,
      ...(opts?.backfillBudget ? { backfillBudget: opts.backfillBudget } : {}),
      ...(opts?.visibility ? { visibility: opts.visibility } : {}),
    }),
    createdBy: "linkedin-test-user",
  });
}

async function runLinkedinTestSync(db: Kysely<DB>, configId: string) {
  return runConnectorSync(db, configId, createTestLogger());
}

function createSpyingLogger() {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as ReturnType<typeof createTestLogger>;
  return { logger, warn: logger.warn as unknown as ReturnType<typeof vi.fn> };
}

async function storedAccountCursor(db: Kysely<DB>, configId: string) {
  const row = await db
    .selectFrom("connector_configs")
    .select("sync_cursor")
    .where("id", "=", configId)
    .executeTakeFirstOrThrow();
  return JSON.parse(row.sync_cursor ?? "{}").accounts?.["acct-1"] ?? null;
}

async function seedLinkedinEvidenceReview(db: Kysely<DB>, visibility: "owner" | "workspace", suffix: string) {
  const config = await createLinkedinTestConfig(db, { visibility });
  const fileId = `linkedin-review-${visibility}-${suffix}`;
  const now = new Date().toISOString();
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: config.id,
      provider_file_id: `linkedin:acct-1:profile:${suffix}-${visibility}`,
      file_name: `LinkedIn profile - ${suffix}`,
      file_type: "linkedin_profile",
      content_category: "structured",
      content: "{}",
      content_hash: `hash-${fileId}`,
      source: "linkedin_aimfox",
      source_updated_at: now,
      synced_at: now,
    })
    .execute();

  const expectedGrants =
    visibility === "owner" ? [{ principal_type: "email" as const, principal_value: "member@example.com" }] : [];
  if (expectedGrants.length > 0) {
    await db
      .insertInto("file_access")
      .values({ indexed_file_id: fileId, ...expectedGrants[0] })
      .execute();
  }

  const entityRepo = createEntityRepository(db);
  const target = await entityRepo.upsertPersonEntity({
    name: "Reviewed Target",
    email: "reviewed-target@example.com",
    subtype: "external",
    source: "seed",
    sourceId: `reviewed-target-${visibility}-${suffix}`,
  });
  const reviewRepo = createEntityReviewRepo(db);
  const review = await reviewRepo.upsertQueueRow({
    proposedName: "Reviewed Target Alias",
    normalizedName: "reviewed target alias",
    entityType: "person",
    source: "linkedin_aimfox",
    sourceId: `review-${visibility}-${suffix}`,
    sourceScoped: true,
    proposedEmail: "reviewed-target@example.com",
    candidateEntityId: target.id,
    candidateScore: 1,
    candidateReason: "exact",
    triggeredByUserId: "linkedin-test-user",
    evidenceIndexedFileIds: [fileId],
  });
  await reviewRepo.upsertEvidence({
    reviewId: review.row.id,
    indexedFileId: fileId,
    source: "linkedin_aimfox",
    note: "LinkedIn evidence",
  });
  return { fileId, review, expectedGrants };
}

async function grantRowsForFile(db: Kysely<DB>, fileId: string) {
  return db
    .selectFrom("file_access")
    .select(["principal_type", "principal_value"])
    .where("indexed_file_id", "=", fileId)
    .orderBy("principal_type")
    .orderBy("principal_value")
    .execute();
}

async function visibleLinkedinProviderFileIds(db: Kysely<DB>, email: string): Promise<string[]> {
  const rows = await db
    .selectFrom("indexed_files")
    .select("provider_file_id")
    .where("source", "=", "linkedin_aimfox")
    .where(
      fileVisibilityRuleSql({
        principals: toEmailPrincipals([email]),
        slackEntitySyncEnabled: true,
        archived: "exclude",
      }),
    )
    .orderBy("provider_file_id")
    .execute();
  return rows.map((row) => row.provider_file_id);
}

function leadDetailUrls(fetchSpy: ReturnType<typeof mockLeadSync>, from = 0): string[] {
  return fetchSpy.mock.calls
    .slice(from)
    .map((call) => String(call[0]))
    .filter((url) => url.includes("/leads/"));
}

async function personCount(db: Kysely<DB>): Promise<number> {
  const rows = await db
    .selectFrom("entities")
    .select("id")
    .where("source_type", "=", "person")
    .where("subtype", "=", "external")
    .execute();
  return rows.length;
}

async function seedPersonAtCompany(
  db: Kysely<DB>,
  input: { personName: string; email: string; companyName: string; domain: string },
) {
  const entityRepo = createEntityRepository(db);
  const domainsRepo = createEntityDomainsRepository(db);
  const company = await entityRepo.upsertEntityFromTool({
    name: input.companyName,
    sourceType: "company",
    source: "test",
    sourceId: `company:${input.domain}`,
  });
  await domainsRepo.upsertAuthoritativeCorporateDomain({
    entityId: company.id,
    domain: input.domain,
    source: "test",
    isPrimary: true,
  });
  const person = await entityRepo.createPersonEntity({
    name: input.personName,
    email: input.email,
    subtype: "external",
    source: "gmail",
    sourceId: `gmail:${input.email}`,
  });
  await domainsRepo.upsertWorksAt({
    personEntityId: person.id,
    companyEntityId: company.id,
    confidence: "INFERRED",
    confidenceScore: 0.9,
    source: "test",
  });
  return { person, company };
}

function leadFixture(input: {
  id: string;
  fullName: string;
  publicIdentifier: string;
  companyName?: string;
  email?: string;
  phone?: string;
  phoneCountry?: string;
  websites?: string[];
}): AimfoxLead {
  const [firstName = "", ...rest] = input.fullName.split(" ");
  const lastName = rest.join(" ");
  return {
    id: input.id,
    urn: `urn:li:${input.id}`,
    first_name: firstName,
    last_name: lastName,
    full_name: input.fullName,
    public_identifier: input.publicIdentifier,
    occupation: "Founder",
    picture_url: "",
    location: { name: "San Francisco" },
    about: "About",
    premium: false,
    connections: 500,
    followers: 1000,
    current_experience: input.companyName
      ? [
          {
            company: {
              urn: `urn:company:${input.companyName}`,
              name: input.companyName,
              universal_name: input.companyName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, ""),
            },
            job_title: "Founder",
            start_date: { year: 2020 },
          },
        ]
      : [],
    work_experience: [],
    education: [],
    skills: [],
    certifications: [],
    languages: [],
    contact_info: {
      phone_numbers: input.phone ? [{ number: input.phone, type: "mobile", country: input.phoneCountry }] : [],
    },
    phones: [],
    email: input.email,
    emails: input.email ? [{ address: input.email, type: "work" }] : [],
    labels: [],
    notes: [],
    is_lead: true,
    lead_of: [],
    origins: [],
    websites: input.websites,
  };
}

function conversationFixture(input: { leadId: string; conversationUrn: string; lastActivityAt?: number }) {
  return {
    unread_count: 0,
    connected: true,
    last_activity_at: input.lastActivityAt ?? 1_779_912_000_000,
    conversation_urn: input.conversationUrn,
    last_message: {
      body: "Thanks",
      sender: { id: "owner", full_name: "Member User" },
      created_at: input.lastActivityAt ?? 1_779_912_000_000,
    },
    participants: [
      {
        id: input.leadId,
        urn: `urn:li:${input.leadId}`,
        public_identifier: input.leadId,
        full_name: input.leadId,
        is_lead: true,
        lead_of: [],
        labels: [],
      },
    ],
    owner: "acct-1",
    source: "linkedin",
  };
}
