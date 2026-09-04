import type { Kysely, Transaction } from "kysely";
import type { Logger } from "pino";
import { type ConversationSliceRow, createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createWhatsAppIdentityCandidateRepository } from "../db/repositories/whatsapp-identity-candidates";
import type { DB } from "../db/schema";
import {
  buildWhatsAppRosterSnapshot,
  normalizeWhatsAppIdentityPhone,
  stableWhatsAppParticipantJidRef,
} from "../whatsapp/identity-resolution";
import { phoneE164ToWhatsAppJid } from "../whatsapp/provider";
import {
  type BoundarySegment,
  type ChunkCursorState,
  type ChunkEngineDeps,
  type ChunkEngineMessage,
  type ChunkPendingBound,
  type ChunkPendingOptions,
  type ChunkStreamAdapter,
  createCompositeChunkCursorStore,
  enforceBoundarySize,
  evaluateIdleClose as evaluateChunkIdleClose,
  runChunkingPass,
  validateBoundarySegments,
} from "./chunk-engine";
import {
  type WhatsAppChunkerMessage,
  type WhatsAppLlmChunkerKnobs,
  isIndexableWhatsAppChunkMessage,
} from "./whatsapp-chunker";

export type { WhatsAppLlmChunkerKnobs } from "./whatsapp-chunker";

export interface WhatsAppLlmChunkerDeps extends ChunkEngineDeps {
  db: Kysely<DB>;
  logger: Logger;
}

export type WhatsAppBoundarySegment = BoundarySegment;

export interface WhatsAppLlmBoundaryMessage extends WhatsAppChunkerMessage {
  senderName: string;
}

interface RawMessageRow {
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

const IDENTITY_RECORDED_MARKER = "_whatsappIdentityCandidatesRecorded";
const RAW_MESSAGE_COLUMNS = [
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

function effectiveAt(row: RawMessageRow): string {
  return row.effective_at ?? row.provider_timestamp ?? row.received_at;
}

function toMessage(row: RawMessageRow): ChunkEngineMessage & { senderName: string } {
  return {
    id: row.id,
    providerMessageId: row.provider_message_id,
    effectiveAt: effectiveAt(row),
    receivedAt: row.received_at,
    text: row.text,
    attachments: row.attachments,
    isBot: row.is_bot === 1,
    senderName: row.sender_name,
  };
}

function parseSignals(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function recordIdentityCandidatesIfNeeded(
  db: Kysely<DB>,
  groupJid: string,
  slice: ConversationSliceRow,
): Promise<void> {
  const signals = parseSignals(slice.salience_signals);
  if (signals[IDENTITY_RECORDED_MARKER] === true) return;
  let roster: { participants?: Array<{ participantJidRef: string; displayName: string; resolutionKind: string }> } = {};
  try {
    const parsed = JSON.parse(slice.roster_snapshot) as unknown;
    if (parsed && typeof parsed === "object") roster = parsed as typeof roster;
  } catch {
    roster = {};
  }
  const participants = await db
    .selectFrom("whatsapp_group_participants")
    .select(["participant_jid", "phone_e164"])
    .where("group_jid", "=", groupJid)
    .where("phone_e164", "is not", null)
    .execute();
  const snapshotByParticipantRef = new Map(
    (roster.participants ?? []).map((participant) => [participant.participantJidRef, participant]),
  );
  const repo = createWhatsAppIdentityCandidateRepository(db);
  for (const participant of participants) {
    const phone = normalizeWhatsAppIdentityPhone(participant.phone_e164);
    if (!phone) continue;
    const participantRef = stableWhatsAppParticipantJidRef(participant.participant_jid);
    const snapshotParticipant = snapshotByParticipantRef.get(participantRef);
    if (!snapshotParticipant || snapshotParticipant.resolutionKind !== "unresolved") continue;
    await repo.recordObservation({
      groupJid,
      candidateRef: stableWhatsAppParticipantJidRef(phoneE164ToWhatsAppJid(phone)),
      participantJidRef: participantRef,
      displayName: snapshotParticipant.displayName,
      sliceId: slice.id,
      seenAt: slice.ended_at,
    });
  }
  await db
    .updateTable("conversation_slices")
    .set({ salience_signals: JSON.stringify({ ...signals, [IDENTITY_RECORDED_MARKER]: true }) })
    .where("id", "=", slice.id)
    .where("status", "=", "closed")
    .execute();
}

async function listOpenRawMessages(
  db: Kysely<DB>,
  conversationId: number,
  open: ConversationSliceRow | undefined,
): Promise<ChunkEngineMessage[]> {
  if (!open) return [];
  const rows = await db
    .selectFrom("conversation_messages")
    .select(RAW_MESSAGE_COLUMNS)
    .where("conversation_id", "=", conversationId)
    .where("effective_at", ">=", open.started_at)
    .where("effective_at", "<=", open.ended_at)
    .orderBy("effective_at", "asc")
    .orderBy("id", "asc")
    .execute();
  return rows.map((row) => toMessage(row as RawMessageRow));
}

/**
 * Live mode excludes history rows that backfill has not admitted into the
 * open slice; otherwise rejected provider timestamps can move those rows
 * past the live cursor and make the two passes overlap.
 */
async function listPendingRawMessages(
  db: Kysely<DB>,
  conversationId: number,
  cursor: ChunkCursorState,
  limit: number,
  options: ChunkPendingOptions,
): Promise<ChunkEngineMessage[]> {
  let query = db
    .selectFrom("conversation_messages")
    .select(RAW_MESSAGE_COLUMNS)
    .where("conversation_id", "=", conversationId)
    .where("effective_at", "is not", null);
  if (options.mode === "live") {
    query = query.where((eb) =>
      eb.or([
        eb("source", "=", "live"),
        ...(options.historyStartId !== undefined && options.historyStartId !== null
          ? [eb.and([eb("source", "=", "history"), eb("id", ">=", options.historyStartId)])]
          : []),
      ]),
    );
  }
  if (cursor.lastEffectiveAt !== null && cursor.lastMessageId !== null) {
    query = query.where((eb) =>
      eb.or([
        eb("effective_at", ">", cursor.lastEffectiveAt as string),
        eb.and([
          eb("effective_at", "=", cursor.lastEffectiveAt as string),
          eb("id", ">", cursor.lastMessageId as number),
        ]),
      ]),
    );
  }
  if (options.pendingUntil) {
    const pendingUntil = options.pendingUntil;
    query = query.where((eb) =>
      eb.or([
        eb("effective_at", "<", pendingUntil.effectiveAt),
        eb.and([eb("effective_at", "=", pendingUntil.effectiveAt), eb("id", "<=", pendingUntil.id)]),
      ]),
    );
  }
  const rows = await query.orderBy("effective_at", "asc").orderBy("id", "asc").limit(limit).execute();
  return rows.map((row) => toMessage(row as RawMessageRow));
}

async function getRawMessage(db: Kysely<DB>, messageId: number): Promise<ChunkEngineMessage | undefined> {
  const row = await db
    .selectFrom("conversation_messages")
    .select(RAW_MESSAGE_COLUMNS)
    .where("id", "=", messageId)
    .executeTakeFirst();
  return row ? toMessage(row as RawMessageRow) : undefined;
}

export function createWhatsAppChunkStreamAdapter(
  deps: WhatsAppLlmChunkerDeps,
  params: { conversationId: number; groupJid: string; knobs: WhatsAppLlmChunkerKnobs },
): ChunkStreamAdapter {
  const cursor = createCompositeChunkCursorStore(params.conversationId);
  return {
    conversationId: params.conversationId,
    streamKey: null,
    providerThreadId: null,
    cursor,
    loadOpenAndPending: async (db, open, state, cap, options) => {
      const limit = cap + 50;
      const [openRaw, pendingRaw] = await Promise.all([
        listOpenRawMessages(db, params.conversationId, open),
        listPendingRawMessages(db, params.conversationId, state, limit, options),
      ]);
      return {
        openRaw,
        pendingRaw,
        pageFull: pendingRaw.length === limit,
      };
    },
    nextPendingMessage: async (db, state, options) =>
      (await listPendingRawMessages(db, params.conversationId, state, 1, options))[0],
    tailMessage: getRawMessage,
    isIndexable: isIndexableWhatsAppChunkMessage,
    senderLabel: (message) => (message as ChunkEngineMessage & { senderName: string }).senderName,
    order: "effective_time",
    boundaries: "llm",
    promptHeader: "You are the WhatsApp conversation boundary engine.",
    generateLabel: (kind) => (kind === "repair" ? "whatsappLlmBoundaryRepair" : "whatsappLlmBoundary"),
    flushReason: () => "llm_boundary",
    rosterSnapshot: async (db) =>
      (
        await buildWhatsAppRosterSnapshot({
          db,
          groupJid: params.groupJid,
          conversationId: params.conversationId,
          logger: deps.logger,
          enrichEntityAliases: true,
        })
      ).serializedSnapshot,
    usesTopicRegistry: true,
    onSliceClosed: (trx: Transaction<DB>, slice) => recordIdentityCandidatesIfNeeded(trx, params.groupJid, slice),
    onBoundaryValidationFailed: (logger, mode) =>
      logger.warn(
        { conversationId: params.conversationId, groupJid: params.groupJid, mode },
        "whatsapp_llm_chunking_skipped",
      ),
    knobs: params.knobs,
  };
}

async function findConversationId(db: Kysely<DB>, groupJid: string): Promise<number | undefined> {
  const row = await db
    .selectFrom("conversations")
    .select("id")
    .where("platform", "=", "whatsapp")
    .where("kind", "=", "group")
    .where("provider_conversation_id", "=", groupJid)
    .executeTakeFirst();
  return row?.id;
}

export function validateWhatsAppBoundarySegments(raw: string, messageCount: number): WhatsAppBoundarySegment[] {
  return validateBoundarySegments(raw, messageCount);
}

export function enforceWhatsAppBoundarySize(
  segments: WhatsAppBoundarySegment[],
  messages: Array<Pick<WhatsAppLlmBoundaryMessage, "text">>,
  knobs: Pick<WhatsAppLlmChunkerKnobs, "minMessages" | "targetMessages" | "maxMessages" | "maxTokens">,
): WhatsAppBoundarySegment[] {
  return enforceBoundarySize(segments, messages, knobs);
}

/** A missing conversation deliberately reports no pending work even though the result is skipped. */
export async function runLlmChunkingPass(
  deps: WhatsAppLlmChunkerDeps,
  params: {
    conversationId: number;
    groupJid: string;
    knobs: WhatsAppLlmChunkerKnobs;
    mode: "live" | "backfill";
    maxWindows?: number;
    pendingUntil?: ChunkPendingBound;
    historyStartId?: number | null;
  },
): Promise<{
  windowsProcessed: number;
  slicesClosed: number;
  messagesProcessed: number;
  pendingRemaining: boolean;
  openSliceId: string | null;
  skippedReason?: string;
}> {
  const actualConversationId = await findConversationId(deps.db, params.groupJid);
  if (actualConversationId !== params.conversationId) {
    return {
      windowsProcessed: 0,
      slicesClosed: 0,
      messagesProcessed: 0,
      pendingRemaining: false,
      openSliceId: null,
      skippedReason: "conversation_not_found",
    };
  }
  return runChunkingPass(deps, {
    adapter: createWhatsAppChunkStreamAdapter(deps, params),
    mode: params.mode,
    maxWindows: params.maxWindows,
    pendingUntil: params.pendingUntil,
    historyStartId: params.historyStartId,
  });
}

export async function evaluateIdleClose(
  deps: WhatsAppLlmChunkerDeps,
  params: {
    conversationId: number;
    knobs: WhatsAppLlmChunkerKnobs;
    mode: "live" | "backfill";
    pendingUntil?: ChunkPendingBound;
  },
): Promise<boolean> {
  const conversation = await deps.db
    .selectFrom("conversations")
    .select("provider_conversation_id")
    .where("id", "=", params.conversationId)
    .executeTakeFirst();
  if (!conversation) return false;
  return evaluateChunkIdleClose(deps, {
    adapter: createWhatsAppChunkStreamAdapter(deps, {
      conversationId: params.conversationId,
      groupJid: conversation.provider_conversation_id,
      knobs: params.knobs,
    }),
    mode: params.mode,
    pendingUntil: params.pendingUntil,
  });
}
