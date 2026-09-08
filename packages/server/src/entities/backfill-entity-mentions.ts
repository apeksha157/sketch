import type { Kysely } from "kysely";
import { type CreateMentionData, createEntityRepository } from "../db/repositories/entities";
import { createEntityRelationshipsRepository } from "../db/repositories/entity-relationships";
import type { DB } from "../db/schema";
import { yieldToEventLoop } from "../lib/event-loop";
import { resolveLiveEntity, resolveLiveEntityId, resolveSourceRefToLiveEntityId } from "./redirect";

const PAGE_SIZE = 500;
const YIELD_EVERY_ROWS = 50;
const CRM_CHILD_FILE_TYPES = ["crm_note", "crm_task", "crm_call", "crm_event"];

export interface BackfillEntityMentionsOptions {
  apply?: boolean;
}

/**
 * `inserted` counts rows written under `--apply`; in a dry run it counts the rows that would be written,
 * so the census reads the same either way.
 */
export interface BackfillEntityMentionsPassResult {
  rowsScanned: number;
  inserted: number;
  skippedExisting: number;
  skippedNoCompany: number;
  skippedDeadEntity: number;
}

export interface BackfillEntityMentionsResult {
  crmChildrenToEmployer: BackfillEntityMentionsPassResult;
  selfRecords: BackfillEntityMentionsPassResult;
  linkedinToEmployer: BackfillEntityMentionsPassResult;
}

type MentionCounters = Pick<BackfillEntityMentionsPassResult, "inserted" | "skippedExisting">;

function emptyPassResult(): BackfillEntityMentionsPassResult {
  return {
    rowsScanned: 0,
    inserted: 0,
    skippedExisting: 0,
    skippedNoCompany: 0,
    skippedDeadEntity: 0,
  };
}

function parseLinkedinProfileProviderFileId(providerFileId: string | null): string | null {
  if (!providerFileId) return null;
  const parts = providerFileId.split(":");
  if (parts.length !== 4 || parts[0] !== "linkedin" || parts[2] !== "profile") return null;
  return parts[3] || null;
}

async function mentionExists(db: Kysely<DB>, data: CreateMentionData): Promise<boolean> {
  const entityId = await resolveLiveEntityId(db, data.entityId);
  const row = await db
    .selectFrom("entity_mentions")
    .select("id")
    .where("entity_id", "=", entityId)
    .where("indexed_file_id", "=", data.indexedFileId)
    .where("relation", "=", data.relation)
    .executeTakeFirst();
  return Boolean(row);
}

async function recordMention(
  db: Kysely<DB>,
  counters: MentionCounters,
  data: CreateMentionData,
  apply: boolean,
): Promise<void> {
  if (!apply) {
    if (await mentionExists(db, data)) counters.skippedExisting += 1;
    else counters.inserted += 1;
    return;
  }
  const inserted = await createEntityRepository(db).createMentionIfAbsent(data);
  if (inserted) counters.inserted += 1;
  else counters.skippedExisting += 1;
}

async function loadLiveEntityFromSourceRef(db: Kysely<DB>, source: string, sourceId: string, sourceType: string) {
  const entityId = await resolveSourceRefToLiveEntityId(db, source, sourceId);
  if (!entityId) return null;
  const entity = await resolveLiveEntity(db, entityId);
  if (!entity || entity.status === "archived" || entity.source_type !== sourceType) return null;
  return entity;
}

async function processCompaniesForFile(
  db: Kysely<DB>,
  result: BackfillEntityMentionsPassResult,
  input: {
    personEntityId: string;
    indexedFileId: string;
    contextSnippet: string | null;
    edgeSource: string;
    mentionSource: string;
    apply: boolean;
  },
): Promise<void> {
  const relationshipsRepo = createEntityRelationshipsRepository(db);
  const companyIds = await relationshipsRepo.listLiveWorksAtCompanyIds(input.personEntityId, {
    sources: [input.edgeSource],
  });
  if (companyIds.length === 0) {
    result.skippedNoCompany += 1;
    return;
  }
  for (const companyId of companyIds) {
    await recordMention(
      db,
      result,
      {
        entityId: companyId,
        indexedFileId: input.indexedFileId,
        contextSnippet: input.contextSnippet,
        confidence: "EXTRACTED",
        source: input.mentionSource,
        relation: "mentioned",
      },
      input.apply,
    );
  }
}

async function backfillCrmChildrenToEmployer(
  db: Kysely<DB>,
  apply: boolean,
): Promise<BackfillEntityMentionsPassResult> {
  const result = emptyPassResult();
  let lastId: string | null = null;

  for (;;) {
    let query = db
      .selectFrom("indexed_files")
      .select(["id", "provider_file_id", "source_path", "rollup_group_id"])
      .where("file_type", "in", CRM_CHILD_FILE_TYPES)
      .where("rollup_group_id", "like", "Contacts:%")
      .orderBy("id", "asc")
      .limit(PAGE_SIZE);
    if (lastId) query = query.where("id", ">", lastId);
    const rows = await query.execute();
    if (rows.length === 0) break;

    for (const row of rows) {
      result.rowsScanned += 1;
      if (!row.rollup_group_id) {
        result.skippedDeadEntity += 1;
      } else {
        const person = await loadLiveEntityFromSourceRef(db, "zoho_crm", row.rollup_group_id, "person");
        if (!person) {
          result.skippedDeadEntity += 1;
        } else {
          await processCompaniesForFile(db, result, {
            personEntityId: person.id,
            indexedFileId: row.id,
            contextSnippet: row.source_path,
            edgeSource: "zoho_crm",
            mentionSource: "zoho_crm_account_rollup",
            apply,
          });
        }
      }
      if (result.rowsScanned % YIELD_EVERY_ROWS === 0) await yieldToEventLoop();
    }

    lastId = rows.at(-1)?.id ?? lastId;
  }

  return result;
}

async function backfillZohoSelfRecords(db: Kysely<DB>, result: BackfillEntityMentionsPassResult, apply: boolean) {
  let lastId: string | null = null;

  for (;;) {
    let query = db
      .selectFrom("indexed_files as file")
      .innerJoin("entity_source_refs as ref", (join) =>
        join.onRef("ref.source_id", "=", "file.provider_file_id").on("ref.source", "=", "zoho_crm"),
      )
      .select(["file.id", "file.provider_file_id", "file.source_path", "file.rollup_group_id", "ref.entity_id"])
      .orderBy("file.id", "asc")
      .limit(PAGE_SIZE);
    if (lastId) query = query.where("file.id", ">", lastId);
    const rows = await query.execute();
    if (rows.length === 0) break;

    for (const row of rows) {
      result.rowsScanned += 1;
      const entity = await resolveLiveEntity(db, row.entity_id);
      if (!entity || entity.status === "archived") {
        result.skippedDeadEntity += 1;
      } else {
        await recordMention(
          db,
          result,
          {
            entityId: entity.id,
            indexedFileId: row.id,
            contextSnippet: row.source_path,
            confidence: "EXTRACTED",
            source: "zoho_crm_parent_entity",
            relation: "mentioned",
          },
          apply,
        );
      }
      if (result.rowsScanned % YIELD_EVERY_ROWS === 0) await yieldToEventLoop();
    }

    lastId = rows.at(-1)?.id ?? lastId;
  }
}

async function backfillLinkedinProfileSelfRecords(
  db: Kysely<DB>,
  result: BackfillEntityMentionsPassResult,
  apply: boolean,
) {
  let lastId: string | null = null;

  for (;;) {
    let query = db
      .selectFrom("indexed_files")
      .select(["id", "provider_file_id", "source_path", "rollup_group_id"])
      .where("file_type", "=", "linkedin_profile")
      .orderBy("id", "asc")
      .limit(PAGE_SIZE);
    if (lastId) query = query.where("id", ">", lastId);
    const rows = await query.execute();
    if (rows.length === 0) break;

    for (const row of rows) {
      result.rowsScanned += 1;
      const leadId = parseLinkedinProfileProviderFileId(row.provider_file_id);
      if (!leadId) {
        result.skippedDeadEntity += 1;
      } else {
        const person = await loadLiveEntityFromSourceRef(db, "aimfox", leadId, "person");
        if (!person) {
          result.skippedDeadEntity += 1;
        } else {
          await recordMention(
            db,
            result,
            {
              entityId: person.id,
              indexedFileId: row.id,
              contextSnippet: row.source_path,
              confidence: "EXTRACTED",
              source: "linkedin_aimfox_parent_entity",
              relation: "mentioned",
            },
            apply,
          );
        }
      }
      if (result.rowsScanned % YIELD_EVERY_ROWS === 0) await yieldToEventLoop();
    }

    lastId = rows.at(-1)?.id ?? lastId;
  }
}

async function backfillSelfRecords(db: Kysely<DB>, apply: boolean): Promise<BackfillEntityMentionsPassResult> {
  const result = emptyPassResult();
  await backfillZohoSelfRecords(db, result, apply);
  await backfillLinkedinProfileSelfRecords(db, result, apply);
  return result;
}

async function backfillLinkedinToEmployer(db: Kysely<DB>, apply: boolean): Promise<BackfillEntityMentionsPassResult> {
  const result = emptyPassResult();
  let lastId: string | null = null;

  for (;;) {
    let query = db
      .selectFrom("indexed_files")
      .select(["id", "provider_file_id", "file_type", "source_path", "rollup_group_id"])
      .where("file_type", "in", ["linkedin_profile", "linkedin_conversation"])
      .orderBy("id", "asc")
      .limit(PAGE_SIZE);
    if (lastId) query = query.where("id", ">", lastId);
    const rows = await query.execute();
    if (rows.length === 0) break;

    for (const row of rows) {
      result.rowsScanned += 1;
      const profileProviderFileId = row.file_type === "linkedin_profile" ? row.provider_file_id : row.rollup_group_id;
      const leadId = parseLinkedinProfileProviderFileId(profileProviderFileId);
      if (!leadId) {
        result.skippedDeadEntity += 1;
      } else {
        const person = await loadLiveEntityFromSourceRef(db, "aimfox", leadId, "person");
        if (!person) {
          result.skippedDeadEntity += 1;
        } else {
          await processCompaniesForFile(db, result, {
            personEntityId: person.id,
            indexedFileId: row.id,
            contextSnippet: row.source_path,
            edgeSource: "linkedin",
            mentionSource: "linkedin_company_rollup",
            apply,
          });
        }
      }
      if (result.rowsScanned % YIELD_EVERY_ROWS === 0) await yieldToEventLoop();
    }

    lastId = rows.at(-1)?.id ?? lastId;
  }

  return result;
}

export async function backfillEntityMentions(
  db: Kysely<DB>,
  opts: BackfillEntityMentionsOptions = {},
): Promise<BackfillEntityMentionsResult> {
  const apply = opts.apply === true;
  return {
    crmChildrenToEmployer: await backfillCrmChildrenToEmployer(db, apply),
    selfRecords: await backfillSelfRecords(db, apply),
    linkedinToEmployer: await backfillLinkedinToEmployer(db, apply),
  };
}
