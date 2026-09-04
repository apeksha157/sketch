import type { Kysely, Transaction } from "kysely";
import type { Logger } from "pino";
import type { ConversationSliceRow } from "../db/repositories/conversation-slices";
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
  type ChunkEngineDeps,
  type ChunkEngineMessage,
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

async function listRawMessages(db: Kysely<DB>, conversationId: number): Promise<ChunkEngineMessage[]> {
  const rows = await db
    .selectFrom("conversation_messages")
    .select([
      "id",
      "provider_message_id",
      "sender_name",
      "is_bot",
      "text",
      "attachments",
      "provider_timestamp",
      "received_at",
      "effective_at",
    ])
    .where("conversation_id", "=", conversationId)
    .orderBy("id", "asc")
    .execute();
  return rows.map((row) => toMessage(row as RawMessageRow));
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
    loadOpenAndPending: async (db, open) => {
      const allRaw = await listRawMessages(db, params.conversationId);
      const state = await cursor.get(db);
      if (!state) throw new Error("WhatsApp LLM chunking cursor was not claimed");
      return {
        openRaw: open ? allRaw : [],
        pendingRaw: allRaw.filter((message) => cursor.isAfterCursor(message, state)),
        pageFull: false,
      };
    },
    isIndexable: isIndexableWhatsAppChunkMessage,
    senderLabel: (message) => (message as ChunkEngineMessage & { senderName: string }).senderName,
    order: "effective_time",
    boundaries: "llm",
    flushReason: () => "llm_boundary",
    rosterSnapshot: async (trx) =>
      (
        await buildWhatsAppRosterSnapshot({
          db: trx,
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

function engineDeps(deps: WhatsAppLlmChunkerDeps): ChunkEngineDeps {
  return {
    ...deps,
    generate: (prompt, opts) =>
      deps.generate(
        prompt.replace(
          "You are the conversation boundary engine.",
          "You are the WhatsApp conversation boundary engine.",
        ),
        {
          ...opts,
          label: opts.label === "chunkBoundaryRepair" ? "whatsappLlmBoundaryRepair" : "whatsappLlmBoundary",
        },
      ),
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

export async function runLlmChunkingPass(
  deps: WhatsAppLlmChunkerDeps,
  params: {
    conversationId: number;
    groupJid: string;
    knobs: WhatsAppLlmChunkerKnobs;
    mode: "live" | "backfill";
    maxWindows?: number;
    pendingMessageIds?: number[];
  },
): Promise<{
  windowsProcessed: number;
  slicesClosed: number;
  openSliceId: string | null;
  skippedReason?: string;
}> {
  const actualConversationId = await findConversationId(deps.db, params.groupJid);
  if (actualConversationId !== params.conversationId) {
    return { windowsProcessed: 0, slicesClosed: 0, openSliceId: null, skippedReason: "conversation_not_found" };
  }
  return runChunkingPass(engineDeps(deps), {
    adapter: createWhatsAppChunkStreamAdapter(deps, params),
    mode: params.mode,
    maxWindows: params.maxWindows,
    pendingMessageIds: params.pendingMessageIds,
  });
}

export async function evaluateIdleClose(
  deps: WhatsAppLlmChunkerDeps,
  params: { conversationId: number; knobs: WhatsAppLlmChunkerKnobs; mode: "live" | "backfill" },
): Promise<boolean> {
  const conversation = await deps.db
    .selectFrom("conversations")
    .select("provider_conversation_id")
    .where("id", "=", params.conversationId)
    .executeTakeFirst();
  if (!conversation) return false;
  return evaluateChunkIdleClose(engineDeps(deps), {
    adapter: createWhatsAppChunkStreamAdapter(deps, {
      conversationId: params.conversationId,
      groupJid: conversation.provider_conversation_id,
      knobs: params.knobs,
    }),
    mode: params.mode,
  });
}
