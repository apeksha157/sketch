import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createConnectorRepository, readSourceMeta } from "../db/repositories/connectors";
import { type ConversationSliceRow, createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import type { DB } from "../db/schema";
import {
  type SlackRosterSnapshot,
  accessPrincipalsFromRoster,
  parseSlackRosterSnapshot,
  resolveSlackChannelRoster,
} from "../slack/identity-resolution";
import type { SlackIndexingFacade } from "../slack/indexing-facade";
import { normalizeSourceTimestampForStorage, parseTimestampMs } from "../timestamps";
import { renderSlackChunkMessageText } from "./slack-chunk-adapters";
import { SLACK_CONVERSATION_SLICE_FILE_TYPE, type SyncedItem } from "./types";

export const SLACK_EMISSION_REFRESH_DAYS = 7;
export const SLACK_EMISSION_PAGE_SIZE = 200;
const MENTION_TOKEN_PATTERN = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/g;

export interface SlackEmissionRunSummary {
  tier1Emits: number;
  tier2Emits: number;
  legacyDrained: number;
  legacyRemaining: number;
  rosterFailures: number;
}

interface SlackSliceContext {
  slice: ConversationSliceRow;
  conversationId: number;
  channelId: string;
  channelName: string;
  linkedSourceUpdatedAt: string | null;
  linkedSourceMeta: string | null;
}

interface RenderedSlackSlice {
  content: string;
  accessPrincipals: ReturnType<typeof accessPrincipalsFromRoster>;
}

class SlackSliceMembershipError extends Error {}

function stableContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Slack rendering fails closed on membership: a slice's id range interleaves
 * channel and thread rows, so the WhatsApp range fallback would leak text
 * belonging to other slices into the verdict and the indexed file.
 */
function requireMembership(slice: ConversationSliceRow): number[] {
  if (!slice.denoised_message_ids) {
    throw new SlackSliceMembershipError(`Slack slice ${slice.id} has no message membership; refusing range fallback`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice.denoised_message_ids);
  } catch {
    throw new SlackSliceMembershipError(`Slack slice ${slice.id} has invalid message membership`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((value) => Number.isInteger(value))) {
    throw new SlackSliceMembershipError(`Slack slice ${slice.id} has invalid message membership`);
  }
  return parsed as number[];
}

async function dropInvalidMembership(
  db: Kysely<DB>,
  logger: Logger,
  context: SlackSliceContext,
  err: SlackSliceMembershipError,
): Promise<void> {
  await db
    .updateTable("conversation_slices")
    .set({
      salience_verdict: "dropped",
      salience_signals: JSON.stringify({ droppedReason: "invalid_membership" }),
      salience_claim_token: null,
      salience_claimed_at: null,
    })
    .where("id", "=", context.slice.id)
    .execute();
  logger.warn(
    { err, sliceId: context.slice.id, conversationId: context.conversationId },
    "Slack slice dead-lettered: invalid message membership",
  );
}

/**
 * Slack Web API errors carry the platform code in `data.error`. These codes
 * mean the bot can no longer see the channel, so retrying cannot recover.
 */
function isChannelInaccessibleError(err: unknown): boolean {
  const code = (err as { data?: { error?: string } } | null)?.data?.error;
  return code === "channel_not_found" || code === "not_in_channel" || code === "is_archived";
}

async function dropInaccessibleChannelSlices(
  db: Kysely<DB>,
  logger: Logger,
  contexts: SlackSliceContext[],
  err: unknown,
): Promise<void> {
  const sliceIds = contexts.map((context) => context.slice.id);
  if (sliceIds.length === 0) return;
  await db
    .updateTable("conversation_slices")
    .set({
      salience_verdict: "dropped",
      salience_signals: JSON.stringify({ droppedReason: "channel_inaccessible" }),
      salience_claim_token: null,
      salience_claimed_at: null,
    })
    .where("id", "in", sliceIds)
    .execute();
  logger.warn(
    { err, channelId: contexts[0]?.channelId, sliceCount: sliceIds.length },
    "Slack slices dead-lettered: channel inaccessible",
  );
}

function resolveMentionTokens(text: string, displayNameBySlackId: Map<string, string>): string {
  return text.replace(MENTION_TOKEN_PATTERN, (_match, slackUserId: string) => {
    const name = displayNameBySlackId.get(slackUserId);
    return name ? `@${name}` : "@unknown";
  });
}

type EmissionLane = "current" | "legacy";

async function listSliceContextPage(
  db: Kysely<DB>,
  lane: EmissionLane,
  refreshedAfter: string,
  cursor: { timestamp: string; id: string } | null,
  limit: number,
): Promise<SlackSliceContext[]> {
  let query = db
    .selectFrom("conversation_slices")
    .innerJoin("conversations", "conversations.id", "conversation_slices.conversation_id")
    .leftJoin("indexed_files", "indexed_files.id", "conversation_slices.indexed_file_id")
    .selectAll("conversation_slices")
    .select([
      "conversations.provider_conversation_id",
      "conversations.display_name",
      "indexed_files.source_updated_at as linked_source_updated_at",
      "indexed_files.source_meta as linked_source_meta",
    ])
    .where("conversations.platform", "=", "slack")
    .where("conversations.kind", "=", "channel")
    .where("conversation_slices.salience_verdict", "=", "kept")
    .where((eb) =>
      eb.or([
        eb("conversation_slices.indexed_file_id", "is", null),
        eb.and([
          eb("conversation_slices.status", "=", "open"),
          eb(eb.ref("conversation_slices.ended_at"), ">", eb.ref("indexed_files.source_updated_at")),
        ]),
        eb.and([
          eb("conversation_slices.status", "=", "closed"),
          eb("conversation_slices.ended_at", ">=", refreshedAfter),
        ]),
      ]),
    );

  if (lane === "current") {
    query = query.where("conversation_slices.legacy_unjudged_at", "is", null);
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb("conversation_slices.started_at", ">", cursor.timestamp),
          eb.and([
            eb("conversation_slices.started_at", "=", cursor.timestamp),
            eb("conversation_slices.id", ">", cursor.id),
          ]),
        ]),
      );
    }
    query = query.orderBy("conversation_slices.started_at", "asc").orderBy("conversation_slices.id", "asc");
  } else {
    query = query
      .where("conversation_slices.legacy_unjudged_at", "is not", null)
      .where("conversation_slices.indexed_file_id", "is", null);
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb("conversation_slices.ended_at", "<", cursor.timestamp),
          eb.and([
            eb("conversation_slices.ended_at", "=", cursor.timestamp),
            eb("conversation_slices.id", "<", cursor.id),
          ]),
        ]),
      );
    }
    query = query.orderBy("conversation_slices.ended_at", "desc").orderBy("conversation_slices.id", "desc");
  }

  const rows = await query.limit(limit).execute();
  return rows.map((row) => {
    const { provider_conversation_id, display_name, linked_source_updated_at, linked_source_meta, ...slice } = row;
    return {
      slice: slice as ConversationSliceRow,
      conversationId: slice.conversation_id,
      channelId: provider_conversation_id,
      channelName: display_name ?? provider_conversation_id,
      linkedSourceUpdatedAt: normalizeSourceTimestampForStorage(linked_source_updated_at),
      linkedSourceMeta: linked_source_meta,
    };
  });
}

async function loadThreadRootLine(
  db: Kysely<DB>,
  context: SlackSliceContext,
  displayNames: Map<string, string>,
): Promise<string | null> {
  if (!context.slice.provider_thread_id) return null;
  const root = await db
    .selectFrom("conversation_messages")
    .select(["sender_name", "text"])
    .where("conversation_id", "=", context.conversationId)
    .where("provider_message_id", "=", context.slice.provider_thread_id)
    .where("is_thread_reply", "=", 0)
    .executeTakeFirst();
  if (!root) return null;
  return `Thread root by ${root.sender_name}: ${resolveMentionTokens(root.text, displayNames)}`;
}

async function renderSlackSlice(
  db: Kysely<DB>,
  facade: SlackIndexingFacade,
  context: SlackSliceContext,
  logger: Logger,
): Promise<RenderedSlackSlice> {
  const membership = requireMembership(context.slice);
  const rows = await db
    .selectFrom("conversation_messages")
    .select(["id", "sender_name", "sender_jid", "text", "attachments", "provider_timestamp", "received_at"])
    .where("conversation_id", "=", context.conversationId)
    .where("id", "in", membership)
    .orderBy("id", "asc")
    .execute();
  if (rows.length !== membership.length) {
    logger.warn(
      { sliceId: context.slice.id, expected: membership.length, loaded: rows.length },
      "Slack slice membership loaded fewer messages than recorded",
    );
  }

  const existingRoster = parseSlackRosterSnapshot(context.slice.roster_snapshot);
  const roster =
    existingRoster ??
    (await resolveSlackChannelRoster({
      db,
      facade,
      channelId: context.channelId,
      channelName: context.channelName,
      logger,
    }));

  const displayNames = new Map(roster.participants.map((p) => [p.slackUserId, p.displayName]));
  const channelLine = `Channel: #${context.channelName}`;
  const rootLine = await loadThreadRootLine(db, context, displayNames);
  const transcriptLines = rows.map((row) => {
    const senderName = displayNames.get(row.sender_jid) ?? row.sender_name;
    const timestamp = row.provider_timestamp ?? row.received_at;
    const text = renderSlackChunkMessageText(row.text, row.attachments);
    return `[${timestamp}] ${senderName}: ${resolveMentionTokens(text, displayNames)}`;
  });
  const transcript = [...(rootLine ? [rootLine, ""] : []), ...transcriptLines].join("\n");

  /** Stored content excludes participant rosters from embeddings and entity extraction. */
  return {
    content: `${channelLine}\n\n${transcript}`,
    accessPrincipals: accessPrincipalsFromRoster(roster),
  };
}

function formatTimeRange(slice: ConversationSliceRow): string {
  return slice.started_at === slice.ended_at ? slice.started_at : `${slice.started_at} to ${slice.ended_at}`;
}

function sourcePathForSlice(context: SlackSliceContext): string {
  const params = new URLSearchParams({
    conversationId: String(context.conversationId),
    channelId: context.channelId,
    firstMessageId: String(context.slice.first_message_id),
    lastMessageId: String(context.slice.last_message_id),
    ...(context.slice.provider_thread_id ? { threadTs: context.slice.provider_thread_id } : {}),
  });
  return `slack://slice/${context.slice.id}?${params.toString()}`;
}

/**
 * Requeued slices (migration 155 cleared their indexed_file_id) still own a
 * live file row keyed by provider_file_id = slice id. Without the fallback
 * lookup, a slice whose channel no longer resolves any teammate would leave
 * that old file active under stale ACLs forever.
 */
async function findSliceFileId(db: Kysely<DB>, sliceId: string): Promise<string | null> {
  const row = await db
    .selectFrom("indexed_files")
    .select("id")
    .where("provider_file_id", "=", sliceId)
    .where("file_type", "=", SLACK_CONVERSATION_SLICE_FILE_TYPE)
    .where("is_archived", "=", 0)
    .executeTakeFirst();
  return row?.id ?? null;
}

async function readSliceSourceMeta(
  db: Kysely<DB>,
  context: SlackSliceContext,
): Promise<Record<string, unknown> | null> {
  if (context.linkedSourceMeta !== null) return readSourceMeta({ source_meta: context.linkedSourceMeta });
  const row = await db
    .selectFrom("indexed_files")
    .select("source_meta")
    .where("provider_file_id", "=", context.slice.id)
    .where("file_type", "=", SLACK_CONVERSATION_SLICE_FILE_TYPE)
    .where("is_archived", "=", 0)
    .executeTakeFirst();
  return row ? readSourceMeta(row) : null;
}

export interface SlackEmissionAnchor {
  firstMessageId: number;
  messageCount: number;
  emittedAt: string;
  enrichedMessageCount: number;
  enrichedAt: string;
}

function parseEmissionAnchor(value: Record<string, unknown> | null): SlackEmissionAnchor | null {
  if (
    !value ||
    !Number.isInteger(value.firstMessageId) ||
    !Number.isInteger(value.messageCount) ||
    typeof value.emittedAt !== "string" ||
    !Number.isInteger(value.enrichedMessageCount) ||
    typeof value.enrichedAt !== "string"
  ) {
    return null;
  }
  return value as unknown as SlackEmissionAnchor;
}

export function slackEmissionRefreshTier(input: {
  status: string;
  firstMessageId: number;
  messageCount: number;
  previous: SlackEmissionAnchor | null;
  provisionalRefreshMessages: number;
  provisionalRefreshMaxMinutes: number;
  now: Date;
}): "full" | "embeddings_only" {
  if (input.status === "closed" || !input.previous) return "full";
  if (
    input.firstMessageId !== input.previous.firstMessageId ||
    input.messageCount < input.previous.messageCount ||
    input.messageCount - input.previous.enrichedMessageCount >= input.provisionalRefreshMessages
  ) {
    return "full";
  }
  const enrichedAt = parseTimestampMs(input.previous.enrichedAt);
  if (enrichedAt === null || input.now.getTime() - enrichedAt >= input.provisionalRefreshMaxMinutes * 60_000) {
    return "full";
  }
  return "embeddings_only";
}

function isFreshEmissionCandidate(context: SlackSliceContext, refreshedAfter: string): boolean {
  if (context.slice.indexed_file_id === null) return true;
  const endedAt = normalizeSourceTimestampForStorage(context.slice.ended_at);
  if (!endedAt) return false;
  if (context.slice.status === "open") {
    return context.linkedSourceUpdatedAt !== null && endedAt > context.linkedSourceUpdatedAt;
  }
  return endedAt >= refreshedAfter;
}

async function archiveLinkedSliceFileIfPresent(db: Kysely<DB>, context: SlackSliceContext): Promise<void> {
  const indexedFileId = context.slice.indexed_file_id ?? (await findSliceFileId(db, context.slice.id));
  if (!indexedFileId) return;
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("file_access").where("indexed_file_id", "=", indexedFileId).execute();
    await trx
      .updateTable("indexed_files")
      .set({ is_archived: 1, access_scope_id: null })
      .where("id", "=", indexedFileId)
      .execute();
    await trx
      .updateTable("conversation_slices")
      .set({ indexed_file_id: null })
      .where("id", "=", context.slice.id)
      .execute();
  });
}

/**
 * Emits kept Slack slices as SyncedItems. The roster is re-resolved at
 * emission so the access scope reflects current channel membership, not
 * membership at judgment time. Emission-time teammate emails are retained as
 * capture audit stamps; current scope membership is the read-time access grant.
 */
export async function* emitSlackSyncedItems(options: {
  db: Kysely<DB>;
  logger: Logger;
  facade: SlackIndexingFacade;
  emissionRefreshDays?: number;
  minMessages?: number;
  threadMinMessages?: number;
  provisionalRefreshMessages?: number;
  provisionalRefreshMaxMinutes?: number;
  legacyPerRun?: number;
  now?: Date;
  onSkippedNoScope?: () => void;
  onSummary?: (summary: SlackEmissionRunSummary) => void;
  onPageListedSliceCount?: (count: number) => void;
  onPageRosterCacheSize?: (size: number) => void;
  slackEntitySyncEnabled?: boolean;
}): AsyncGenerator<SyncedItem> {
  const refreshDays = options.emissionRefreshDays ?? SLACK_EMISSION_REFRESH_DAYS;
  const now = options.now ?? new Date();
  const refreshedAfter = normalizeSourceTimestampForStorage(
    new Date(now.getTime() - refreshDays * 24 * 60 * 60_000).toISOString(),
  );
  if (!refreshedAfter) throw new Error("Slack emission refresh cutoff is invalid");
  const summary: SlackEmissionRunSummary = {
    tier1Emits: 0,
    tier2Emits: 0,
    legacyDrained: 0,
    legacyRemaining: 0,
    rosterFailures: 0,
  };
  const minMessages = Math.max(1, options.minMessages ?? 10);
  const threadMinMessages = Math.max(1, options.threadMinMessages ?? 1);
  const provisionalRefreshMessages = Math.max(1, options.provisionalRefreshMessages ?? 20);
  const provisionalRefreshMaxMinutes = Math.max(1, options.provisionalRefreshMaxMinutes ?? 120);
  const legacyPerRun = Math.max(1, options.legacyPerRun ?? 200);
  const legacyBacklog = await options.db
    .selectFrom("conversation_slices")
    .innerJoin("conversations", "conversations.id", "conversation_slices.conversation_id")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("conversations.platform", "=", "slack")
    .where("conversations.kind", "=", "channel")
    .where("conversation_slices.salience_verdict", "=", "kept")
    .where("conversation_slices.legacy_unjudged_at", "is not", null)
    .where("conversation_slices.indexed_file_id", "is", null)
    .executeTakeFirstOrThrow();

  for (const lane of ["current", "legacy"] as const) {
    let cursor: { timestamp: string; id: string } | null = null;
    let remainingForLane = lane === "legacy" ? legacyPerRun : Number.POSITIVE_INFINITY;
    while (remainingForLane > 0) {
      const pageLimit = Math.min(SLACK_EMISSION_PAGE_SIZE, remainingForLane);
      const page = await listSliceContextPage(options.db, lane, refreshedAfter, cursor, pageLimit);
      options.onPageListedSliceCount?.(page.length);
      if (page.length === 0) break;
      const last = page[page.length - 1];
      if (!last) break;
      cursor = {
        timestamp: lane === "current" ? last.slice.started_at : last.slice.ended_at,
        id: last.slice.id,
      };
      remainingForLane -= page.length;
      const rosterCache = new Map<string, SlackRosterSnapshot | null>();

      for (const context of page) {
        if (!isFreshEmissionCandidate(context, refreshedAfter)) continue;
        const previous = parseEmissionAnchor(await readSliceSourceMeta(options.db, context));
        const enrichmentRefresh = slackEmissionRefreshTier({
          status: context.slice.status,
          firstMessageId: context.slice.first_message_id,
          messageCount: context.slice.message_count,
          previous,
          provisionalRefreshMessages,
          provisionalRefreshMaxMinutes,
          now,
        });
        const floor = context.slice.provider_thread_id === null ? minMessages : threadMinMessages;
        const belowFloor = context.slice.status === "open" && context.slice.message_count < floor;
        if (
          belowFloor &&
          context.slice.indexed_file_id === null &&
          (await findSliceFileId(options.db, context.slice.id)) === null
        ) {
          continue;
        }

        let roster = rosterCache.get(context.channelId);
        if (!rosterCache.has(context.channelId)) {
          try {
            roster = await resolveSlackChannelRoster({
              db: options.db,
              facade: options.facade,
              channelId: context.channelId,
              channelName: context.channelName,
              logger: options.logger,
            });
          } catch (err) {
            roster = null;
            rosterCache.set(context.channelId, null);
            if (isChannelInaccessibleError(err)) {
              await dropInaccessibleChannelSlices(
                options.db,
                options.logger,
                page.filter((candidate) => candidate.channelId === context.channelId),
                err,
              );
            }
            options.logger.warn({ err, channelId: context.channelId }, "Slack emission roster resolution failed");
          }
          if (roster) rosterCache.set(context.channelId, roster);
        }
        if (!roster) {
          summary.rosterFailures += 1;
          continue;
        }

        const serializedRoster = JSON.stringify(roster);
        if (serializedRoster !== context.slice.roster_snapshot) {
          await options.db
            .updateTable("conversation_slices")
            .set({ roster_snapshot: serializedRoster })
            .where("id", "=", context.slice.id)
            .execute();
          context.slice = { ...context.slice, roster_snapshot: serializedRoster };
        }

        const accessPrincipals = accessPrincipalsFromRoster(roster);
        if (accessPrincipals.length === 0) {
          await archiveLinkedSliceFileIfPresent(options.db, context);
          options.onSkippedNoScope?.();
          options.logger.warn(
            { sliceId: context.slice.id, channelId: context.channelId },
            "Skipped Slack slice indexing because no teammate access scope resolved",
          );
          continue;
        }

        let rendered: RenderedSlackSlice;
        try {
          rendered = await renderSlackSlice(options.db, options.facade, context, options.logger);
        } catch (err) {
          if (err instanceof SlackSliceMembershipError) {
            await dropInvalidMembership(options.db, options.logger, context, err);
            continue;
          }
          options.logger.warn({ err, sliceId: context.slice.id }, "Slack slice render failed; skipping emission");
          continue;
        }

        const emittedAt = now.toISOString();
        const sourceMeta = {
          firstMessageId: context.slice.first_message_id,
          messageCount: context.slice.message_count,
          emittedAt,
          enrichedMessageCount:
            enrichmentRefresh === "full" ? context.slice.message_count : (previous?.enrichedMessageCount ?? 0),
          enrichedAt: enrichmentRefresh === "full" ? emittedAt : (previous?.enrichedAt ?? emittedAt),
        };
        if (enrichmentRefresh === "full") summary.tier2Emits += 1;
        else summary.tier1Emits += 1;
        if (lane === "legacy") {
          summary.legacyDrained += 1;
        }

        yield {
          providerFileId: context.slice.id,
          providerUrl: null,
          fileName: `Slack: #${context.channelName} - ${formatTimeRange(context.slice)}`,
          fileType: SLACK_CONVERSATION_SLICE_FILE_TYPE,
          contentCategory: "document",
          content: rendered.content,
          sourcePath: sourcePathForSlice(context),
          contentHash: stableContentHash(rendered.content),
          sourceCreatedAt: context.slice.started_at,
          sourceUpdatedAt: context.slice.ended_at,
          sourceMeta,
          enrichmentRefresh,
          threadId: String(context.conversationId),
          accessScope: {
            scopeType: "slack_channel",
            providerScopeId: context.channelId,
            label: `#${context.channelName}`,
            members: rendered.accessPrincipals,
          },
          accessPrincipals:
            options.slackEntitySyncEnabled === false
              ? undefined
              : rendered.accessPrincipals.filter((principal) => principal.type === "email"),
        };
      }
      options.onPageRosterCacheSize?.(rosterCache.size);
      if (page.length < pageLimit) break;
    }
  }

  summary.legacyRemaining = Math.max(0, Number(legacyBacklog.count) - summary.legacyDrained);
  options.onSummary?.(summary);
}

/**
 * Disconnect handling archives indexed channel files when the bot can no
 * longer verify channel membership.
 */
export async function archiveAllSlackChannelFiles(options: {
  db: Kysely<DB>;
  logger: Logger;
  connectorConfigId: string;
  slackEntitySyncEnabled?: boolean;
}): Promise<number> {
  const repo = createConnectorRepository(options.db);
  const scopes = await repo.listAccessScopesForConnector(options.connectorConfigId, "slack_channel");
  if (scopes.length === 0) return 0;
  const filesArchived = await repo.archiveFilesForAccessScopes(scopes.map((scope) => scope.id));
  if (filesArchived > 0) {
    options.logger.info({ filesArchived }, "Archived Slack slices: Slack is disconnected");
  }
  return filesArchived;
}

/**
 * Propagates a channel rename into stored state: updates the conversation
 * display name (source for slice rendering and file names) and unlinks kept
 * slices' indexed files so the next emission re-renders them under the new
 * name. Emission upserts by provider_file_id, so the existing file rows are
 * updated in place — verdicts persist and no salience re-runs. Called from the
 * live channel_name event handler and from ACL reconciliation, which covers
 * renames that happen while the bot is offline.
 */
export async function refreshSlackChannelName(options: {
  db: Kysely<DB>;
  logger: Logger;
  channelId: string;
  channelName: string;
}): Promise<boolean> {
  const conversation = await options.db
    .selectFrom("conversations")
    .select(["id", "display_name"])
    .where("platform", "=", "slack")
    .where("kind", "=", "channel")
    .where("provider_conversation_id", "=", options.channelId)
    .executeTakeFirst();
  if (!conversation || conversation.display_name === options.channelName) return false;

  await options.db
    .updateTable("conversations")
    .set({ display_name: options.channelName, updated_at: new Date().toISOString() })
    .where("id", "=", conversation.id)
    .execute();
  const unlinked = await createConversationSlicesRepository(options.db).unlinkKeptSliceFiles(conversation.id);
  options.logger.info(
    { channelId: options.channelId, channelName: options.channelName, slicesUnlinked: unlinked },
    "Refreshed Slack channel name; kept slices queued for re-emission",
  );
  return true;
}

export async function reconcileSlackChannelAcls(options: {
  db: Kysely<DB>;
  logger: Logger;
  facade: SlackIndexingFacade;
  connectorConfigId: string;
  slackEntitySyncEnabled?: boolean;
}): Promise<{ scopesRefreshed: number; scopesArchived: number; filesArchived: number }> {
  const repo = createConnectorRepository(options.db);
  const scopes = await repo.listAccessScopesForConnector(options.connectorConfigId, "slack_channel");
  if (scopes.length === 0) return { scopesRefreshed: 0, scopesArchived: 0, filesArchived: 0 };

  const visible = new Map((await options.facade.listMemberChannels()).map((channel) => [channel.id, channel.name]));
  let scopesRefreshed = 0;
  let scopesArchived = 0;
  let filesArchived = 0;
  for (const scope of scopes) {
    const channelName = visible.get(scope.providerScopeId);
    if (channelName === undefined) {
      filesArchived += await repo.archiveFilesForAccessScopes([scope.id]);
      scopesArchived += 1;
      options.logger.info(
        { channelId: scope.providerScopeId },
        "Archived Slack slices for channel no longer visible to the bot",
      );
      continue;
    }

    let roster: SlackRosterSnapshot;
    try {
      roster = await resolveSlackChannelRoster({
        db: options.db,
        facade: options.facade,
        channelId: scope.providerScopeId,
        channelName,
        logger: options.logger,
      });
    } catch (err) {
      options.logger.warn({ err, channelId: scope.providerScopeId }, "Slack ACL reconciliation roster failed");
      continue;
    }

    const accessPrincipals = accessPrincipalsFromRoster(roster);
    if (accessPrincipals.length === 0) {
      filesArchived += await repo.archiveFilesForAccessScopes([scope.id]);
      scopesArchived += 1;
      continue;
    }

    await repo.upsertAccessScope(options.connectorConfigId, {
      scopeType: "slack_channel",
      providerScopeId: scope.providerScopeId,
      label: `#${channelName}`,
      members: accessPrincipals,
    });
    scopesRefreshed += 1;

    await refreshSlackChannelName({
      db: options.db,
      logger: options.logger,
      channelId: scope.providerScopeId,
      channelName,
    });
  }

  const summary = { scopesRefreshed, scopesArchived, filesArchived };
  options.logger.info(summary, "Completed Slack channel ACL reconciliation");
  return summary;
}
