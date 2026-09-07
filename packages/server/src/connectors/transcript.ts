export const ATTACHMENT_PLACEHOLDER_TEXT = "see attached files.";

export function parseAttachmentsJson(raw: string | null): { count: number; firstName: string | null } {
  if (!raw) return { count: 0, firstName: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return { count: 0, firstName: null };
    const first = parsed[0];
    if (!first || typeof first !== "object") return { count: parsed.length, firstName: null };
    const name =
      (first as { originalName?: unknown; name?: unknown }).originalName ?? (first as { name?: unknown }).name;
    return {
      count: parsed.length,
      firstName: typeof name === "string" && name.trim() ? name.trim() : null,
    };
  } catch {
    return { count: raw.trim().length > 0 ? -1 : 0, firstName: null };
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
