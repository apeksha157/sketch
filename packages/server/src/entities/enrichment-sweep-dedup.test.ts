import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EnrichmentResult } from "../connectors/enrichment/provider";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { runEnrichmentSweep } from "./enrichment-sweep";
import { StubProvider, seedCandidate, seedEmailContactPoint, seedEntity } from "./enrichment-sweep-test-helpers";
import { resolveLiveEntityId } from "./redirect";

function foundEmail(email: string): EnrichmentResult {
  return { kind: "found", emails: [{ email, type: "work", verified: true }], phones: [] };
}

async function seedEmailPerson(db: Kysely<DB>, input: { id: string; email: string }) {
  await seedEntity(db, {
    id: input.id,
    name: input.id,
    sourceType: "person",
    metadata: { email: input.email.toLowerCase() },
  });
  await seedEmailContactPoint(db, { entityId: input.id, email: input.email });
}

async function graphVerdicts(db: Kysely<DB>) {
  return db
    .selectFrom("graph_verdicts")
    .select(["action", "subject_entity_id", "target_entity_id", "reason", "evidence_json", "status"])
    .orderBy("subject_entity_id", "asc")
    .orderBy("target_entity_id", "asc")
    .execute();
}

async function requeueAttempt(db: Kysely<DB>, publicIdentifier: string) {
  await db
    .updateTable("person_enrichment_attempts")
    .set({ status: "pending", next_eligible_at: null })
    .where("linkedin_url", "=", `https://www.linkedin.com/in/${publicIdentifier}`)
    .execute();
}

async function seedOffSwitchPair(db: Kysely<DB>) {
  await seedEmailPerson(db, { id: "gmail-off", email: "jane@acme.test" });
  await seedCandidate(db, { id: "linkedin-off", publicIdentifier: "linkedin-off" });
}

describe("SalesQL enrichment sweep dedup", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("auto-merges a guard-passing unique email match into the existing person", async () => {
    await seedEmailPerson(db, { id: "gmail-jane", email: "jane@acme.test" });
    await seedCandidate(db, { id: "linkedin-jane", publicIdentifier: "jane-linkedin" });
    const provider = new StubProvider("v1", [foundEmail("jane@acme.test")]);

    const report = await runEnrichmentSweep(
      { db, provider, logger: createTestLogger() },
      { apply: true, dailyCap: 10, batch: 10, autoMerge: true },
    );

    const linkedin = await db
      .selectFrom("entities")
      .select("merged_into_entity_id")
      .where("id", "=", "linkedin-jane")
      .executeTakeFirstOrThrow();
    expect(linkedin.merged_into_entity_id).toBe("gmail-jane");
    await expect(resolveLiveEntityId(db, "linkedin-jane")).resolves.toBe("gmail-jane");

    const merge = await db
      .selectFrom("entity_merges")
      .select(["survivor_entity_id", "merged_entity_id", "merged_by"])
      .executeTakeFirstOrThrow();
    expect(merge).toEqual({
      survivor_entity_id: "gmail-jane",
      merged_entity_id: "linkedin-jane",
      merged_by: "salesql_enrichment@v1",
    });

    const ref = await db
      .selectFrom("entity_source_refs")
      .select(["entity_id", "source", "source_id"])
      .where("source", "=", "linkedin")
      .where("source_id", "=", "jane-linkedin")
      .executeTakeFirstOrThrow();
    expect(ref.entity_id).toBe("gmail-jane");
    await expect(graphVerdicts(db)).resolves.toHaveLength(0);
    expect(report).toMatchObject({ merged: 1, proposed: 0 });
  });

  it("files proposals for guarded matches and does not duplicate them on rerun", async () => {
    await seedEmailPerson(db, { id: "gmail-role", email: "hello@acme.test" });
    await seedCandidate(db, { id: "linkedin-role", publicIdentifier: "role-match" });
    await seedEmailPerson(db, { id: "gmail-personal", email: "jane@gmail.com" });
    await seedCandidate(db, { id: "linkedin-personal", publicIdentifier: "personal-match" });
    await seedEmailPerson(db, { id: "gmail-one", email: "jane@acme.test" });
    await seedEmailPerson(db, { id: "gmail-two", email: "jane@acme.test" });
    await seedCandidate(db, { id: "linkedin-multi", publicIdentifier: "multi-match" });

    const first = await runEnrichmentSweep(
      {
        db,
        provider: new StubProvider("v1", [
          foundEmail("jane@acme.test"),
          foundEmail("jane@gmail.com"),
          foundEmail("hello@acme.test"),
        ]),
        logger: createTestLogger(),
      },
      { apply: true, dailyCap: 10, batch: 10, autoMerge: true },
    );

    expect(first).toMatchObject({ merged: 0, proposed: 4 });
    await expect(resolveLiveEntityId(db, "linkedin-role")).resolves.toBe("linkedin-role");
    await expect(resolveLiveEntityId(db, "linkedin-personal")).resolves.toBe("linkedin-personal");
    await expect(resolveLiveEntityId(db, "linkedin-multi")).resolves.toBe("linkedin-multi");

    const rows = await graphVerdicts(db);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.status)).toEqual([
      "awaiting_human",
      "awaiting_human",
      "awaiting_human",
      "awaiting_human",
    ]);
    expect(rows.map((row) => [row.subject_entity_id, row.target_entity_id])).toEqual([
      ["linkedin-multi", "gmail-one"],
      ["linkedin-multi", "gmail-two"],
      ["linkedin-personal", "gmail-personal"],
      ["linkedin-role", "gmail-role"],
    ]);
    for (const row of rows) {
      expect(row.reason).not.toContain("@");
      expect(row.evidence_json).not.toContain("jane@");
      expect(row.evidence_json).not.toContain("hello@");
    }

    await requeueAttempt(db, "multi-match");
    await requeueAttempt(db, "personal-match");
    await requeueAttempt(db, "role-match");
    const second = await runEnrichmentSweep(
      {
        db,
        provider: new StubProvider("v1", [
          foundEmail("jane@acme.test"),
          foundEmail("jane@gmail.com"),
          foundEmail("hello@acme.test"),
        ]),
        logger: createTestLogger(),
      },
      { apply: true, dailyCap: 10, batch: 10, autoMerge: true },
    );

    expect(second).toMatchObject({ merged: 0, proposed: 0 });
    await expect(graphVerdicts(db)).resolves.toHaveLength(4);
  });

  it("uses the auto-merge switch for apply and dry-run decisions", async () => {
    await seedOffSwitchPair(db);
    const applyReport = await runEnrichmentSweep(
      { db, provider: new StubProvider("v1", [foundEmail("jane@acme.test")]), logger: createTestLogger() },
      { apply: true, dailyCap: 10, batch: 10, autoMerge: false },
    );

    await expect(resolveLiveEntityId(db, "linkedin-off")).resolves.toBe("linkedin-off");
    await expect(graphVerdicts(db)).resolves.toHaveLength(1);
    expect(applyReport).toMatchObject({ merged: 0, proposed: 1 });

    await db.destroy();
    db = await createTestDb();
    await seedOffSwitchPair(db);
    const dryProposal = await runEnrichmentSweep(
      { db, provider: new StubProvider("v1", [foundEmail("jane@acme.test")]), logger: createTestLogger() },
      { apply: false, dailyCap: 10, batch: 10, autoMerge: false },
    );

    await expect(graphVerdicts(db)).resolves.toHaveLength(0);
    await expect(resolveLiveEntityId(db, "linkedin-off")).resolves.toBe("linkedin-off");
    expect(dryProposal).toMatchObject({ wouldMerge: 0, wouldPropose: 1 });

    await db.destroy();
    db = await createTestDb();
    await seedOffSwitchPair(db);
    const dryMerge = await runEnrichmentSweep(
      { db, provider: new StubProvider("v1", [foundEmail("jane@acme.test")]), logger: createTestLogger() },
      { apply: false, dailyCap: 10, batch: 10, autoMerge: true },
    );

    await expect(graphVerdicts(db)).resolves.toHaveLength(0);
    await expect(resolveLiveEntityId(db, "linkedin-off")).resolves.toBe("linkedin-off");
    expect(dryMerge).toMatchObject({ wouldMerge: 1, wouldPropose: 0 });
  });
});
