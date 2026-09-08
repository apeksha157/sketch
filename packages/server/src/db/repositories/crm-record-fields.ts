import type { Insertable, Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import { idInList } from "../../connectors/id-in-list";
import type { CrmRecordFieldsTable, DB } from "../schema";
import type { ZohoCrmMetaStringKey, ZohoCrmSourceMeta } from "./connectors";

export type CrmRecordFieldRow = Selectable<CrmRecordFieldsTable>;

type CrmRecordFieldsDb = Kysely<DB> | Transaction<DB>;

const EXCLUDED_ZOHO_FIELDS = new Set<ZohoCrmMetaStringKey>(["module", "recordId"]);

export function normalizeCrmRecordFieldValue(value: string): string {
  return value.trim().toLowerCase();
}

export function createCrmRecordFieldsRepository(db: CrmRecordFieldsDb) {
  return {
    async replaceForFile(indexedFileId: string, meta: ZohoCrmSourceMeta | null): Promise<number> {
      await db.deleteFrom("crm_record_fields").where("indexed_file_id", "=", indexedFileId).execute();
      const rows = rowsForMeta(indexedFileId, meta);
      if (rows.length === 0) return 0;
      await db.insertInto("crm_record_fields").values(rows).execute();
      return rows.length;
    },

    async listForFiles(indexedFileIds: readonly string[]): Promise<CrmRecordFieldRow[]> {
      const uniqueIds = [...new Set(indexedFileIds)];
      if (uniqueIds.length === 0) return [];
      return db
        .selectFrom("crm_record_fields")
        .select(["indexed_file_id", "field", "value", "value_norm"])
        .where(idInList(db as Kysely<DB>, sql.ref("crm_record_fields.indexed_file_id"), uniqueIds))
        .execute();
    },
  };
}

function rowsForMeta(indexedFileId: string, meta: ZohoCrmSourceMeta | null): Insertable<CrmRecordFieldsTable>[] {
  if (!meta) return [];
  const rows = new Map<string, Insertable<CrmRecordFieldsTable>>();
  for (const [field, value] of Object.entries(meta)) {
    if (EXCLUDED_ZOHO_FIELDS.has(field as ZohoCrmMetaStringKey)) continue;
    if (field === "tag" || field === "tags") continue;
    if (typeof value === "string") {
      addRows(rows, indexedFileId, field, [value]);
    }
  }
  addRows(rows, indexedFileId, "tag", meta.tags && meta.tags.length > 0 ? meta.tags : (meta.tag?.split(", ") ?? []));
  return [...rows.values()];
}

function addRows(
  rows: Map<string, Insertable<CrmRecordFieldsTable>>,
  indexedFileId: string,
  field: string,
  values: readonly string[],
): void {
  for (const value of values) {
    const valueNorm = normalizeCrmRecordFieldValue(value);
    if (!valueNorm) continue;
    rows.set(`${field}\0${valueNorm}`, {
      indexed_file_id: indexedFileId,
      field,
      value,
      value_norm: valueNorm,
    });
  }
}
