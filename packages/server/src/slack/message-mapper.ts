import { parseSketchCommand } from "../commands";
import { ATTACHMENT_PLACEHOLDER_TEXT } from "../connectors/transcript";
import type { ConversationMessageInsert } from "../db/repositories/conversations";
import type { Attachment } from "../files";
import { isReasoningTextCommand, isToolProgressCommand } from "../progress-settings";

/** Stored capitalised; the chunker compares case-insensitively against `ATTACHMENT_PLACEHOLDER_TEXT`. */
export const SLACK_ATTACHMENT_PLACEHOLDER_TEXT =
  ATTACHMENT_PLACEHOLDER_TEXT.charAt(0).toUpperCase() + ATTACHMENT_PLACEHOLDER_TEXT.slice(1);

/** Sketch's own control commands are never conversation content, live or in history. */
export function isSlackConversationControlMessage(text: string): boolean {
  const command = parseSketchCommand(text);
  if (command === "new_session" || command === "tool_progress_query" || command === "reasoning_text_query") {
    return true;
  }
  if (command?.startsWith("tool_progress_") || command?.startsWith("reasoning_text_")) return true;
  return isToolProgressCommand(text) || isReasoningTextCommand(text);
}

export interface SlackMappableMessage {
  ts: string;
  userId?: string | null;
  botId?: string | null;
  text: string;
  threadTs?: string | null;
  isDm?: boolean;
}

export interface SlackMessageMapContext {
  conversationId: number;
  senderName: string;
  senderUserId?: string | null;
  addressedToSketch: boolean;
  attachments?: Attachment[];
  hasAttachments?: boolean;
  source?: "live" | "history";
  backfillRangeId?: string | null;
}

export interface SlackBotReplyMapContext {
  conversationId: number;
  messageRef: string;
  text: string;
  threadTs?: string | null;
  botName?: string | null;
  source?: "live" | "history";
  backfillRangeId?: string | null;
}

export function providerTimestampFromSlackTs(ts: string | undefined): string | null {
  if (!ts) return null;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/** DMs carry no thread identity; a channel top-level message is its own thread root. */
export function slackProviderThreadId(message: { ts: string; threadTs?: string | null; isDm?: boolean }):
  | string
  | null {
  if (message.isDm) return null;
  return message.threadTs ?? message.ts;
}

/**
 * The single source of truth for the dedup tuple
 * `(conversation_id, provider_message_id, sender_jid, is_bot)`. Live capture and
 * the history backfill worker both go through here, so the same Slack message
 * maps to the same row no matter which path reached it first.
 */
export function mapSlackMessageToInsert(
  message: SlackMappableMessage,
  context: SlackMessageMapContext,
): ConversationMessageInsert {
  const hasAttachments = context.hasAttachments || (context.attachments?.length ?? 0) > 0;
  return {
    conversationId: context.conversationId,
    providerMessageId: message.ts,
    senderJid: message.userId ?? message.botId ?? "unknown",
    senderName: context.senderName,
    senderUserId: context.senderUserId ?? null,
    addressedToSketch: context.addressedToSketch,
    text: message.text || (hasAttachments ? SLACK_ATTACHMENT_PLACEHOLDER_TEXT : ""),
    ...(context.attachments ? { attachments: context.attachments } : {}),
    providerThreadId: slackProviderThreadId(message),
    providerParentMessageId: message.threadTs ?? null,
    isThreadReply: Boolean(message.threadTs),
    providerTimestamp: providerTimestampFromSlackTs(message.ts),
    ...(context.source ? { source: context.source } : {}),
    ...(context.backfillRangeId ? { backfillRangeId: context.backfillRangeId } : {}),
  };
}

/** Sketch's own Slack posts, live or re-read from history, are one identity: `sender_jid='bot'`. */
export function mapSlackBotReplyToInsert(context: SlackBotReplyMapContext): ConversationMessageInsert {
  return {
    conversationId: context.conversationId,
    providerMessageId: context.messageRef,
    senderJid: "bot",
    senderName: context.botName ?? "Sketch",
    isBot: true,
    addressedToSketch: false,
    text: context.text,
    providerThreadId: context.threadTs ?? null,
    providerParentMessageId: context.threadTs ?? null,
    isThreadReply: Boolean(context.threadTs),
    providerTimestamp: providerTimestampFromSlackTs(context.messageRef),
    ...(context.source ? { source: context.source } : {}),
    ...(context.backfillRangeId ? { backfillRangeId: context.backfillRangeId } : {}),
  };
}
