import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import { backfillEntityMentions } from "./backfill-entity-mentions";

const NOW = "2026-09-07T00:00:00.000Z";

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({ id: "user-1", name: "Admin", email: "admin@example.com", email_verified_at: NOW })
    .execute();
  await db
    .insertInto("connector_configs")
    .values([
      {
        id: "zoho-config",
        connector_type: "zoho_crm",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "user-1",
      },
      {
        id: "linkedin-config",
        connector_type: "linkedin_aimfox",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "user-1",
      },
    ])
    .execute();
  await db
    .insertInto("entities")
    .values([
      {
        id: "zoho-person",
        name: "Jane Buyer",
        source_type: "person",
        subtype: "external",
        status: "active",
        hotness: 0,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        id: "zoho-company",
        name: "Acme Corp",
        source_type: "company",
        subtype: null,
        status: "active",
        hotness: 0,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        id: "linkedin-person",
        name: "Asha Lead",
        source_type: "person",
        subtype: "external",
        status: "active",
        hotness: 0,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        id: "linkedin-company",
        name: "Globex",
        source_type: "company",
        subtype: null,
        status: "active",
        hotness: 0,
        created_at: NOW,
        updated_at: NOW,
      },
    ])
    .execute();
  await db
    .insertInto("entity_source_refs")
    .values([
      {
        id: "ref-contact",
        entity_id: "zoho-person",
        source: "zoho_crm",
        source_id: "Contacts:c1",
        last_seen_at: NOW,
      },
      {
        id: "ref-account",
        entity_id: "zoho-company",
        source: "zoho_crm",
        source_id: "Accounts:a1",
        last_seen_at: NOW,
      },
      {
        id: "ref-lead",
        entity_id: "linkedin-person",
        source: "aimfox",
        source_id: "lead-1",
        last_seen_at: NOW,
      },
    ])
    .execute();
  await db
    .insertInto("entity_relationships")
    .values([
      {
        id: "rel-zoho",
        source_entity_id: "zoho-person",
        target_entity_id: "zoho-company",
        relationship_type: "works_at",
        confidence: "EXTRACTED",
        confidence_score: 0.9,
        source: "zoho_crm",
      },
      {
        id: "rel-linkedin",
        source_entity_id: "linkedin-person",
        target_entity_id: "linkedin-company",
        relationship_type: "works_at",
        confidence: "EXTRACTED",
        confidence_score: 0.9,
        source: "linkedin",
      },
    ])
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      {
        id: "crm-note",
        connector_config_id: "zoho-config",
        provider_file_id: "Notes:n1",
        file_name: "Note",
        file_type: "crm_note",
        content_category: "document",
        source: "zoho_crm",
        source_path: "Zoho / Notes",
        rollup_group_id: "Contacts:c1",
        synced_at: NOW,
      },
      {
        id: "crm-account",
        connector_config_id: "zoho-config",
        provider_file_id: "Accounts:a1",
        file_name: "Acme Corp",
        file_type: "crm_account",
        content_category: "structured",
        source: "zoho_crm",
        source_path: "Zoho / Accounts",
        synced_at: NOW,
      },
      {
        id: "linkedin-profile",
        connector_config_id: "linkedin-config",
        provider_file_id: "linkedin:acct-1:profile:lead-1",
        file_name: "LinkedIn profile - Asha Lead",
        file_type: "linkedin_profile",
        content_category: "structured",
        source: "linkedin_aimfox",
        source_path: "LinkedIn / Profiles",
        rollup_group_id: "linkedin:acct-1:profile:lead-1",
        synced_at: NOW,
      },
      {
        id: "linkedin-conversation",
        connector_config_id: "linkedin-config",
        provider_file_id: "linkedin:acct-1:urn:conversation:lead-1:segment-0",
        file_name: "LinkedIn conversation",
        file_type: "linkedin_conversation",
        content_category: "document",
        source: "linkedin_aimfox",
        source_path: "LinkedIn / Asha Lead",
        rollup_group_id: "linkedin:acct-1:profile:lead-1",
        synced_at: NOW,
      },
    ])
    .execute();
  await db
    .insertInto("entity_mentions")
    .values({
      id: "existing-linkedin-company-profile",
      entity_id: "linkedin-company",
      indexed_file_id: "linkedin-profile",
      confidence: "EXTRACTED",
      source: "linkedin",
      relation: "mentioned",
      mentioned_at: NOW,
    })
    .execute();
}

describe("backfillEntityMentions", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("dry-runs, applies idempotently, and preserves existing profile company mention sources", async () => {
    db = await createTestPgDb();
    await seedBase(db);

    const dryRun = await backfillEntityMentions(db);

    expect(dryRun.crmChildrenToEmployer.rowsScanned).toBe(1);
    expect(dryRun.selfRecords.rowsScanned).toBe(2);
    expect(dryRun.linkedinToEmployer.rowsScanned).toBe(2);
    expect(dryRun.crmChildrenToEmployer.inserted).toBe(1);
    expect(dryRun.selfRecords.inserted).toBe(2);
    expect(dryRun.linkedinToEmployer).toMatchObject({ inserted: 1, skippedExisting: 1 });
    await expect(db.selectFrom("entity_mentions").selectAll().execute()).resolves.toHaveLength(1);

    const applied = await backfillEntityMentions(db, { apply: true });

    expect(applied).toMatchObject({
      crmChildrenToEmployer: {
        rowsScanned: 1,
        inserted: 1,
        skippedExisting: 0,
        skippedNoCompany: 0,
        skippedDeadEntity: 0,
      },
      selfRecords: { rowsScanned: 2, inserted: 2, skippedExisting: 0, skippedNoCompany: 0, skippedDeadEntity: 0 },
      linkedinToEmployer: {
        rowsScanned: 2,
        inserted: 1,
        skippedExisting: 1,
        skippedNoCompany: 0,
        skippedDeadEntity: 0,
      },
    });
    const secondApply = await backfillEntityMentions(db, { apply: true });
    expect(secondApply.crmChildrenToEmployer.inserted).toBe(0);
    expect(secondApply.selfRecords.inserted).toBe(0);
    expect(secondApply.linkedinToEmployer.inserted).toBe(0);

    const profileCompanyMention = await db
      .selectFrom("entity_mentions")
      .select(["source"])
      .where("entity_id", "=", "linkedin-company")
      .where("indexed_file_id", "=", "linkedin-profile")
      .executeTakeFirstOrThrow();
    expect(profileCompanyMention.source).toBe("linkedin");
  });
});
