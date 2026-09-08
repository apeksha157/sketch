import { randomUUID } from "node:crypto";
import type { Insertable, Kysely, Selectable, Transaction } from "kysely";
import type { CrmFieldHistoryTable, DB } from "../schema";
import { type FileViewer, fileVisibilityPredicate } from "./connectors";

export type CrmFieldHistoryRow = Selectable<CrmFieldHistoryTable>;

export interface CrmFieldHistoryAppendRow {
  indexedFileId: string;
  entityId: string | null;
  field: string;
  oldValue: string | null;
  newValue: string;
  sourceModifiedAt: string | null;
}

type CrmFieldHistoryDb = Kysely<DB> | Transaction<DB>;

export function createCrmFieldHistoryRepository(db: CrmFieldHistoryDb) {
  return {
    async append(rows: CrmFieldHistoryAppendRow[]): Promise<void> {
      if (rows.length === 0) return;
      await db
        .insertInto("crm_field_history")
        .values(
          rows.map(
            (row): Insertable<CrmFieldHistoryTable> => ({
              id: randomUUID(),
              indexed_file_id: row.indexedFileId,
              entity_id: row.entityId,
              field: row.field,
              old_value: row.oldValue,
              new_value: row.newValue,
              source_modified_at: row.sourceModifiedAt,
            }),
          ),
        )
        .execute();
    },

    async listForEntity(entityId: string, opts: { limit: number; viewer: FileViewer }): Promise<CrmFieldHistoryRow[]> {
      let query = db
        .selectFrom("crm_field_history")
        .innerJoin("indexed_files", "indexed_files.id", "crm_field_history.indexed_file_id")
        .select([
          "crm_field_history.id",
          "crm_field_history.indexed_file_id",
          "crm_field_history.entity_id",
          "crm_field_history.field",
          "crm_field_history.old_value",
          "crm_field_history.new_value",
          "crm_field_history.observed_at",
          "crm_field_history.source_modified_at",
        ])
        .where("crm_field_history.entity_id", "=", entityId)
        .orderBy("crm_field_history.observed_at", "desc")
        .orderBy("crm_field_history.id", "desc")
        .limit(opts.limit);
      if (!opts.viewer.isAdmin) query = query.where(fileVisibilityPredicate(opts.viewer));
      return query.execute();
    },
  };
}
