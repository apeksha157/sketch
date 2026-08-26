import type { Kysely } from "kysely";
import type { DB } from "../db/schema";
import { normalizeWhatsAppIdentityLid, normalizeWhatsAppIdentityPhone } from "../identity-normalization";
import { createWhatsAppIdentityResolutionService } from "./identity-resolution";
import type { WhatsAppMentionRef } from "./provider";

const MENTION_TOKEN_PATTERN = /@[\u200B-\u200F\uFEFF]*\S+/gu;

export function resolveWhatsAppMentionTokens(
  text: string,
  mentions: WhatsAppMentionRef[] | null | undefined,
  displayByJid: Map<string, string | null>,
): string {
  if (!mentions?.length || !text.includes("@")) return text;
  const replacements = new Map<string, string>();
  for (const mention of mentions) {
    const display = displayByJid.get(mention.jid);
    if (!display) continue;
    for (const token of observedTokensForMention(text, mention)) {
      replacements.set(token, `@${display}`);
    }
  }
  if (replacements.size === 0) return text;
  return [...replacements.entries()]
    .sort(([left], [right]) => right.length - left.length)
    .reduce((out, [token, replacement]) => out.split(token).join(replacement), text);
}

export async function resolveMentionDisplayNames(
  db: Kysely<DB>,
  groupJid: string,
  mentions: WhatsAppMentionRef[] | null | undefined,
): Promise<Map<string, string | null>> {
  if (!mentions?.length) return new Map();
  const resolutions = await createWhatsAppIdentityResolutionService(db).resolveRoster(
    groupJid,
    mentions.map((mention) => ({
      participantJid: mention.jid,
      phoneE164: mention.phoneE164,
      lid: mention.lid,
    })),
  );
  return new Map(
    mentions.map((mention) => {
      const resolution = resolutions.get(mention.jid);
      if (resolution?.kind === "teammate" || resolution?.kind === "entity" || resolution?.kind === "labeled") {
        return [mention.jid, resolution.name] as const;
      }
      return [mention.jid, mention.phoneE164] as const;
    }),
  );
}

function observedTokensForMention(text: string, mention: WhatsAppMentionRef): string[] {
  const targetDigits = mentionDigits(mention);
  if (targetDigits.size === 0) return [];
  return [...text.matchAll(MENTION_TOKEN_PATTERN)]
    .map((match) => match[0])
    .filter((token) => targetDigits.has(tokenDigits(token)));
}

function mentionDigits(mention: WhatsAppMentionRef): Set<string> {
  return new Set(
    [mention.jid, mention.lid, mention.phoneE164]
      .map((value) => normalizeMentionDigits(value))
      .filter((value): value is string => Boolean(value)),
  );
}

function normalizeMentionDigits(value: string | null | undefined): string | null {
  const lid = normalizeWhatsAppIdentityLid(value);
  if (lid) return lid.slice(0, -4).replace(/\D/gu, "");
  const phone = normalizeWhatsAppIdentityPhone(value);
  if (phone) return phone.replace(/\D/gu, "");
  const userPart = value
    ?.trim()
    .replace(/[\u200B-\u200F\uFEFF]/gu, "")
    .replace(/^@/u, "")
    .split("@")[0]
    ?.split(":")[0]
    ?.replace(/\D/gu, "");
  return userPart || null;
}

function tokenDigits(token: string): string {
  return (
    token
      .replace(/[\u200B-\u200F\uFEFF]/gu, "")
      .replace(/^@/u, "")
      .split("@")[0]
      ?.split(":")[0]
      ?.replace(/\D/gu, "") ?? ""
  );
}
