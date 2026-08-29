import type { Kysely } from "kysely";
import { isGenericEngagementName } from "../connectors/engagement-name-filter";
import type { DB } from "../db/schema";
import { normalizeName } from "./name-keys";

export const BARE_GENERIC_ALIAS_DENYLIST = new Set(
  [
    "project",
    "the project",
    "the dashboard",
    "dashboard",
    "questionnaire",
    "update",
    "updates",
    "meeting",
    "call",
    "notes",
    "todo",
    "misc",
    "general",
    "team",
    "internal",
    "external",
    "client",
    "vendor",
    "partner",
    "document",
    "report",
    "presentation",
    "proposal",
    "sync",
    "follow up",
    "follow-up",
    "action items",
    "next steps",
  ].map(normalizeName),
);

export function isJunkAliasValue(alias: string): boolean {
  const normalized = normalizeName(alias);
  if (!normalized || normalized.length === 1) return true;
  if (/^[\d\p{P}\p{S}\s]+$/u.test(normalized)) return true;
  if (isGenericEngagementName(alias)) return true;
  return BARE_GENERIC_ALIAS_DENYLIST.has(normalized);
}

export function filterJunkAliases(aliases: string[]): { kept: string[]; blocked: string[] } {
  const kept: string[] = [];
  const blocked: string[] = [];
  for (const alias of aliases) {
    if (isJunkAliasValue(alias)) {
      blocked.push(alias);
    } else {
      kept.push(alias);
    }
  }
  return { kept, blocked };
}

export function isSelfAliasValue(alias: string, canonicalName: string): boolean {
  const normalizedAlias = normalizeName(alias);
  return Boolean(normalizedAlias) && normalizedAlias === normalizeName(canonicalName);
}

export function filterAliasWritesForEntityName(aliases: string[], canonicalName: string): string[] {
  return aliases.filter((alias) => isSelfAliasValue(alias, canonicalName) || !isJunkAliasValue(alias));
}

export async function isLedgerBlocked(db: Kysely<DB>, entityId: string, alias: string): Promise<boolean> {
  const normalized = normalizeName(alias);
  if (!normalized) return false;
  const row = await db
    .selectFrom("entity_alias_rejections")
    .select("id")
    .where("entity_id", "=", entityId)
    .where("normalized_rejected_name", "=", normalized)
    .executeTakeFirst();
  return Boolean(row);
}
