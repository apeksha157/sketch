import type { ChunkEngineMessage } from "./chunk-engine";

/**
 * The `conversation_messages` projection every chunk stream adapter loads, and
 * the row → engine message mapping that goes with it. The connectors differ in
 * which rows they select (thread filters, history admission, ordering), never
 * in which columns they need or how a row becomes an engine message, so only
 * that part is shared.
 */
export const CHUNK_MESSAGE_COLUMNS = [
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

export interface ChunkMessageRow {
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

export interface NamedChunkEngineMessage extends ChunkEngineMessage {
  senderName: string;
}

/**
 * `effective_at` is a plain nullable column, so the mapping keeps the same
 * fallback ladder the ingest writes: provider timestamp, then receipt time.
 */
export function toNamedChunkEngineMessage(row: ChunkMessageRow, text: string = row.text): NamedChunkEngineMessage {
  return {
    id: row.id,
    providerMessageId: row.provider_message_id,
    senderName: row.sender_name,
    isBot: row.is_bot === 1,
    text,
    attachments: row.attachments,
    effectiveAt: row.effective_at ?? row.provider_timestamp ?? row.received_at,
    receivedAt: row.received_at,
  };
}

export function isNamedChunkEngineMessage(message: ChunkEngineMessage): message is NamedChunkEngineMessage {
  return "senderName" in message && typeof (message as NamedChunkEngineMessage).senderName === "string";
}
