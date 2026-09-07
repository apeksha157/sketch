import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createConnectorRepository } from "../db/repositories/connectors";
import { type ConversationSliceRow, createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { type WhatsAppGroupIndexingConfig, createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import {
  type WhatsAppRosterParticipantSnapshot,
  type WhatsAppRosterSnapshot,
  buildWhatsAppRosterSnapshot,
  captureWhatsAppLidForPhone,
  normalizeWhatsAppIdentityLid,
  normalizeWhatsAppIdentityPhone,
  stableWhatsAppParticipantJidRef,
} from "../whatsapp/identity-resolution";
import { sanitizeWhatsAppDisplayText } from "../whatsapp/privacy";
import {
  type ConversationSliceEmissionAnchor,
  buildEmissionAnchor,
  emissionRefreshTier,
  parseEmissionAnchor,
} from "./emission-refresh-tier";
import {
  type SliceKeysetCursor,
  buildSliceSourcePath,
  formatSliceTimeRange,
  sliceKeysetAfter,
  stableContentHash,
} from "./sync-utils";
import { renderTranscriptLine } from "./transcript";
import {
  type AccessPrincipal,
  type SyncedItem,
  WHATSAPP_CONVERSATION_SLICE_FILE_TYPE,
  toEmailPrincipals,
} from "./types";
import {
  DEFAULT_WHATSAPP_LLM_CHUNK_MIN_MESSAGES,
  DEFAULT_WHATSAPP_LLM_CHUNK_PROVISIONAL_REFRESH_MESSAGES,
} from "./whatsapp-chunker";

export const DEFAULT_WHATSAPP_PROVISIONAL_REFRESH_MAX_MINUTES = 120;
export const WHATSAPP_EMISSION_REFRESH_DAYS = 7;
export const WHATSAPP_EMISSION_PAGE_SIZE = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_WHATSAPP_JID_PATTERN = /[^\s"'<>()[\]{}]+@(?:s\.whatsapp\.net|lid)\b/iu;
const RAW_CONTIGUOUS_PHONE_PATTERN = /\+?[1-9]\d{9,14}\b/u;

export interface WhatsAppTranscriptMessage {
  id: number;
  senderJid: string;
  senderName: string;
  text: string;
}

interface SliceContext {
  slice: ConversationSliceRow;
  conversationId: number;
  groupJid: string;
  groupName: string;
  chunkMinMessages?: number | null;
  chunkProvisionalRefreshMessages?: number | null;
}

interface RenderedSlice {
  serializedRosterSnapshot: string;
  content: string;
  accessPrincipals: AccessPrincipal[];
}

function normalizeEmissionRefreshDays(value: number | undefined): number {
  return Number.isInteger(value) && value && value > 0 ? value : WHATSAPP_EMISSION_REFRESH_DAYS;
}

export function assertNoRawWhatsAppIdentifiers(value: string): void {
  if (RAW_WHATSAPP_JID_PATTERN.test(value) || RAW_CONTIGUOUS_PHONE_PATTERN.test(value)) {
    throw new Error("Rendered WhatsApp indexing content contains a raw phone or WhatsApp identifier");
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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

async function listSliceMessages(db: Kysely<DB>, slice: ConversationSliceRow): Promise<WhatsAppTranscriptMessage[]> {
  const denoisedIds = parseDenoisedMessageIds(slice.denoised_message_ids);
  const rows = denoisedIds
    ? await db
        .selectFrom("conversation_messages")
        .select(["id", "sender_jid", "sender_name", "text"])
        .where("id", "in", denoisedIds)
        .execute()
    : await db
        .selectFrom("conversation_messages")
        .select(["id", "sender_jid", "sender_name", "text"])
        .where("conversation_id", "=", slice.conversation_id)
        .where("id", ">=", slice.first_message_id)
        .where("id", "<=", slice.last_message_id)
        .where("is_bot", "=", 0)
        .orderBy("id", "asc")
        .execute();

  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = denoisedIds
    ? denoisedIds.map((id) => byId.get(id)).filter((row): row is (typeof rows)[number] => !!row)
    : rows;
  return ordered.map((row) => ({
    id: row.id,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    text: row.text,
  }));
}

function rosterBySenderRef(snapshot: WhatsAppRosterSnapshot): Map<string, WhatsAppRosterParticipantSnapshot> {
  const out = new Map<string, WhatsAppRosterParticipantSnapshot>();
  for (const participant of snapshot.participants) {
    for (const senderRef of participant.senderJidRefs) {
      out.set(senderRef, participant);
    }
  }
  return out;
}

function renderFallbackSenderName(message: Pick<WhatsAppTranscriptMessage, "senderName">): string {
  const sanitized = sanitizeWhatsAppDisplayText(message.senderName);
  return sanitized.length > 0 ? sanitized : "External (unknown)";
}

export function renderWhatsAppTranscript(
  snapshot: WhatsAppRosterSnapshot,
  messages: WhatsAppTranscriptMessage[],
): string {
  const bySenderRef = rosterBySenderRef(snapshot);
  const lines = messages
    .map((message) => {
      const senderRef = stableWhatsAppParticipantJidRef(message.senderJid);
      const participant = bySenderRef.get(senderRef);
      const displayName = participant?.displayName ?? renderFallbackSenderName(message);
      const text = sanitizeWhatsAppDisplayText(message.text);
      if (!text) return null;
      return renderTranscriptLine({ name: displayName, text });
    })
    .filter((line): line is string => line !== null);
  const transcript = lines.join("\n");
  assertNoRawWhatsAppIdentifiers(transcript);
  return transcript;
}

/**
 * Re-emits unlinked slices plus recent linked slices. Recent linked slices refresh
 * indexed content when roster improvements add labels or CRM matches; older linked
 * slices are stable.
 *
 * Paged by a (started_at, id) keyset so a group with a long kept-slice history
 * never loads the whole set into memory; the ordering is the page key, so
 * emission order is deterministic across pages and runs.
 */
async function listKeptSliceContextPage(
  db: Kysely<DB>,
  refreshCutoff: string,
  cursor: SliceKeysetCursor | null,
  limit: number,
): Promise<SliceContext[]> {
  let query = db
    .selectFrom("conversation_slices")
    .innerJoin("conversations", "conversations.id", "conversation_slices.conversation_id")
    .innerJoin("whatsapp_groups", "whatsapp_groups.jid", "conversations.provider_conversation_id")
    .selectAll("conversation_slices")
    .select([
      "conversations.provider_conversation_id as group_jid",
      "conversations.display_name as conversation_display_name",
      "whatsapp_groups.name as group_name",
      "whatsapp_groups.chunk_min_messages as chunk_min_messages",
      "whatsapp_groups.chunk_provisional_refresh_messages as chunk_provisional_refresh_messages",
    ])
    .where("conversations.platform", "=", "whatsapp")
    .where("conversations.kind", "=", "group")
    .where("whatsapp_groups.index_enabled", "=", 1)
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

  return rows.map((row) => ({
    slice: row,
    conversationId: row.conversation_id,
    groupJid: row.group_jid,
    groupName: row.group_name ?? row.conversation_display_name ?? "WhatsApp group",
    chunkMinMessages: row.chunk_min_messages,
    chunkProvisionalRefreshMessages: row.chunk_provisional_refresh_messages,
  }));
}

async function loadWhatsAppAccessPrincipals(
  db: Kysely<DB>,
  groupJid: string,
  snapshot: WhatsAppRosterSnapshot,
): Promise<AccessPrincipal[]> {
  const userIds = uniqueStrings(
    snapshot.participants
      .filter((participant) => participant.resolutionKind === "teammate" && !!participant.userId)
      .map((participant) => participant.userId as string),
  );
  const users =
    userIds.length === 0
      ? []
      : await db
          .selectFrom("users")
          .select(["id", "email"])
          .where("id", "in", userIds)
          .where("email", "is not", null)
          .execute();
  const participants = await db
    .selectFrom("whatsapp_group_participants")
    .select(["phone_e164", "lid"])
    .where("group_jid", "=", groupJid)
    .execute();
  const principals: AccessPrincipal[] = [];
  for (const participant of participants) {
    const phone = normalizeWhatsAppIdentityPhone(participant.phone_e164);
    const lid = normalizeWhatsAppIdentityLid(participant.lid);
    await captureWhatsAppLidForPhone(db, phone, lid);
    if (phone) principals.push({ type: "phone", value: phone });
    if (lid) principals.push({ type: "whatsapp_lid", value: lid });
  }
  principals.push(...toEmailPrincipals(users.map((row) => row.email ?? "")));
  return [...new Map(principals.map((principal) => [`${principal.type}\u0000${principal.value}`, principal])).values()];
}

async function renderSlice(db: Kysely<DB>, context: SliceContext, logger: Logger): Promise<RenderedSlice> {
  const roster = await buildWhatsAppRosterSnapshot({
    db,
    groupJid: context.groupJid,
    conversationId: context.conversationId,
    logger,
    enrichEntityAliases: true,
  });
  const messages = await listSliceMessages(db, context.slice);
  const transcript = renderWhatsAppTranscript(roster.snapshot, messages);
  /**
   * Stored content is transcript-only (plus the group header), matching the
   * email/Fireflies convention: participant rosters stay out of the body so
   * they never pollute embeddings or the entity extractor. ACLs come from the
   * roster snapshot.
   */
  const titleGroup = sanitizeWhatsAppDisplayText(context.groupName) || "WhatsApp group";
  const content = `Group: ${titleGroup}\n\nTranscript:\n${transcript}`;
  assertNoRawWhatsAppIdentifiers(content);
  return {
    serializedRosterSnapshot: roster.serializedSnapshot,
    content,
    accessPrincipals: await loadWhatsAppAccessPrincipals(db, context.groupJid, roster.snapshot),
  };
}

function sourcePathForSlice(context: SliceContext): string {
  return buildSliceSourcePath("whatsapp", context.slice.id, {
    conversationId: String(context.conversationId),
    firstMessageId: String(context.slice.first_message_id),
    lastMessageId: String(context.slice.last_message_id),
    startedAt: context.slice.started_at,
    endedAt: context.slice.ended_at,
  });
}

function renderedMessageCount(content: string | null): number {
  const transcript = content?.split("\n\nTranscript:\n")[1] ?? "";
  return transcript ? transcript.split("\n").length : 0;
}

/**
 * Files created before emission anchors existed bootstrap at tier one when the
 * rendered message count is unchanged, avoiding a rollout-wide LLM refresh.
 * Synthesizing the anchor the shared tier rule would have read is what keeps
 * that legacy allowance WhatsApp-only: Slack has no such files and keeps
 * treating a missing anchor as a full refresh.
 */
function bootstrapEmissionAnchor(
  slice: ConversationSliceRow,
  existingContent: string | null,
  emittedAt: string,
): ConversationSliceEmissionAnchor | null {
  if (slice.message_count !== renderedMessageCount(existingContent)) return null;
  return {
    firstMessageId: slice.first_message_id,
    messageCount: slice.message_count,
    emittedAt,
    enrichedMessageCount: slice.message_count,
    enrichedAt: emittedAt,
  };
}

/**
 * Why a kept slice produced no synced item. Emission previously reported a bare
 * `emitted: 0` with a single `skippedNoScope` counter, so the far more common
 * skips — an open slice under the message threshold, or content that has not
 * changed since the last file — were indistinguishable from "there was nothing
 * to do". Debugging a pipeline that looks dead always asks "why not", and a
 * count alone cannot answer it.
 */
export type WhatsAppEmissionSkipReason = "no_access_scope" | "below_min_messages" | "unchanged_content";

async function syncedItemForKeptSlice(
  db: Kysely<DB>,
  context: SliceContext,
  logger: Logger,
  now: Date,
  provisionalRefreshMaxMinutes: number,
): Promise<{ item: SyncedItem | null; skippedNoScope: boolean; skipReason: WhatsAppEmissionSkipReason | null }> {
  const rendered = await renderSlice(db, context, logger);
  if (rendered.serializedRosterSnapshot !== context.slice.roster_snapshot) {
    await db
      .updateTable("conversation_slices")
      .set({ roster_snapshot: rendered.serializedRosterSnapshot })
      .where("id", "=", context.slice.id)
      .execute();
  }
  if (rendered.accessPrincipals.length === 0) {
    await createConversationSlicesRepository(db).archiveSliceFile(
      context.slice.id,
      WHATSAPP_CONVERSATION_SLICE_FILE_TYPE,
    );
    logger.warn(
      { sliceId: context.slice.id, conversationId: context.conversationId, groupJid: context.groupJid },
      "Skipped WhatsApp slice indexing because no teammate access scope resolved",
    );
    return { item: null, skippedNoScope: true, skipReason: "no_access_scope" };
  }
  const titleGroup = sanitizeWhatsAppDisplayText(context.groupName) || "WhatsApp group";
  const content = rendered.content;
  const contentHash = stableContentHash(content);
  const emittedAt = now.toISOString();
  let enrichmentRefresh: "full" | "embeddings_only" = "full";
  let previousEmission: ConversationSliceEmissionAnchor | null = null;
  if (context.slice.status === "open") {
    const minMessages = context.chunkMinMessages ?? DEFAULT_WHATSAPP_LLM_CHUNK_MIN_MESSAGES;
    if (context.slice.message_count < minMessages) {
      logger.debug(
        {
          sliceId: context.slice.id,
          groupJid: context.groupJid,
          messageCount: context.slice.message_count,
          minMessages,
        },
        "Skipped WhatsApp open slice below the minimum message threshold",
      );
      return { item: null, skippedNoScope: false, skipReason: "below_min_messages" };
    }
    const indexedFileId =
      context.slice.indexed_file_id ??
      (await createConversationSlicesRepository(db).findLiveSliceFile(
        context.slice.id,
        WHATSAPP_CONVERSATION_SLICE_FILE_TYPE,
      ));
    if (indexedFileId) {
      const existing = await db
        .selectFrom("indexed_files")
        .select(["content_hash", "content", "source_meta"])
        .where("id", "=", indexedFileId)
        .executeTakeFirst();
      if (existing?.content_hash === contentHash)
        return { item: null, skippedNoScope: false, skipReason: "unchanged_content" };
      const refreshMessages =
        context.chunkProvisionalRefreshMessages ?? DEFAULT_WHATSAPP_LLM_CHUNK_PROVISIONAL_REFRESH_MESSAGES;
      previousEmission =
        parseEmissionAnchor(existing?.source_meta ?? null) ??
        bootstrapEmissionAnchor(context.slice, existing?.content ?? null, emittedAt);
      enrichmentRefresh = emissionRefreshTier({
        status: context.slice.status,
        firstMessageId: context.slice.first_message_id,
        messageCount: context.slice.message_count,
        previous: previousEmission,
        refreshMessages,
        refreshMaxMinutes: provisionalRefreshMaxMinutes,
        now,
      });
    }
  }
  const sourceMeta = buildEmissionAnchor({
    firstMessageId: context.slice.first_message_id,
    messageCount: context.slice.message_count,
    emittedAt,
    refreshTier: enrichmentRefresh,
    previous: previousEmission,
  });
  return {
    skippedNoScope: false,
    skipReason: null,
    item: {
      providerFileId: context.slice.id,
      providerUrl: null,
      fileName: `WhatsApp: ${titleGroup} - ${formatSliceTimeRange(context.slice)}`,
      fileType: WHATSAPP_CONVERSATION_SLICE_FILE_TYPE,
      contentCategory: "document",
      content,
      sourcePath: sourcePathForSlice(context),
      sourceMeta,
      enrichmentRefresh,
      contentHash,
      sourceCreatedAt: context.slice.started_at,
      sourceUpdatedAt: context.slice.ended_at,
      threadId: String(context.conversationId),
      accessScope: {
        scopeType: "whatsapp_group",
        providerScopeId: context.groupJid,
        label: titleGroup,
        members: rendered.accessPrincipals,
      },
    },
  };
}

export async function* emitWhatsAppSyncedItems(options: {
  db: Kysely<DB>;
  logger: Logger;
  emissionRefreshDays?: number;
  provisionalRefreshMaxMinutes: number;
  now?: Date;
  onSkippedNoScope?: () => void;
  /**
   * Receives one tally per run so the caller can fold the reasons into its own
   * summary line rather than emitting a log per skipped slice — a busy group
   * skips many slices per sync, and per-slice lines would bury the signal.
   */
  onSkipReason?: (reason: WhatsAppEmissionSkipReason) => void;
  /** One call per listed keyset page, mirroring the Slack emitter, so callers can see the loop stays bounded. */
  onPageListedSliceCount?: (count: number) => void;
}): AsyncGenerator<SyncedItem> {
  const now = options.now ?? new Date();
  const refreshCutoff = new Date(
    now.getTime() - normalizeEmissionRefreshDays(options.emissionRefreshDays) * DAY_MS,
  ).toISOString();
  let cursor: SliceKeysetCursor | null = null;
  for (;;) {
    const page = await listKeptSliceContextPage(options.db, refreshCutoff, cursor, WHATSAPP_EMISSION_PAGE_SIZE);
    options.onPageListedSliceCount?.(page.length);
    if (page.length === 0) break;
    const last = page[page.length - 1];
    if (!last) break;
    cursor = { timestamp: last.slice.started_at, id: last.slice.id };
    for (const context of page) {
      const { item, skippedNoScope, skipReason } = await syncedItemForKeptSlice(
        options.db,
        context,
        options.logger,
        now,
        options.provisionalRefreshMaxMinutes,
      );
      if (skippedNoScope) options.onSkippedNoScope?.();
      if (skipReason) options.onSkipReason?.(skipReason);
      if (item) yield item;
    }
    if (page.length < WHATSAPP_EMISSION_PAGE_SIZE) break;
  }
}

/**
 * Membership reconciliation independent of slice emission, mirroring
 * reconcileSlackChannelAcls. Without this a quiet group whose kept slices are
 * older than the emission refresh window would retain a departed teammate's
 * access indefinitely, because scope members are otherwise rewritten only when
 * a slice is (re-)emitted. Rosters come from the synced participant tables,
 * so this reflects the last observed group state.
 *
 * Disabled groups deliberately keep their previously indexed files (the
 * shipped disable semantic retains history), so membership is reconciled for
 * every scoped group: a departed member must lose access to retained slices
 * too.
 *
 * Zero-teammate rosters diverge by enablement. Enabled groups archive,
 * matching the emission-time fail-closed behavior — reversible, because
 * archival clears the slice link and re-emission relinks once a teammate
 * returns. Disabled groups are excluded from re-emission, so archiving them
 * would be permanent; their scope members are cleared instead, which revokes
 * all access while keeping the retained files recoverable when membership
 * returns.
 */
export async function reconcileWhatsAppGroupAcls(options: {
  db: Kysely<DB>;
  logger: Logger;
  connectorConfigId: string;
}): Promise<{ scopesRefreshed: number; scopesArchived: number; filesArchived: number }> {
  const connectorRepo = createConnectorRepository(options.db);
  const groupRepo = createWhatsAppGroupRepository(options.db);
  const scopes = await connectorRepo.listAccessScopesForConnector(options.connectorConfigId, "whatsapp_group");
  if (scopes.length === 0) return { scopesRefreshed: 0, scopesArchived: 0, filesArchived: 0 };

  let scopesRefreshed = 0;
  let scopesArchived = 0;
  let filesArchived = 0;

  for (const scope of scopes) {
    const config = await groupRepo.getIndexingConfig(scope.providerScopeId);
    if (!config) {
      options.logger.warn({ groupJid: scope.providerScopeId }, "WhatsApp ACL reconciliation found no group row");
      continue;
    }

    const conversation = await options.db
      .selectFrom("conversations")
      .select("id")
      .where("platform", "=", "whatsapp")
      .where("kind", "=", "group")
      .where("provider_conversation_id", "=", scope.providerScopeId)
      .executeTakeFirst();
    if (!conversation) continue;

    let accessPrincipals: AccessPrincipal[];
    try {
      const roster = await buildWhatsAppRosterSnapshot({
        db: options.db,
        groupJid: scope.providerScopeId,
        conversationId: conversation.id,
        logger: options.logger,
      });
      accessPrincipals = await loadWhatsAppAccessPrincipals(options.db, scope.providerScopeId, roster.snapshot);
    } catch (err) {
      options.logger.warn({ err, groupJid: scope.providerScopeId }, "WhatsApp ACL reconciliation roster failed");
      continue;
    }

    if (accessPrincipals.length === 0) {
      if (config.indexEnabled) {
        filesArchived += await connectorRepo.archiveFilesForAccessScopes([scope.id]);
        scopesArchived += 1;
        continue;
      }
      await connectorRepo.upsertAccessScope(options.connectorConfigId, {
        scopeType: "whatsapp_group",
        providerScopeId: scope.providerScopeId,
        label: sanitizeWhatsAppDisplayText(config.name) || "WhatsApp group",
        members: [],
      });
      scopesRefreshed += 1;
      continue;
    }

    await connectorRepo.upsertAccessScope(options.connectorConfigId, {
      scopeType: "whatsapp_group",
      providerScopeId: scope.providerScopeId,
      label: sanitizeWhatsAppDisplayText(config.name) || "WhatsApp group",
      members: accessPrincipals,
    });
    scopesRefreshed += 1;
  }

  options.logger.info({ scopesRefreshed, scopesArchived, filesArchived }, "Reconciled WhatsApp group ACLs");
  return { scopesRefreshed, scopesArchived, filesArchived };
}
