import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { buildMaterializeDeps } from "./materialize";
import { materializeParentEntity } from "./materialize-structural";
import type { IndexedFileFactRow } from "./materialize-types";

const USER_ID = "user-1";
const CONNECTOR_ID = "connector-1";
const NOW = "2026-09-07T00:00:00.000Z";

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Admin",
      email: "admin@example.com",
      email_verified_at: NOW,
      password_hash: "hash",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "zoho_crm",
      auth_type: "oauth",
      credentials: "{}",
      created_by: USER_ID,
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: id,
      file_name: `${id}.txt`,
      file_type: "crm_note",
      content_category: "document",
      source: "zoho_crm",
      content_hash: `hash-${id}`,
      synced_at: NOW,
    })
    .execute();
}

async function seedParentFact(db: Kysely<DB>, fileId: string, sourceId: string): Promise<IndexedFileFactRow> {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    contentHash: `hash-${fileId}`,
    source: "zoho_crm",
    factType: "parent_entity",
    relation: "mentioned",
    subjectSource: "zoho_crm",
    subjectSourceId: sourceId,
    contextSnippet: `Parent ${sourceId}`,
    raw: { providerFileId: fileId, parent: { source: "zoho_crm", sourceId } },
  });
  return db
    .selectFrom("indexed_file_facts")
    .selectAll()
    .where("indexed_file_id", "=", fileId)
    .executeTakeFirstOrThrow();
}

describe("materializeParentEntity", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("rolls supported parent-person mentions up to live employers only", async () => {
    const entityRepo = createEntityRepository(db);
    const rollupPerson = await entityRepo.upsertPersonEntity({
      name: "Jane Buyer",
      subtype: "external",
      source: "zoho_crm",
      sourceId: "Contacts:rollup",
    });
    const emailDomainPerson = await entityRepo.upsertPersonEntity({
      name: "Email Domain",
      subtype: "external",
      source: "zoho_crm",
      sourceId: "Contacts:email-domain",
    });
    const noEmployerPerson = await entityRepo.upsertPersonEntity({
      name: "No Employer",
      subtype: "external",
      source: "zoho_crm",
      sourceId: "Contacts:none",
    });
    const company = await entityRepo.upsertEntityFromTool({
      name: "Acme Corp",
      sourceType: "company",
      source: "zoho_crm",
      sourceId: "Accounts:acme",
    });
    const filteredCompany = await entityRepo.upsertEntityFromTool({
      name: "Filtered Corp",
      sourceType: "company",
      source: "zoho_crm",
      sourceId: "Accounts:filtered",
    });
    await db
      .insertInto("entity_relationships")
      .values([
        {
          id: "rel-rollup",
          source_entity_id: rollupPerson.id,
          target_entity_id: company.id,
          relationship_type: "works_at",
          confidence: "EXTRACTED",
          confidence_score: 0.9,
          source: "zoho_crm",
        },
        {
          id: "rel-filtered",
          source_entity_id: emailDomainPerson.id,
          target_entity_id: filteredCompany.id,
          relationship_type: "works_at",
          confidence: "EXTRACTED",
          confidence_score: 0.9,
          source: "email_domain",
        },
      ])
      .execute();
    await Promise.all([seedFile(db, "file-rollup"), seedFile(db, "file-filtered"), seedFile(db, "file-none")]);
    const facts = [
      await seedParentFact(db, "file-rollup", "Contacts:rollup"),
      await seedParentFact(db, "file-filtered", "Contacts:email-domain"),
      await seedParentFact(db, "file-none", "Contacts:none"),
    ];
    const deps = await buildMaterializeDeps(db);

    for (const fact of facts) await materializeParentEntity(deps, fact);

    const mentions = await db
      .selectFrom("entity_mentions")
      .select(["entity_id", "indexed_file_id", "source"])
      .orderBy("indexed_file_id", "asc")
      .orderBy("source", "asc")
      .execute();
    expect(mentions).toHaveLength(4);
    expect(mentions).toEqual(
      expect.arrayContaining([
        { entity_id: company.id, indexed_file_id: "file-rollup", source: "zoho_crm_account_rollup" },
        { entity_id: rollupPerson.id, indexed_file_id: "file-rollup", source: "zoho_crm_parent_entity" },
        { entity_id: emailDomainPerson.id, indexed_file_id: "file-filtered", source: "zoho_crm_parent_entity" },
        { entity_id: noEmployerPerson.id, indexed_file_id: "file-none", source: "zoho_crm_parent_entity" },
      ]),
    );
  });
});
