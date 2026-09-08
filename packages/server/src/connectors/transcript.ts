export const ATTACHMENT_PLACEHOLDER_TEXT = "see attached files.";

export interface ParsedAttachmentsJson {
  count: number;
  firstName: string | null;
  malformed: boolean;
}

/**
 * Parse a stored attachments JSON array. `count` is always a real count (0 when
 * the value is empty or unparseable). `malformed` is set when a non-empty value
 * failed to parse, because the two connectors deliberately disagree on it:
 * WhatsApp treats a malformed value as "has attachments" (fail open, the row
 * keeps its placeholder text) while Slack treats it as none (fail closed).
 */
export function parseAttachmentsJson(raw: string | null): ParsedAttachmentsJson {
  if (!raw) return { count: 0, firstName: null, malformed: false };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return { count: 0, firstName: null, malformed: false };
    const first = parsed[0];
    if (!first || typeof first !== "object") return { count: parsed.length, firstName: null, malformed: false };
    const name =
      (first as { originalName?: unknown; name?: unknown }).originalName ?? (first as { name?: unknown }).name;
    return {
      count: parsed.length,
      firstName: typeof name === "string" && name.trim() ? name.trim() : null,
      malformed: false,
    };
  } catch {
    return { count: 0, firstName: null, malformed: raw.trim().length > 0 };
  }
}

/**
 * One transcript line, shared by every chat-shaped source (WhatsApp, LinkedIn).
 *
 * `Name: text` is the base form the salience prompt, the entity extractor and
 * the embedder already read. Sources that need a timestamp or a sender tag
 * add them here, so the line shape cannot drift between connectors.
 */
export function renderTranscriptLine(input: {
  name: string;
  text: string;
  at?: string | null;
  tag?: string | null;
}): string {
  const prefix = input.at ? `[${input.at}] ` : "";
  const sender = input.tag ? `${input.name} (${input.tag})` : input.name;
  return `${prefix}${sender}: ${input.text}`;
}
