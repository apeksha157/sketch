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
