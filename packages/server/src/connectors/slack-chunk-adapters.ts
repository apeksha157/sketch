import { type Kysely, sql } from "kysely";
import type { Logger } from "pino";
import type { Config } from "../config";
import type { ConversationSliceRow } from "../db/repositories/conversation-slices";
import type { DB } from "../db/schema";
import {
  type ChunkCursorState,
  type ChunkEngineKnobs,
  type ChunkEngineMessage,
  type ChunkPendingOptions,
  type ChunkStreamAdapter,
  createStreamChunkCursorStore,
} from "./chunk-engine";
import { configDefault, resolveChunkEngineKnobs } from "./config-default";
import {
  SLACK_CHANNEL_STREAM_KEY,
  isIndexableSlackChunkMessage,
  parseSlackChunkAttachments,
} from "./slack-chunk-messages";
import { ATTACHMENT_PLACEHOLDER_TEXT } from "./transcript";

const LOAD_MARGIN = 50;
const MESSAGE_COLUMNS = [
  "id",
  "provider_message_id",
  "sender_name",
  "is_bot",
  "text",
  "attachments",
  "provider_timestamp",
  "received_at",
  "effective_at",
] as const;

interface SlackEngineMessage extends ChunkEngineMessage {
  senderName: string;
}

interface SlackMessageRow {
  id: number;
  provider_message_id: string;
  sender_name: string;
  is_bot: number;
  text: string;
  attachments: string | null;
  provider_timestamp: string | null;
  received_at: string;
  effective_at: string | null;
}

interface SlackAdapterParams {
  conversationId: number;
  knobs: ChunkEngineKnobs;
}

interface SlackThreadAdapterParams extends SlackAdapterParams {
  threadTs: string;
}

/** Normalizes attachment placeholders for boundary prompts and slice transcripts. */
export function renderSlackChunkMessageText(text: string, attachments: string | null): string {
  if (text.trim().toLowerCase() !== ATTACHMENT_PLACEHOLDER_TEXT) return text;
  const parsed = parseSlackChunkAttachments(attachments);
  if (!parsed.hasAttachments) return text;
  return parsed.firstName ? `[shared file: ${parsed.firstName}]` : "[shared file]";
}

function toMessage(row: SlackMessageRow): SlackEngineMessage {
  return {
    id: row.id,
    providerMessageId: row.provider_message_id,
    senderName: row.sender_name,
    isBot: row.is_bot === 1,
    text: renderSlackChunkMessageText(row.text, row.attachments),
    attachments: row.attachments,
    effectiveAt: row.effective_at ?? row.provider_timestamp ?? row.received_at,
    receivedAt: row.received_at,
  };
}

function isSlackEngineMessage(message: ChunkEngineMessage): message is SlackEngineMessage {
  return "senderName" in message && typeof message.senderName === "string";
}

function requireSlackEngineMessage(message: ChunkEngineMessage): SlackEngineMessage {
  if (!isSlackEngineMessage(message)) {
    throw new Error("Slack chunk adapter received an invalid message");
  }
  return message;
}

function streamQuery(db: Kysely<DB>, conversationId: number, providerThreadId: string | null) {
  const query = db.selectFrom("conversation_messages").where("conversation_id", "=", conversationId);
  return providerThreadId === null
    ? query.where("is_thread_reply", "=", 0)
    : query.where("is_thread_reply", "=", 1).where("provider_thread_id", "=", providerThreadId);
}

async function loadOpenRaw(
  db: Kysely<DB>,
  conversationId: number,
  providerThreadId: string | null,
  open: ConversationSliceRow | undefined,
): Promise<ChunkEngineMessage[]> {
  if (!open) return [];
  const rows = await streamQuery(db, conversationId, providerThreadId)
    .select(MESSAGE_COLUMNS)
    .where("id", ">=", open.first_message_id)
    .where("id", "<=", open.last_message_id)
    .orderBy("id", "asc")
    .execute();
  return rows.map(toMessage);
}

async function loadPending(
  db: Kysely<DB>,
  conversationId: number,
  providerThreadId: string | null,
  cursor: ChunkCursorState,
  limit: number,
  options: ChunkPendingOptions,
): Promise<ChunkEngineMessage[]> {
  let query = streamQuery(db, conversationId, providerThreadId).select(MESSAGE_COLUMNS).where("source", "=", "live");
  if (cursor.lastMessageId !== null) query = query.where("id", ">", cursor.lastMessageId);
  if (options.pendingUntil) query = query.where("id", "<=", options.pendingUntil.id);
  const rows = await query.orderBy("id", "asc").limit(limit).execute();
  return rows.map(toMessage);
}

async function tailMessage(db: Kysely<DB>, id: number): Promise<ChunkEngineMessage | undefined> {
  const row = await db
    .selectFrom("conversation_messages")
    .select(MESSAGE_COLUMNS)
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? toMessage(row) : undefined;
}

function createAdapter(params: SlackAdapterParams, providerThreadId: string | null): ChunkStreamAdapter {
  const streamKey = providerThreadId ?? SLACK_CHANNEL_STREAM_KEY;
  return {
    conversationId: params.conversationId,
    streamKey,
    providerThreadId,
    cursor: createStreamChunkCursorStore(params.conversationId, streamKey),
    loadOpenAndPending: async (db, open, cursor, cap, options) => {
      const limit = cap + LOAD_MARGIN;
      const [openRaw, pendingRaw] = await Promise.all([
        loadOpenRaw(db, params.conversationId, providerThreadId, open),
        loadPending(db, params.conversationId, providerThreadId, cursor, limit, options),
      ]);
      return { openRaw, pendingRaw, pageFull: pendingRaw.length === limit };
    },
    nextPendingMessage: async (db, cursor, options) =>
      (await loadPending(db, params.conversationId, providerThreadId, cursor, 1, options))[0],
    tailMessage,
    isIndexable: (message) => isIndexableSlackChunkMessage(requireSlackEngineMessage(message)),
    senderLabel: (message) => requireSlackEngineMessage(message).senderName,
    order: "row_id",
    boundaries: providerThreadId === null ? "llm" : "single-segment",
    promptHeader:
      "You are the Slack conversation boundary engine. Slack turns are short; preserve links and leave <@U…> mentions raw.",
    generateLabel: (kind) => (kind === "boundary" ? "slack-chunk-boundary" : "slack-chunk-repair"),
    flushReason: (kind) => {
      if (kind === "force_split") return "max_size";
      if (kind === "idle" || providerThreadId !== null) return "gap";
      return "llm_boundary";
    },
    rosterSnapshot: async () => "[]",
    usesTopicRegistry: providerThreadId === null,
    knobs: params.knobs,
  };
}

export function createSlackChannelChunkAdapter(params: SlackAdapterParams): ChunkStreamAdapter {
  return createAdapter(params, null);
}

export function createSlackThreadChunkAdapter(params: SlackThreadAdapterParams): ChunkStreamAdapter {
  return createAdapter(params, params.threadTs);
}

/**
 * Threads carry their own minimum-message floor; every other knob is shared
 * with the channel stream.
 */
export function resolveSlackChunkEngineKnobs(appConfig: Partial<Config> | undefined): {
  channel: ChunkEngineKnobs;
  thread: ChunkEngineKnobs;
} {
  const channel = resolveChunkEngineKnobs("SLACK_CHUNK", appConfig);
  return {
    channel,
    thread: {
      ...channel,
      minMessages: appConfig?.SLACK_THREAD_MIN_MESSAGES ?? configDefault("SLACK_THREAD_MIN_MESSAGES"),
    },
  };
}

export async function repairSlackChunkStreamsOnStartup(
  db: Kysely<DB>,
  logger: Pick<Logger, "info">,
): Promise<{ orphanedOpenSlicesClosed: number; legacyVerdictsKept: number }> {
  const repaired = await sql`
    UPDATE conversation_slices
    SET status = 'closed', flush_reason = 'gap', indexed_file_id = NULL
    WHERE status = 'open'
      AND EXISTS (
        SELECT 1
        FROM conversations
        WHERE conversations.id = conversation_slices.conversation_id
          AND conversations.platform = 'slack'
          AND conversations.kind = 'channel'
      )
      AND EXISTS (
        SELECT 1
        FROM conversation_slices AS later
        WHERE later.conversation_id = conversation_slices.conversation_id
          AND later.status = 'closed'
          AND later.first_message_id > conversation_slices.first_message_id
          AND (
            later.provider_thread_id = conversation_slices.provider_thread_id
            OR (later.provider_thread_id IS NULL AND conversation_slices.provider_thread_id IS NULL)
          )
      )
  `.execute(db);
  const legacy = await sql`
    UPDATE conversation_slices
    SET salience_verdict = 'kept', legacy_unjudged_at = CURRENT_TIMESTAMP
    WHERE status = 'closed'
      AND salience_verdict IS NULL
      AND EXISTS (
        SELECT 1
        FROM conversations
        WHERE conversations.id = conversation_slices.conversation_id
          AND conversations.platform = 'slack'
          AND conversations.kind = 'channel'
      )
  `.execute(db);
  const result = {
    orphanedOpenSlicesClosed: Number(repaired.numAffectedRows ?? 0),
    legacyVerdictsKept: Number(legacy.numAffectedRows ?? 0),
  };
  logger.info(result, "Repaired Slack chunk streams on startup");
  return result;
}
