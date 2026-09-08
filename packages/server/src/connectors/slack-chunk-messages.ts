import { ATTACHMENT_PLACEHOLDER_TEXT, parseAttachmentsJson } from "./transcript";

export const SLACK_CHANNEL_STREAM_KEY = "channel";
export const SLACK_ROUTER_STREAM_KEY = "::router";

export interface SlackChunkerMessage {
  id: number;
  effectiveAt: string;
  text: string;
  attachments: string | null;
  isBot: boolean;
}

const JOIN_LEAVE_PATTERN = /^<@U[A-Z0-9]+>\s+has\s+(joined|left)\s+the\s+(channel|group)\.?$/iu;
/**
 * \p{Emoji_Component} would be the natural class for modifiers, but it also
 * matches ASCII digits, #, and * (keycap bases), which would drop numeric
 * replies like "42" as emoji-only. Only the non-ASCII component ranges are
 * allowed: skin tones, regional indicators, ZWJ, variation selector, keycap.
 */
const EMOJI_ONLY_PATTERN =
  /^(?:\s|:[a-z0-9_+-]+:|\p{Extended_Pictographic}|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}|[\u{1F1E6}-\u{1F1FF}]|\u{200D}|\u{FE0F}|\u{20E3})+$/u;

export function parseSlackChunkAttachments(attachments: string | null): {
  hasAttachments: boolean;
  firstName: string | null;
} {
  const parsed = parseAttachmentsJson(attachments);
  return { hasAttachments: parsed.count > 0, firstName: parsed.firstName };
}

/**
 * Denoise gate for Slack slices. Bot rows are Sketch's own replies, not team
 * knowledge; the human side of a Sketch exchange stays indexable, matching the
 * WhatsApp gate. Join/leave patterns cover rows captured before the
 * capture-side subtype blocklist shipped.
 */
export function isIndexableSlackChunkMessage(message: SlackChunkerMessage): boolean {
  if (message.isBot) return false;
  const trimmed = message.text.trim();
  if (trimmed.length === 0) return false;
  if (
    trimmed.toLowerCase() === ATTACHMENT_PLACEHOLDER_TEXT &&
    !parseSlackChunkAttachments(message.attachments).hasAttachments
  )
    return false;
  if (JOIN_LEAVE_PATTERN.test(trimmed)) return false;
  if (EMOJI_ONLY_PATTERN.test(trimmed)) return false;
  return true;
}
