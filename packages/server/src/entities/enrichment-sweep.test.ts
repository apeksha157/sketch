import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EnrichmentResult, PersonEnrichmentProvider } from "../connectors/enrichment/provider";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { runEnrichmentSweep } from "./enrichment-sweep";

class StubProvider implements PersonEnrichmentProvider {
  readonly name = "salesql";
  constructor(
    readonly version: string,
    private readonly results: EnrichmentResult[],
  ) {}

  readonly calls: string[] = [];

  async enrichByLinkedinUrl(url: string): Promise<EnrichmentResult> {
    this.calls.push(url);
    return this.results.shift() ?? { kind: "not_found" };
  }
}

async function seedEntity(db: Kysely<DB>, input: { id: string; name: string; sourceType: string; metadata?: unknown }) {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: input.sourceType,
      subtype: input.sourceType === "person" ? "external" : null,
      aliases: null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      source_ref_id: null,
      status: "confirmed",
      provenance_tier: "inferred",
      hotness: 0,
      created_at: now,
      updated_at: now,
      project_lifecycle_status: null,
      ai_brief: null,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
}

async function seedCandidate(db: Kysely<DB>, input: { id: string; publicIdentifier: string; companyId?: string }) {
  await seedEntity(db, {
    id: input.id,
    name: input.id,
    sourceType: "person",
    metadata: { enrichmentCandidate: true },
  });
  await db
    .insertInto("entity_source_refs")
    .values({
      id: randomUUID(),
      entity_id: input.id,
      source: "linkedin",
      source_id: input.publicIdentifier,
      source_url: `https://www.linkedin.com/in/${input.publicIdentifier}`,
      last_seen_at: new Date().toISOString(),
    })
    .execute();
  await db
    .insertInto("entity_contact_points")
    .values({
      id: randomUUID(),
      entity_id: input.id,
      kind: "linkedin",
      value: input.publicIdentifier,
      display_value: `https://www.linkedin.com/in/${input.publicIdentifier}`,
      label: null,
      is_primary: 1,
      source: "linkedin",
      connector_config_id: null,
      created_by_user_id: null,
      verified_at: null,
      last_contacted_at: null,
    })
    .execute();
  if (input.companyId) {
    await db
      .insertInto("entity_relationships")
      .values({
        id: randomUUID(),
        source_entity_id: input.id,
        target_entity_id: input.companyId,
        relationship_type: "works_at",
        confidence: "EXTRACTED",
        confidence_score: 0.9,
        source: "linkedin_aimfox",
      })
      .execute();
  }
}

async function contactPoints(db: Kysely<DB>, entityId: string) {
  return db
    .selectFrom("entity_contact_points")
    .selectAll()
    .where("entity_id", "=", entityId)
    .orderBy("kind", "asc")
    .orderBy("value", "asc")
    .execute();
}

describe("SalesQL enrichment sweep", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("attaches contacts and company domains, is idempotent, and obeys the daily cap", async () => {
    await seedEntity(db, { id: "company-acme", name: "Acme", sourceType: "company" });
    await seedCandidate(db, { id: "person-robert", publicIdentifier: "robert-chen", companyId: "company-acme" });
    const provider = new StubProvider("v1", [
      {
        kind: "found",
        emails: [{ email: "Robert@Acme.test", type: "work", verified: true }],
        phones: [{ phone: "415 555 1234", type: "work", countryCode: "US", valid: true }],
      },
    ]);

    const report = await runEnrichmentSweep(
      { db, provider, logger: createTestLogger() },
      { apply: true, dailyCap: 10, batch: 10 },
    );

    expect(report).toMatchObject({ seeded: 1, selected: 1, enriched: 1, domainsAttached: 1 });
    const points = await contactPoints(db, "person-robert");
    expect(points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "email",
          value: "robert@acme.test",
          source: "salesql",
          is_primary: 1,
          verified_at: expect.any(String),
        }),
        expect.objectContaining({
          kind: "phone",
          value: "+14155551234",
          source: "salesql",
          verified_at: expect.any(String),
        }),
      ]),
    );
    const person = await db
      .selectFrom("entities")
      .select("metadata")
      .where("id", "=", "person-robert")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(person.metadata ?? "{}").email).toBe("robert@acme.test");
    const domain = await db
      .selectFrom("entity_domains")
      .select(["entity_id", "domain", "kind", "source", "is_primary"])
      .where("domain", "=", "acme.test")
      .executeTakeFirstOrThrow();
    expect(domain).toEqual({
      entity_id: "company-acme",
      domain: "acme.test",
      kind: "corporate",
      source: "salesql",
      is_primary: 1,
    });

    const second = await runEnrichmentSweep(
      { db, provider, logger: createTestLogger() },
      { apply: true, dailyCap: 10, batch: 10 },
    );
    expect(second.selected).toBe(0);
    expect(provider.calls).toHaveLength(1);

    await db.destroy();
    db = await createTestDb();
    await seedCandidate(db, { id: "person-one", publicIdentifier: "one" });
    await seedCandidate(db, { id: "person-two", publicIdentifier: "two" });
    const cappedProvider = new StubProvider("v1", [
      { kind: "found", emails: [], phones: [] },
      { kind: "found", emails: [], phones: [] },
    ]);
    const capped = await runEnrichmentSweep(
      { db, provider: cappedProvider, logger: createTestLogger() },
      { apply: false, dailyCap: 1, batch: 10 },
    );
    expect(capped.selected).toBe(1);
    expect(cappedProvider.calls).toHaveLength(1);
  });

  it("honors negative cache TTL, error backoff, and provider version invalidation", async () => {
    await seedCandidate(db, { id: "person-missing", publicIdentifier: "aaa-missing" });
    await seedCandidate(db, { id: "person-error", publicIdentifier: "zzz-error" });
    const provider = new StubProvider("v1", [
      { kind: "not_found" },
      { kind: "error", status: 500, message: "server error" },
    ]);

    await runEnrichmentSweep({ db, provider, logger: createTestLogger() }, { apply: false, dailyCap: 10, batch: 10 });
    const firstRows = await db
      .selectFrom("person_enrichment_attempts")
      .selectAll()
      .orderBy("linkedin_url", "asc")
      .execute();
    const errorRow = firstRows.find((row) => row.linkedin_url.endsWith("/zzz-error"));
    const missingRow = firstRows.find((row) => row.linkedin_url.endsWith("/aaa-missing"));
    expect(missingRow).toMatchObject({ status: "not_found", attempts: 1 });
    expect(errorRow).toMatchObject({ status: "failed", attempts: 1 });
    const firstBackoff = errorRow?.next_eligible_at;

    const immediate = await runEnrichmentSweep(
      { db, provider, logger: createTestLogger() },
      { apply: false, dailyCap: 10, batch: 10 },
    );
    expect(immediate.selected).toBe(0);

    await db
      .updateTable("person_enrichment_attempts")
      .set({ next_eligible_at: "2000-01-01T00:00:00.000Z" })
      .where("linkedin_url", "like", "%/zzz-error")
      .execute();
    const retryProvider = new StubProvider("v1", [{ kind: "error", status: 500, message: "still failing" }]);
    await runEnrichmentSweep(
      { db, provider: retryProvider, logger: createTestLogger() },
      { apply: false, dailyCap: 10, batch: 10 },
    );
    const retryRow = await db
      .selectFrom("person_enrichment_attempts")
      .select(["attempts", "next_eligible_at"])
      .where("linkedin_url", "like", "%/zzz-error")
      .executeTakeFirstOrThrow();
    expect(retryRow.attempts).toBe(2);
    expect(Date.parse(retryRow.next_eligible_at ?? "")).toBeGreaterThan(Date.parse(firstBackoff ?? ""));

    const bumpedProvider = new StubProvider("v2", [{ kind: "not_found" }]);
    const bumped = await runEnrichmentSweep(
      { db, provider: bumpedProvider, logger: createTestLogger() },
      { apply: false, dailyCap: 10, batch: 10, limit: 1 },
    );
    expect(bumpedProvider.calls).toEqual(["https://www.linkedin.com/in/aaa-missing"]);
    expect(bumped.selected).toBe(1);
  });

  it("records a rate limit, stops the run, and writes no contact points", async () => {
    await seedCandidate(db, { id: "person-first", publicIdentifier: "first" });
    await seedCandidate(db, { id: "person-second", publicIdentifier: "second" });
    const provider = new StubProvider("v1", [{ kind: "rate_limited", retryAfterMs: 7_000 }]);

    const report = await runEnrichmentSweep(
      { db, provider, logger: createTestLogger() },
      { apply: true, dailyCap: 10, batch: 10 },
    );

    expect(report).toMatchObject({ stoppedOn: "rate_limited", enriched: 0, notFound: 0, failed: 0 });
    expect(provider.calls).toEqual(["https://www.linkedin.com/in/first"]);
    const row = await db
      .selectFrom("person_enrichment_attempts")
      .select(["status", "attempts", "next_eligible_at"])
      .where("linkedin_url", "=", "https://www.linkedin.com/in/first")
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(Date.parse(row.next_eligible_at ?? "")).toBeGreaterThan(Date.now());
    await expect(
      db
        .selectFrom("enrichment_daily_usage")
        .select("calls")
        .where("provider", "=", "salesql")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ calls: 1 });
    const salesqlPoints = await db
      .selectFrom("entity_contact_points")
      .selectAll()
      .where("source", "=", "salesql")
      .execute();
    expect(salesqlPoints).toHaveLength(0);
  });
});
