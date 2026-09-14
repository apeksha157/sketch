import type { Kysely } from "kysely";
import { createConversationRepository } from "../db/repositories/conversations";
import type { DB } from "../db/schema";
import type { AimfoxMessage } from "./aimfox-client";
import { displaySenderName, orderLinkedinMessages } from "./linkedin-aimfox";

export const LINKEDIN_CONVERSATION_PLATFORM = "linkedin";
export const LINKEDIN_CONVERSATION_KIND = "conversation";
export const LINKEDIN_DELETED_MESSAGE_TEXT = "[Deleted message]";
/** Legacy burst-segment files, identified by the provider file id the pre-engine segmenter mints. */
export const LEGACY_LINKEDIN_SEGMENT_PROVIDER_FILE_ID_PATTERN = "linkedin:%:segment-%";

/** Identical to the indexed file's `thread_id`, so both generations of files collapse together. */
export function linkedinProviderConversationId(accountId: string, conversationUrn: string): string {
  return `${accountId}:${conversationUrn}`;
}

/** The inverse. Only the first separator splits: a conversation urn contains colons of its own. */
export function parseLinkedinProviderConversationId(
  providerConversationId: string,
): { accountId: string; conversationUrn: string } | null {
  const separator = providerConversationId.indexOf(":");
  if (separator <= 0 || separator === providerConversationId.length - 1) return null;
  return {
    accountId: providerConversationId.slice(0, separator),
    conversationUrn: providerConversationId.slice(separator + 1),
  };
}

export interface LinkedinIngestParams {
  db: Kysely<DB>;
  accountId: string;
  conversationUrn: string;
  leadName: string;
  messages: AimfoxMessage[];
  /**
   * `history` for every row of a conversation's first ingest, whichever Aimfox
   * pass delivered it, so the whole backlog is chunked in backfill mode; `live`
   * only once the engine has caught up with that conversation.
   */
  source: "history" | "live";
  receivedAt?: string;
}

export interface LinkedinIngestResult {
  conversationId: number;
  ingested: number;
  inserted: number;
  textUpdated: number;
}

/**
 * Maps one Aimfox conversation onto `conversations` + `conversation_messages`.
 *
 * Messages are written one at a time in `orderLinkedinMessages` order (dated
 * ascending, undated last) because the chunk stream cursor is row-id only:
 * chronological order has to be the insertion order or the engine would read
 * the conversation out of sequence. Re-ingest is insert-or-ignore on the
 * existing provider identity index; an edit keeps the identity and only moves
 * `text`, which moves the slice's content hash and re-renders the file.
 *
 * An Aimfox campaign message lands as `is_bot`, the column the emitter reads
 * back to re-render the legacy `(automated)` tag. The engine core never reads
 * it, and the adapter's `isIndexable` is text-based, so a campaign message
 * stays a full member of its slice rather than being denoised away.
 */
export async function ingestLinkedinConversation(params: LinkedinIngestParams): Promise<LinkedinIngestResult> {
  const repo = createConversationRepository(params.db);
  const conversation = await repo.getOrCreate(
    {
      platform: LINKEDIN_CONVERSATION_PLATFORM,
      kind: LINKEDIN_CONVERSATION_KIND,
      providerConversationId: linkedinProviderConversationId(params.accountId, params.conversationUrn),
    },
    params.leadName,
  );
  const receivedAt = params.receivedAt ?? new Date().toISOString();
  const ordered = orderLinkedinMessages(params.conversationUrn, params.messages);
  let inserted = 0;
  let textUpdated = 0;

  for (const entry of ordered) {
    const text = linkedinMessageText(entry.message);
    const result = await repo.insertMessage({
      conversationId: conversation.id,
      providerMessageId: entry.identity,
      senderJid: entry.message.sender.id,
      senderName: displaySenderName(entry.message.sender),
      isBot: entry.message.automated === true,
      text,
      providerTimestamp: entry.timestamp,
      providerFromMe: entry.message.sender.id === params.accountId,
      receivedAt,
      source: params.source,
    });
    if (result.inserted) {
      inserted += 1;
      continue;
    }
    if (result.row.text === text) continue;
    await params.db.updateTable("conversation_messages").set({ text }).where("id", "=", result.row.id).execute();
    textUpdated += 1;
  }

  return { conversationId: conversation.id, ingested: ordered.length, inserted, textUpdated };
}

/** Deleted messages keep their row so a sealed slice never loses a member. */
function linkedinMessageText(message: AimfoxMessage): string {
  return message.deleted ? LINKEDIN_DELETED_MESSAGE_TEXT : (message.body ?? "").trim();
}
