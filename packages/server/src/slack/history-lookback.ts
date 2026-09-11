import type { Kysely } from "kysely";
import type { DB } from "../db/schema";

export const DEFAULT_SLACK_HISTORY_LOOKBACK_DAYS = 365;
export const SLACK_HISTORY_LOOKBACK_MIN_DAYS = 1;
export const SLACK_HISTORY_LOOKBACK_MAX_DAYS = 3650;

function clamp(days: number): number {
  return Math.min(SLACK_HISTORY_LOOKBACK_MAX_DAYS, Math.max(SLACK_HISTORY_LOOKBACK_MIN_DAYS, Math.trunc(days)));
}

export function readSlackHistoryLookbackDays(scopeConfig: string | null | undefined): number {
  if (!scopeConfig) return DEFAULT_SLACK_HISTORY_LOOKBACK_DAYS;
  try {
    const parsed: unknown = JSON.parse(scopeConfig);
    const value = (parsed as Record<string, unknown> | null)?.historyLookbackDays;
    return typeof value === "number" && Number.isFinite(value) ? clamp(value) : DEFAULT_SLACK_HISTORY_LOOKBACK_DAYS;
  } catch {
    return DEFAULT_SLACK_HISTORY_LOOKBACK_DAYS;
  }
}

/** Slack is a single system-provisioned connector, so its scope config is org-wide. */
export async function loadSlackHistoryLookbackDays(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("connector_configs")
    .select("scope_config")
    .where("connector_type", "=", "slack")
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .executeTakeFirst();
  return readSlackHistoryLookbackDays(row?.scope_config ?? null);
}
