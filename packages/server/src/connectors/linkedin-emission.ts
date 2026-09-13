import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { type ConversationSliceRow, createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createConversationTopicsRepository } from "../db/repositories/conversation-topics";
import type { DB } from "../db/schema";
import { configDefault, resolveChunkEngineKnobs } from "./config-default";
import {
  type ConversationSliceEmissionAnchor,
  buildEmissionAnchor,
  emissionRefreshTier,
  parseEmissionAnchor,
} from "./emission-refresh-tier";
import type { LinkedinVisibilityMode } from "./enrichment/scope";
import {
  type OrderedMessage,
  linkedinAccessPrincipals,
  linkedinProfileProviderFileId,
  renderConversationSegment,
  segmentDirectionStats,
  segmentFileName,
} from "./linkedin-aimfox";
import { loadPendingLinkedinHistory, parseLinkedinChunkRosterSnapshot } from "./linkedin-chunk-adapter";
import { LINKEDIN_CONVERSATION_KIND, LINKEDIN_CONVERSATION_PLATFORM } from "./linkedin-ingest";
import { type SliceKeysetCursor, sliceKeysetAfter, stableContentHash } from "./sync-utils";
import type { SyncedItem } from "./types";

export const LINKEDIN_CONVERSATION_FILE_TYPE = "linkedin_conversation";
export const LINKEDIN_EMISSION_REFRESH_DAYS = 7;
export const LINKEDIN_EMISSION_PAGE_SIZE = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The schema-default rung of each ladder, so a caller only has to pass the
 * value it actually resolved from `appConfig`. `minMessages` is deliberately
 * not the engine's `LINKEDIN_CHUNK_MIN_MESSAGES`: see the option's docstring.
 */
export const LINKEDIN_EMISSION_DEFAULTS = {
  minMessages: 1,
  refreshMessages: resolveChunkEngineKnobs("LINKEDIN_CHUNK", undefined).provisionalRefreshMessages,
  refreshMaxMinutes: configDefault("LINKEDIN_CHUNK_PROVISIONAL_REFRESH_MAX_MINUTES"),
};

/**
 * Why a kept slice produced no synced item, mirroring the WhatsApp tally so a
 * pipeline that looks dead can say which gate stopped it. The reasons differ
 * from WhatsApp's — LinkedIn has no per-group access scope and instead fails
 * closed on a slice whose roster snapshot cannot be read — so the type is its
 * own rather than a widened shared union.
 */
export type LinkedinEmissionSkipReason =
  | "missing_roster_snapshot"
  | "no_messages"
  | "below_min_messages"
  | "unchanged_content";

interface LinkedinSliceContext {
  slice: ConversationSliceRow;
  conversationId: number;
  providerConversationId: string;
}

interface LinkedinSliceMessageRow {
  id: number;
  sender_jid: string;
  sender_name: string;
  is_bot: number;
  text: string;
  provider_timestamp: string | null;
  provider_from_me: number;
}

export interface EmitLinkedinSyncedItemsOptions {
  db: Kysely<DB>;
  logger: Logger;
  visibility: LinkedinVisibilityMode;
  ownerEmail: string;
  /** `LINKEDIN_CHUNK_PROVISIONAL_REFRESH_MESSAGES`, the message-count gate of the two-tier refresh. */
  refreshMessages?: number;
  /** `LINKEDIN_CHUNK_PROVISIONAL_REFRESH_MAX_MINUTES`, the wall-clock gate. */
  refreshMaxMinutes?: number;
  /**
   * Emission floor for an open slice, deliberately 1 while the engine floor is
   * 2. A lead's single-message reply that opens a new topic ("not interested,
   * but ask me about X") would otherwise have no file until idle-close 72 hours
   * later, and the stale-anchor sweep cannot see a slice that has no file.
   */
  minMessages?: number;
  /**
   * Aimfox accounts whose conversations this run owns, matched against the
   * `${accountId}:${conversationUrn}` provider id. The page query stays
   * unfiltered and the prefix is applied in code: a `LIKE` would need
   * dialect-specific escaping for an account id containing a wildcard, and the
   * slice pages are small. Omit to emit every LinkedIn conversation.
   */
  accountIds?: string[];
  emissionRefreshDays?: number;
  now?: Date;
  /**
   * Carries the slice's conversation as well as the reason: a caller that
   * archives one generation against the other has to know which conversation
   * came out of the emitter short.
   */
  onSkipReason?: (reason: LinkedinEmissionSkipReason, providerConversationId: string) => void;
  /**
   * Every conversation whose kept slices this emission actually looked at,
   * whether or not any of them yielded an item. A caller that archives one
   * generation against the other has to gate on visits rather than on yields:
   * a conversation whose slices are all published already yields nothing, and
   * gating on yields would strand it if its archive were ever lost.
   */
  onVisitedConversation?: (providerConversationId: string) => void;
  onPageListedSliceCount?: (count: number) => void;
}

function normalizeEmissionRefreshDays(value: number | undefined): number {
  return Number.isInteger(value) && value && value > 0 ? value : LINKEDIN_EMISSION_REFRESH_DAYS;
}

function parseDenoisedMessageIds(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.filter((value): value is number => Number.isInteger(value) && value > 0);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

const SLICE_MESSAGE_COLUMNS = [
  "id",
  "sender_jid",
  "sender_name",
  "is_bot",
  "text",
  "provider_timestamp",
  "provider_from_me",
] as const;

async function listSliceMessages(db: Kysely<DB>, slice: ConversationSliceRow): Promise<LinkedinSliceMessageRow[]> {
  const denoisedIds = parseDenoisedMessageIds(slice.denoised_message_ids);
  if (!denoisedIds) {
    return db
      .selectFrom("conversation_messages")
      .select(SLICE_MESSAGE_COLUMNS)
      .where("conversation_id", "=", slice.conversation_id)
      .where("id", ">=", slice.first_message_id)
      .where("id", "<=", slice.last_message_id)
      .orderBy("id", "asc")
      .execute();
  }
  const rows = await db
    .selectFrom("conversation_messages")
    .select(SLICE_MESSAGE_COLUMNS)
    .where("id", "in", denoisedIds)
    .execute();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return denoisedIds.map((id) => byId.get(id)).filter((row): row is LinkedinSliceMessageRow => row !== undefined);
}

/**
 * Rebuilds the shape the legacy renderer and direction counter take, so both
 * survive the move to the engine unchanged. `sender.id` is derived from
 * `provider_from_me` rather than the stored jid, which is what makes the
 * manifest a pure function of the direction column, and `automated` from
 * `is_bot`, which is what keeps the renderer's `(automated)` tag. Direction is
 * unaffected: a campaign message is still counted as outbound.
 */
function toOrderedMessage(row: LinkedinSliceMessageRow, accountId: string): OrderedMessage {
  return {
    identity: String(row.id),
    timestamp: row.provider_timestamp,
    message: {
      body: row.text,
      sender: { id: row.provider_from_me === 1 ? accountId : row.sender_jid, full_name: row.sender_name },
      created_at: 0,
      automated: row.is_bot === 1,
    },
  };
}

async function listSliceContextPage(
  db: Kysely<DB>,
  refreshCutoff: string,
  cursor: SliceKeysetCursor | null,
  limit: number,
): Promise<LinkedinSliceContext[]> {
  let query = db
    .selectFrom("conversation_slices")
    .innerJoin("conversations", "conversations.id", "conversation_slices.conversation_id")
    .selectAll("conversation_slices")
    .select("conversations.provider_conversation_id")
    .where("conversations.platform", "=", LINKEDIN_CONVERSATION_PLATFORM)
    .where("conversations.kind", "=", LINKEDIN_CONVERSATION_KIND)
    .where("conversation_slices.salience_verdict", "=", "kept")
    .where((eb) =>
      eb.or([
        eb("conversation_slices.indexed_file_id", "is", null),
        eb("conversation_slices.status", "=", "open"),
        eb("conversation_slices.ended_at", ">=", refreshCutoff),
      ]),
    )
    .orderBy("conversation_slices.started_at", "asc")
    .orderBy("conversation_slices.id", "asc");
  if (cursor) query = query.where(sliceKeysetAfter("conversation_slices.started_at", cursor, "asc"));
  const rows = await query.limit(limit).execute();
  return rows.map((row) => {
    const { provider_conversation_id, ...slice } = row;
    return {
      slice: slice as ConversationSliceRow,
      conversationId: slice.conversation_id,
      providerConversationId: provider_conversation_id,
    };
  });
}

interface LinkedinSliceEmission {
  item: SyncedItem | null;
  skipReason: LinkedinEmissionSkipReason | null;
}

async function syncedItemForKeptSlice(
  db: Kysely<DB>,
  context: LinkedinSliceContext,
  options: EmitLinkedinSyncedItemsOptions,
  now: Date,
): Promise<LinkedinSliceEmission> {
  const roster = parseLinkedinChunkRosterSnapshot(context.slice.roster_snapshot);
  if (!roster) {
    options.logger.warn(
      { sliceId: context.slice.id, conversationId: context.conversationId },
      "Skipped LinkedIn slice indexing because its roster snapshot could not be read",
    );
    return { item: null, skipReason: "missing_roster_snapshot" };
  }
  const rows = await listSliceMessages(db, context.slice);
  if (rows.length === 0) return { item: null, skipReason: "no_messages" };

  const messages = rows.map((row) => toOrderedMessage(row, roster.accountId));
  const content = renderConversationSegment({
    ownerName: roster.ownerName,
    leadName: roster.leadName,
    messages,
  });
  const contentHash = stableContentHash(content);
  const emittedAt = now.toISOString();
  let enrichmentRefresh: "full" | "embeddings_only" = "full";
  let previousEmission: ConversationSliceEmissionAnchor | null = null;

  if (context.slice.status === "open") {
    const minMessages = options.minMessages ?? LINKEDIN_EMISSION_DEFAULTS.minMessages;
    if (context.slice.message_count < minMessages) return { item: null, skipReason: "below_min_messages" };
    const indexedFileId =
      context.slice.indexed_file_id ??
      (await createConversationSlicesRepository(db).findLiveSliceFile(
        context.slice.id,
        LINKEDIN_CONVERSATION_FILE_TYPE,
      ));
    if (indexedFileId) {
      const existing = await db
        .selectFrom("indexed_files")
        .select(["content_hash", "source_meta"])
        .where("id", "=", indexedFileId)
        .executeTakeFirst();
      previousEmission = parseEmissionAnchor(existing?.source_meta ?? null);
      enrichmentRefresh = emissionRefreshTier({
        status: context.slice.status,
        firstMessageId: context.slice.first_message_id,
        messageCount: context.slice.message_count,
        previous: previousEmission,
        refreshMessages: options.refreshMessages ?? LINKEDIN_EMISSION_DEFAULTS.refreshMessages,
        refreshMaxMinutes: options.refreshMaxMinutes ?? LINKEDIN_EMISSION_DEFAULTS.refreshMaxMinutes,
        now,
      });
      /**
       * The stale-anchor lane. Unchanged content normally ends the emission,
       * but an open slice whose last enrichment ran over fewer messages than
       * the file now holds must still be re-emitted once the time gate expires:
       * that is the only way a conversation that goes quiet after a tier-one
       * emission gets its promised full pass. The sync seam turns this into
       * `enrichment_refreshed`.
       */
      if (existing?.content_hash === contentHash) {
        const enrichmentDue =
          previousEmission !== null && previousEmission.enrichedMessageCount < previousEmission.messageCount;
        if (enrichmentRefresh !== "full" || !enrichmentDue) return { item: null, skipReason: "unchanged_content" };
      }
    }
  }

  const dated = messages.filter((message) => message.timestamp !== null);
  const firstTimestamp = dated[0]?.timestamp ?? null;
  const lastTimestamp = dated.at(-1)?.timestamp ?? null;
  const direction = segmentDirectionStats(messages, roster.accountId);
  const topics = await createConversationTopicsRepository(db).listSliceTopics(context.slice.id);

  return {
    skipReason: null,
    item: {
      providerFileId: context.slice.id,
      conversationSliceId: context.slice.id,
      threadId: context.providerConversationId,
      providerUrl: null,
      fileName: segmentFileName(roster.ownerName, roster.leadName, firstTimestamp, lastTimestamp),
      fileType: LINKEDIN_CONVERSATION_FILE_TYPE,
      contentCategory: "document",
      content,
      sourcePath: `LinkedIn / ${roster.leadName}`,
      sourceMeta: {
        ...buildEmissionAnchor({
          firstMessageId: context.slice.first_message_id,
          messageCount: context.slice.message_count,
          emittedAt,
          refreshTier: enrichmentRefresh,
          previous: previousEmission,
        }),
        linkedinAimfox: {
          accountId: roster.accountId,
          conversationUrn: roster.conversationUrn,
          kind: "conversation_slice",
          sliceId: context.slice.id,
          topics: topics.map((topic) => topic.name),
          segmentManifest: {
            messageCount: messages.length,
            inboundCount: direction.inboundCount,
            outboundCount: direction.outboundCount,
            lastInboundAt: direction.lastInboundAt,
            lastOutboundAt: direction.lastOutboundAt,
          },
        },
      },
      enrichmentRefresh,
      rollupGroupId: linkedinProfileProviderFileId(roster.accountId, roster.leadId),
      contentHash,
      sourceCreatedAt: firstTimestamp,
      sourceUpdatedAt: lastTimestamp,
      mimeType: "text/plain",
      accessPrincipals: linkedinAccessPrincipals(options.visibility, options.ownerEmail),
      parentEntities: [
        {
          source: "aimfox",
          sourceId: roster.leadId,
          contextSnippet: `LinkedIn conversation with ${roster.leadName}`,
        },
      ],
    },
  };
}

function ownedByAccounts(providerConversationId: string, accountIds: string[] | undefined): boolean {
  if (!accountIds) return true;
  return accountIds.some((accountId) => providerConversationId.startsWith(`${accountId}:`));
}

/**
 * Holds a conversation's whole generation back until its history backlog has
 * been chunked (D12). Publishing the prefix the engine has cut so far would put
 * it on the timeline beside the legacy generation that still covers the thread
 * in full, which is the doubling the cutover exists to avoid.
 *
 * Memoised per emission: the engine has already stopped for this run, so the
 * answer cannot change while the pages are walked.
 */
async function historyPending(db: Kysely<DB>, conversationId: number, memo: Map<number, boolean>): Promise<boolean> {
  const known = memo.get(conversationId);
  if (known !== undefined) return known;
  const pending = (await loadPendingLinkedinHistory(db, conversationId, 1)).rows.length > 0;
  memo.set(conversationId, pending);
  return pending;
}

/**
 * One `SyncedItem` per kept LinkedIn conversation slice, paged by a
 * (started_at, id) keyset so a long history never loads at once.
 */
export async function* emitLinkedinSyncedItems(options: EmitLinkedinSyncedItemsOptions): AsyncGenerator<SyncedItem> {
  const now = options.now ?? new Date();
  const refreshCutoff = new Date(
    now.getTime() - normalizeEmissionRefreshDays(options.emissionRefreshDays) * DAY_MS,
  ).toISOString();
  let cursor: SliceKeysetCursor | null = null;
  const pendingHistoryMemo = new Map<number, boolean>();
  for (;;) {
    const page = await listSliceContextPage(options.db, refreshCutoff, cursor, LINKEDIN_EMISSION_PAGE_SIZE);
    options.onPageListedSliceCount?.(page.length);
    const last = page.at(-1);
    if (!last) break;
    cursor = { timestamp: last.slice.started_at, id: last.slice.id };
    for (const context of page) {
      if (!ownedByAccounts(context.providerConversationId, options.accountIds)) continue;
      if (await historyPending(options.db, context.conversationId, pendingHistoryMemo)) continue;
      options.onVisitedConversation?.(context.providerConversationId);
      const { item, skipReason } = await syncedItemForKeptSlice(options.db, context, options, now);
      if (skipReason) options.onSkipReason?.(skipReason, context.providerConversationId);
      if (item) yield item;
    }
    if (page.length < LINKEDIN_EMISSION_PAGE_SIZE) break;
  }
}
