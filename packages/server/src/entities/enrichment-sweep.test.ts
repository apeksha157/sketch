import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { runEnrichmentSweep } from "./enrichment-sweep";
import { StubProvider, contactPoints, seedCandidate, seedEntity } from "./enrichment-sweep-test-helpers";

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
