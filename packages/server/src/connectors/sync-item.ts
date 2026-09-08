import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { type ZohoCrmSourceMeta, createConnectorRepository, readZohoCrmMeta } from "../db/repositories/connectors";
import { type CrmFieldHistoryAppendRow, createCrmFieldHistoryRepository } from "../db/repositories/crm-field-history";
import { createCrmRecordFieldsRepository } from "../db/repositories/crm-record-fields";
import { createRawContentRepository } from "../db/repositories/raw-contents";
import type { DB } from "../db/schema";
import { normalizeSourceTimestampForStorage } from "../timestamps";
import { clearEnrichmentData } from "./enrichment";
import { getSyncIdentity, getSyncIdentityForItem, syncIdentityKey } from "./sync-identity";
import type { ConnectorType, SyncedItem } from "./types";

type ConnectorRepository = ReturnType<typeof createConnectorRepository>;
type SyncItemDb = Kysely<DB> | Transaction<DB>;

const TRACKED_ZOHO_FIELDS = ["stage", "status", "leadStatus", "probability", "closingDate"] as const;

export type TrackedZohoField = (typeof TRACKED_ZOHO_FIELDS)[number];

export type ExistingContentHashMap = Map<
  string,
  {
    id: string;
    contentHash: string | null;
    contentCategory: string;
    contentIsNull: boolean;
    sourceUpdatedAt: string | null;
    rollupGroupId: string | null;
    sourceMeta: Record<string, unknown> | null;
    threadId: string | null;
  }
>;

export type ProcessSyncedItemResult =
  | { kind: "skipped_empty" }
  | { kind: "unchanged"; indexedFileId: string; rollupGroupIds: string[] }
  | { kind: "created"; indexedFileId: string; rollupGroupIds: string[] }
  | { kind: "updated"; indexedFileId: string; rollupGroupIds: string[] };

export interface ProcessSyncedItemParams {
  db: Kysely<DB>;
  repo: ConnectorRepository;
  connectorConfigId: string;
  connectorType: ConnectorType;
  item: SyncedItem;
  existingHashes: ExistingContentHashMap;
  encryptionKey?: string;
  logger?: Logger;
}

/**
 * Preload the content-hash map used for change detection during a sync.
 *
 * Scoped by `(connector_config_id = X OR provider_message_id IS NULL)` rather
 * than a blanket `connector_config_id = X`. Files keyed by provider_message_id
 * (and connector-scoped provider_file_id types) are only ever looked up under
 * the current config, so those rows are safely limited to this config — the big
 * win, since it drops every other config's message corpus that the old query
 * loaded and then discarded. But non-scoped provider_file_id sources (e.g.
 * google_drive) are deduped globally on `(source, provider_file_id)` and shared
 * across configs by `upsertFile`; a row first indexed by another config must
 * still resolve here, so those (provider_message_id IS NULL) rows are retained.
 * This keeps the map identical to the previous in-memory filter while shrinking
 * the loaded corpus for the high-volume message-based connectors.
 */
export async function loadExistingContentHashes(
  db: Kysely<DB>,
  connectorType: ConnectorType,
  connectorConfigId: string,
): Promise<ExistingContentHashMap> {
  const existingHashes: ExistingContentHashMap = new Map();
  const existingFiles = await db
    .selectFrom("indexed_files")
    .select([
      "id",
      "connector_config_id",
      "provider_file_id",
      "provider_message_id",
      "content_hash",
      "content_category",
      "source_updated_at",
      "rollup_group_id",
      "source_meta",
      "thread_id",
      sql<number>`CASE WHEN content IS NULL THEN 1 ELSE 0 END`.as("content_is_null"),
    ])
    .where("source", "=", connectorType)
    .where("is_archived", "=", 0)
    .where((eb) => eb.or([eb("connector_config_id", "=", connectorConfigId), eb("provider_message_id", "is", null)]))
    .execute();
  for (const f of existingFiles) {
    const identity = getSyncIdentity({
      connectorConfigId: f.connector_config_id,
      connectorType,
      providerFileId: f.provider_file_id,
      providerMessageId: f.provider_message_id,
    });
    if (identity.kind === "provider_file_id" || identity.connectorConfigId === connectorConfigId) {
      existingHashes.set(syncIdentityKey(identity), {
        id: f.id,
        contentHash: f.content_hash,
        contentCategory: f.content_category,
        contentIsNull: Number(f.content_is_null) === 1,
        sourceUpdatedAt: f.source_updated_at,
        rollupGroupId: f.rollup_group_id,
        sourceMeta: parseSourceMeta(f.source_meta),
        threadId: f.thread_id,
      });
    }
  }
  return existingHashes;
}

function parseSourceMeta(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Persist one synced item and its file access metadata. Changed/new item writes
 * run in a transaction and return after commit; fact emission remains in the
 * caller on the outer DB connection to avoid better-sqlite3 transaction lock
 * deadlocks with the entity/fact materialization path.
 */
export async function processSyncedItem({
  db,
  repo,
  connectorConfigId,
  connectorType,
  item,
  existingHashes,
  encryptionKey,
  logger,
}: ProcessSyncedItemParams): Promise<ProcessSyncedItemResult> {
  if (!item.fileName && !item.content) {
    return { kind: "skipped_empty" };
  }

  const existing = existingHashes.get(syncIdentityKey(getSyncIdentityForItem(item, connectorConfigId, connectorType)));
  const zohoFieldChanges =
    connectorType === "zoho_crm"
      ? diffTrackedZohoFields(readZohoCrmMeta(existing?.sourceMeta), readZohoCrmMeta(item.sourceMeta))
      : [];
  const rollupGroupIds = uniqueRollupGroupIds([existing?.rollupGroupId, item.rollupGroupId ?? null]);
  const sourceCreatedAt =
    item.sourceCreatedAt === null || item.sourceCreatedAt === undefined
      ? undefined
      : normalizeSourceTimestampForStorage(item.sourceCreatedAt);
  const sourceUpdatedAt =
    item.sourceUpdatedAt === null || item.sourceUpdatedAt === undefined
      ? undefined
      : normalizeSourceTimestampForStorage(item.sourceUpdatedAt);
  const hashlessSourceVersionChanged =
    existing !== undefined &&
    existing.contentHash === null &&
    item.contentHash === null &&
    existing.contentIsNull &&
    item.content === null &&
    sourceUpdatedAt !== undefined &&
    sourceUpdatedAt !== existing.sourceUpdatedAt;

  if (
    existing &&
    existing.contentHash === item.contentHash &&
    existing.contentCategory === item.contentCategory &&
    !hashlessSourceVersionChanged
  ) {
    /**
     * Raw content persists before the metadata update: when it fails, the
     * update below omits source_meta so the connector's detail marker for this
     * run is not saved and the next incremental sync re-fetches the detail.
     */
    const rawContentPersisted = await persistRawContent(db, existing.id, item, logger);
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("indexed_files")
        .set({
          synced_at: new Date().toISOString(),
          provider_file_id: item.providerFileId,
          provider_message_id: item.providerMessageId ?? undefined,
          thread_id: item.threadId ?? undefined,
          file_name: item.fileName ?? undefined,
          source_path: item.sourcePath ?? undefined,
          provider_url: item.providerUrl ?? undefined,
          file_type: item.fileType ?? undefined,
          content_category: item.contentCategory ?? undefined,
          source_created_at: sourceCreatedAt,
          source_updated_at: sourceUpdatedAt,
          ...(item.isAllDay !== undefined ? { is_all_day: item.isAllDay ? 1 : 0 } : {}),
          mime_type: item.mimeType ?? undefined,
          rollup_group_id: item.rollupGroupId ?? null,
          ...(item.sourceMeta !== undefined && rawContentPersisted
            ? { source_meta: JSON.stringify(item.sourceMeta) }
            : {}),
        })
        .where("id", "=", existing.id)
        .execute();
      if (rawContentPersisted) {
        await appendZohoFieldHistory(trx, existing.id, item.providerFileId, sourceUpdatedAt ?? null, zohoFieldChanges);
        if (item.sourceMeta !== undefined) await syncCrmRecordFields(trx, existing.id, item.sourceMeta);
      }
    });
    await repo.linkConnectorFile(connectorConfigId, existing.id);
    await syncItemAccess(repo, connectorConfigId, existing.id, item);
    return { kind: "unchanged", indexedFileId: existing.id, rollupGroupIds };
  }

  const itemResult = await db.transaction().execute(async (trx) => {
    const txRepo = createConnectorRepository(trx, encryptionKey);
    const upsertResult = await txRepo.upsertFile({
      connectorConfigId,
      source: connectorType,
      providerFileId: item.providerFileId,
      providerMessageId: item.providerMessageId,
      threadId: item.threadId,
      providerUrl: item.providerUrl,
      fileName: item.fileName,
      fileType: item.fileType,
      contentCategory: item.contentCategory,
      content: item.content,
      sourcePath: item.sourcePath,
      sourceMeta: item.sourceMeta,
      enrichmentRefresh: item.enrichmentRefresh,
      contentHash: item.contentHash,
      sourceCreatedAt: item.sourceCreatedAt,
      sourceUpdatedAt: item.sourceUpdatedAt,
      isAllDay: item.isAllDay,
      mimeType: item.mimeType,
      rollupGroupId: item.rollupGroupId ?? null,
    });

    const embeddingsOnlyContentRefresh =
      item.enrichmentRefresh === "embeddings_only" &&
      upsertResult.contentChanged &&
      !upsertResult.categoryChanged &&
      !upsertResult.sourceVersionChanged;
    if (
      !embeddingsOnlyContentRefresh &&
      (upsertResult.contentChanged || upsertResult.categoryChanged || upsertResult.sourceVersionChanged)
    ) {
      await clearEnrichmentData(trx, upsertResult.id);
    }

    await txRepo.linkConnectorFile(connectorConfigId, upsertResult.id);
    await syncItemAccess(txRepo, connectorConfigId, upsertResult.id, item);
    await appendZohoFieldHistory(trx, upsertResult.id, item.providerFileId, sourceUpdatedAt ?? null, zohoFieldChanges);
    await syncCrmRecordFields(trx, upsertResult.id, item.sourceMeta);
    return upsertResult;
  });

  /**
   * Raw content persists after commit, never inside the transaction: a failed
   * statement aborts a Postgres transaction, so catching and continuing there
   * is not portable. If the raw write fails, the compensating update drops the
   * connector's detail marker from source_meta so the next incremental sync
   * re-fetches the detail (self-healing); the indexed file itself survives.
   */
  const rawContentPersisted = await persistRawContent(db, itemResult.id, item, logger);
  if (!rawContentPersisted && item.sourceMeta !== undefined) {
    await removeDetailMarker(db, itemResult.id, item.sourceMeta, logger);
  }

  return { kind: itemResult.created ? "created" : "updated", indexedFileId: itemResult.id, rollupGroupIds };
}

export function diffTrackedZohoFields(
  before: ZohoCrmSourceMeta | null,
  after: ZohoCrmSourceMeta | null,
): Array<{ field: TrackedZohoField; oldValue: string; newValue: string }> {
  if (!before || !after) return [];
  return TRACKED_ZOHO_FIELDS.flatMap((field) => {
    const oldValue = before[field];
    const newValue = after[field];
    if (!oldValue || !newValue || oldValue === newValue) return [];
    return [{ field, oldValue, newValue }];
  });
}

async function appendZohoFieldHistory(
  db: SyncItemDb,
  indexedFileId: string,
  providerFileId: string,
  sourceModifiedAt: string | null,
  changes: ReturnType<typeof diffTrackedZohoFields>,
): Promise<void> {
  if (changes.length === 0) return;
  const entity = await db
    .selectFrom("entity_source_refs")
    .select("entity_id")
    .where("source", "=", "zoho_crm")
    .where("source_id", "=", providerFileId)
    .executeTakeFirst();
  const rows: CrmFieldHistoryAppendRow[] = changes.map((change) => ({
    indexedFileId,
    entityId: entity?.entity_id ?? null,
    field: change.field,
    oldValue: change.oldValue,
    newValue: change.newValue,
    sourceModifiedAt,
  }));
  await createCrmFieldHistoryRepository(db).append(rows);
}

async function syncCrmRecordFields(
  db: SyncItemDb,
  indexedFileId: string,
  sourceMeta: Record<string, unknown> | undefined,
): Promise<void> {
  await createCrmRecordFieldsRepository(db).replaceForFile(indexedFileId, readZohoCrmMeta(sourceMeta));
}

/** Returns true when there was nothing to persist or the upsert succeeded. */
async function persistRawContent(
  db: Kysely<DB>,
  indexedFileId: string,
  item: SyncedItem,
  logger?: Logger,
): Promise<boolean> {
  if (!item.rawContent) return true;
  try {
    await createRawContentRepository(db).upsertRawContent({
      indexedFileId,
      kind: item.rawContent.kind,
      content: item.rawContent.content,
    });
    return true;
  } catch (err) {
    logger?.error({ err, indexedFileId, kind: item.rawContent.kind }, "Raw content persist failed");
    return false;
  }
}

async function removeDetailMarker(
  db: Kysely<DB>,
  indexedFileId: string,
  sourceMeta: Record<string, unknown>,
  logger?: Logger,
): Promise<void> {
  if (!("detail" in sourceMeta)) return;
  const { detail: _detail, ...rest } = sourceMeta;
  try {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("indexed_files")
        .set({ source_meta: Object.keys(rest).length > 0 ? JSON.stringify(rest) : null })
        .where("id", "=", indexedFileId)
        .execute();
      await syncCrmRecordFields(trx, indexedFileId, rest);
    });
  } catch (err) {
    logger?.error({ err, indexedFileId }, "Detail marker compensation failed; raw content missing until backfill");
  }
}

function uniqueRollupGroupIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

async function syncItemAccess(
  repo: ConnectorRepository,
  connectorConfigId: string,
  indexedFileId: string,
  item: SyncedItem,
): Promise<void> {
  if (item.accessScope) {
    const scopeId = await repo.upsertAccessScope(connectorConfigId, item.accessScope);
    await repo.setFileAccessScope(indexedFileId, scopeId);
    if (item.accessPrincipals !== undefined && item.accessPrincipals !== null) {
      if (item.accessPrincipals.length === 0) {
        await repo.syncFileAccessEmails(indexedFileId, []);
      } else {
        await repo.grantFileAccessEmails(indexedFileId, item.accessPrincipals);
      }
    }
  } else if (item.accessPrincipals !== undefined && item.accessPrincipals !== null) {
    await repo.syncFileAccessEmails(indexedFileId, item.accessPrincipals);
  }
}
