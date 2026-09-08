import type { Kysely } from "kysely";
import {
  type ZohoCrmMetaStringKey,
  type ZohoCrmSourceMeta,
  readSourceMeta,
  readZohoCrmMeta,
} from "../db/repositories/connectors";
import { createCrmRecordFieldsRepository } from "../db/repositories/crm-record-fields";
import type { DB } from "../db/schema";

const PAGE_SIZE = 500;

const FIELD_LABELS: Record<string, ZohoCrmMetaStringKey> = {
  Stage: "stage",
  Amount: "amount",
  "Closing Date": "closingDate",
  Probability: "probability",
  "Lead Status": "leadStatus",
  "Lead Source": "leadSource",
  Status: "status",
  Priority: "priority",
  Due: "dueDate",
  "Due Date": "dueDate",
  Type: "callType",
  "Call Type": "callType",
  Duration: "callDuration",
  "Call Duration": "callDuration",
  Start: "callStart",
  "Call Start Time": "callStart",
  Industry: "industry",
  Website: "website",
  Employees: "companySize",
  "Company Size": "companySize",
  "No Of Employees": "companySize",
  Tag: "tag",
  "Last Activity Time": "lastActivityTime",
  Owner: "owner",
};

interface ZohoBackfillRow {
  id: string;
  provider_file_id: string;
  content: string | null;
  source_meta: string | null;
  rollup_group_id: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  file_type: string | null;
}

export interface ZohoSourceMetaBackfillCensus {
  rowsSeen: number;
  wouldUpdate: number;
  updated: number;
  fieldRowsWritten: number;
  skippedAlreadyPopulated: number;
  skippedMalformedProviderFileId: number;
  truncatedNotes: number;
}

export async function backfillZohoSourceMeta(
  db: Kysely<DB>,
  opts: { apply: boolean; force?: boolean; fields?: boolean },
): Promise<ZohoSourceMetaBackfillCensus> {
  const census: ZohoSourceMetaBackfillCensus = {
    rowsSeen: 0,
    wouldUpdate: 0,
    updated: 0,
    fieldRowsWritten: 0,
    skippedAlreadyPopulated: 0,
    skippedMalformedProviderFileId: 0,
    truncatedNotes: 0,
  };
  let afterId: string | null = null;

  for (;;) {
    let query = db
      .selectFrom("indexed_files")
      .select([
        "id",
        "provider_file_id",
        "content",
        "source_meta",
        "rollup_group_id",
        "source_created_at",
        "source_updated_at",
        "file_type",
      ])
      .where("source", "=", "zoho_crm")
      .where("is_archived", "=", 0)
      .orderBy("id", "asc")
      .limit(PAGE_SIZE);
    if (afterId) query = query.where("id", ">", afterId);
    const rows = await query.execute();
    if (rows.length === 0) break;

    for (const row of rows) {
      afterId = row.id;
      census.rowsSeen += 1;
      if (census.rowsSeen % 50 === 0) await yieldToEventLoop();
      const sourceMeta = readSourceMeta(row);
      if (sourceMeta?.zohoCrm && !opts.force) {
        census.skippedAlreadyPopulated += 1;
        if (opts.fields && opts.apply) {
          census.fieldRowsWritten += await createCrmRecordFieldsRepository(db).replaceForFile(
            row.id,
            readZohoCrmMeta(sourceMeta),
          );
        }
        continue;
      }
      const parsed = parseProviderFileId(row.provider_file_id);
      if (!parsed) {
        census.skippedMalformedProviderFileId += 1;
        continue;
      }
      const truncatedNote = row.file_type === "crm_note" && row.content?.includes("[truncated]") === true;
      if (truncatedNote) census.truncatedNotes += 1;
      const zohoCrm = buildBackfilledZohoMeta(row, parsed, truncatedNote);
      census.wouldUpdate += 1;
      if (!opts.apply) continue;
      await db.transaction().execute(async (trx) => {
        const nextSourceMeta = { ...(sourceMeta ?? {}), zohoCrm };
        await trx
          .updateTable("indexed_files")
          .set({ source_meta: JSON.stringify(nextSourceMeta) })
          .where("id", "=", row.id)
          .execute();
        if (opts.fields) {
          census.fieldRowsWritten += await createCrmRecordFieldsRepository(trx).replaceForFile(
            row.id,
            readZohoCrmMeta(nextSourceMeta),
          );
        }
      });
      census.updated += 1;
    }
  }

  return census;
}

function buildBackfilledZohoMeta(
  row: ZohoBackfillRow,
  provider: { module: string; recordId: string },
  truncatedNote: boolean,
): ZohoCrmSourceMeta {
  const meta: ZohoCrmSourceMeta = {
    module: provider.module,
    recordId: provider.recordId,
    backfilled: true,
  };
  if (row.source_created_at) meta.createdTime = row.source_created_at;
  if (row.source_updated_at) meta.modifiedTime = row.source_updated_at;
  if (!truncatedNote) {
    const related = relatedFromRollup(row.rollup_group_id, row.provider_file_id);
    if (related) meta.related = [related];
    for (const [label, value] of parseFieldLines(row.content)) {
      const key = FIELD_LABELS[label];
      if (key && value) meta[key] = value;
    }
  }
  return meta;
}

function parseProviderFileId(providerFileId: string): { module: string; recordId: string } | null {
  const index = providerFileId.indexOf(":");
  if (index <= 0 || index === providerFileId.length - 1) return null;
  return { module: providerFileId.slice(0, index), recordId: providerFileId.slice(index + 1) };
}

/** Records that roll up to themselves (accounts, contacts, deals) have no parent. */
function relatedFromRollup(
  rollupGroupId: string | null,
  providerFileId: string,
): NonNullable<ZohoCrmSourceMeta["related"]>[number] | null {
  if (!rollupGroupId || rollupGroupId === providerFileId) return null;
  const parsed = parseProviderFileId(rollupGroupId);
  return parsed ? { role: "parent", module: parsed.module, id: parsed.recordId } : null;
}

export function parseFieldLines(content: string | null): Array<[string, string]> {
  if (!content) return [];
  const fields: Array<[string, string]> = [];
  let inDescription = false;
  for (const line of content.split("\n")) {
    if (line === "## Description") {
      inDescription = true;
      continue;
    }
    if (line === "## Additional Fields") {
      inDescription = false;
      continue;
    }
    if (line.startsWith("#") || inDescription || !line.includes(": ")) continue;
    for (const [label, value] of parsePipeSeparatedFields(line)) fields.push([label, value]);
  }
  return fields;
}

function parsePipeSeparatedFields(line: string): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  for (const segment of line.split(" | ")) {
    const separator = segment.indexOf(": ");
    if (separator > 0) {
      fields.push([segment.slice(0, separator), segment.slice(separator + 2)]);
    } else if (fields.length > 0) {
      const previous = fields[fields.length - 1];
      previous[1] = `${previous[1]} | ${segment}`;
    }
  }
  return fields;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
