import type { Kysely } from "kysely";
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
import {
  CHUNK_MESSAGE_COLUMNS,
  type NamedChunkEngineMessage,
  isNamedChunkEngineMessage,
  toNamedChunkEngineMessage,
} from "./chunk-message-rows";
import { resolveChunkEngineKnobs } from "./config-default";

export const LINKEDIN_CHUNK_STREAM_KEY = "linkedin";

/**
 * Rows loaded beyond the window cap, so a page of non-indexable rows cannot
 * starve a window. The runner sizes its backfill gap scan by the same margin.
 */
export const LINKEDIN_CHUNK_LOAD_MARGIN = 50;

/**
 * Everything the emitter needs about a conversation once the Aimfox call is
 * long over. Idle-close emission, re-emission and the stale-anchor sweep all
 * run outside a sync pass, so the lead and owner names cannot be looked up
 * then; the engine persists them on every slice instead.
 */
export interface LinkedinChunkRosterSnapshot {
  accountId: string;
  conversationUrn: string;
  leadId: string;
  leadName: string;
  ownerName: string;
}

export interface LinkedinChunkAdapterParams {
  conversationId: number;
  roster: LinkedinChunkRosterSnapshot;
  knobs: ChunkEngineKnobs;
}

export function resolveLinkedinChunkEngineKnobs(appConfig: Partial<Config> | undefined): ChunkEngineKnobs {
  return resolveChunkEngineKnobs("LINKEDIN_CHUNK", appConfig);
}

export function parseLinkedinChunkRosterSnapshot(raw: string | null): LinkedinChunkRosterSnapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const fields = ["accountId", "conversationUrn", "leadId", "leadName", "ownerName"] as const;
  if (fields.some((field) => typeof value[field] !== "string" || (value[field] as string).length === 0)) return null;
  return {
    accountId: value.accountId as string,
    conversationUrn: value.conversationUrn as string,
    leadId: value.leadId as string,
    leadName: value.leadName as string,
    ownerName: value.ownerName as string,
  };
}

function requireLinkedinEngineMessage(message: ChunkEngineMessage): NamedChunkEngineMessage {
  if (!isNamedChunkEngineMessage(message)) {
    throw new Error("LinkedIn chunk adapter received an invalid message");
  }
  return message;
}

async function loadOpenRaw(
  db: Kysely<DB>,
  conversationId: number,
  open: ConversationSliceRow | undefined,
): Promise<ChunkEngineMessage[]> {
  if (!open) return [];
  const rows = await db
    .selectFrom("conversation_messages")
    .select(CHUNK_MESSAGE_COLUMNS)
    .where("conversation_id", "=", conversationId)
    .where("id", ">=", open.first_message_id)
    .where("id", "<=", open.last_message_id)
    .orderBy("id", "asc")
    .execute();
  return rows.map((row) => toNamedChunkEngineMessage(row));
}

/**
 * Live mode sees live rows plus the history rows already admitted into the open
 * slice. Without that filter a live tick that ran while a history backlog was
 * still being backfilled would advance the row-id cursor past the untouched
 * history rows and lose them; the runner additionally refuses to tick until
 * backfill has drained.
 */
async function loadPending(
  db: Kysely<DB>,
  conversationId: number,
  cursor: ChunkCursorState,
  limit: number,
  options: ChunkPendingOptions,
): Promise<ChunkEngineMessage[]> {
  let query = db
    .selectFrom("conversation_messages")
    .select(CHUNK_MESSAGE_COLUMNS)
    .where("conversation_id", "=", conversationId)
    .where("effective_at", "is not", null);
  if (options.mode === "live") {
    const historyStartId = options.historyStartId;
    query = query.where((eb) =>
      eb.or([
        eb("source", "=", "live"),
        ...(historyStartId !== undefined && historyStartId !== null
          ? [eb.and([eb("source", "=", "history"), eb("id", ">=", historyStartId)])]
          : []),
      ]),
    );
  }
  if (cursor.lastMessageId !== null) query = query.where("id", ">", cursor.lastMessageId);
  if (options.pendingUntil) query = query.where("id", "<=", options.pendingUntil.id);
  const rows = await query.orderBy("id", "asc").limit(limit).execute();
  return rows.map((row) => toNamedChunkEngineMessage(row));
}

async function tailMessage(db: Kysely<DB>, id: number): Promise<ChunkEngineMessage | undefined> {
  const row = await db
    .selectFrom("conversation_messages")
    .select(CHUNK_MESSAGE_COLUMNS)
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? toNamedChunkEngineMessage(row) : undefined;
}

/**
 * One stream per conversation, ordered by row id. The stream cursor store is
 * the only one carrying `llm_last_attempt_at`, which the tick gate needs, and
 * it tracks `last_message_id` alone — so the ingest writes rows in
 * chronological order and the engine reads them back the same way.
 */
export function createLinkedinChunkAdapter(params: LinkedinChunkAdapterParams): ChunkStreamAdapter {
  const serializedRoster = JSON.stringify(params.roster);
  return {
    conversationId: params.conversationId,
    streamKey: LINKEDIN_CHUNK_STREAM_KEY,
    providerThreadId: null,
    cursor: createStreamChunkCursorStore(params.conversationId, LINKEDIN_CHUNK_STREAM_KEY),
    loadOpenAndPending: async (db, open, cursor, cap, options) => {
      const limit = cap + LINKEDIN_CHUNK_LOAD_MARGIN;
      const [openRaw, pendingRaw] = await Promise.all([
        loadOpenRaw(db, params.conversationId, open),
        loadPending(db, params.conversationId, cursor, limit, options),
      ]);
      return { openRaw, pendingRaw, pageFull: pendingRaw.length === limit };
    },
    nextPendingMessage: async (db, cursor, options) =>
      (await loadPending(db, params.conversationId, cursor, 1, options))[0],
    tailMessage,
    isIndexable: (message) => requireLinkedinEngineMessage(message).text.trim().length > 0,
    senderLabel: (message) => requireLinkedinEngineMessage(message).senderName,
    order: "row_id",
    boundaries: "llm",
    promptHeader:
      "You are the LinkedIn conversation boundary engine. These are professional 1:1 messages; a topic often spans days between replies.",
    generateLabel: (kind) => (kind === "boundary" ? "linkedin-chunk-boundary" : "linkedin-chunk-repair"),
    flushReason: (kind) => {
      if (kind === "force_split") return "max_size";
      if (kind === "idle") return "gap";
      return "llm_boundary";
    },
    rosterSnapshot: async () => serializedRoster,
    usesTopicRegistry: false,
    knobs: params.knobs,
  };
}
