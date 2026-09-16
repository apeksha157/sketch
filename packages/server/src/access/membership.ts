import { type Kysely, sql } from "kysely";
import type { Logger } from "pino";
import { IN_CLAUSE_CHUNK_SIZE, chunk } from "../connectors/sync-utils";
import { type AccessPrincipal, normalizeAccessPrincipals } from "../connectors/types";
import type { DB } from "../db/schema";
import {
  normalizeSlackIdentityUserId,
  normalizeWhatsAppIdentityLid,
  normalizeWhatsAppIdentityPhone,
} from "../identity-normalization";
import { lidFromParticipantRow, phoneFromParticipantJid } from "./whatsapp-identities";

export type MembershipTarget = { platform: "slack" | "whatsapp"; targetId: string };

type MembershipLogger = Pick<Logger, "warn">;

function principalKey(type: AccessPrincipal["type"], value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeAccessPrincipals([{ type, value }])[0];
  return normalized ? `${normalized.type}\0${normalized.value}` : null;
}

export async function authorizedTargets(
  db: Kysely<DB>,
  principals: AccessPrincipal[],
  targets: MembershipTarget[],
  logger?: MembershipLogger,
): Promise<Set<string>> {
  const normalizedPrincipals = normalizeAccessPrincipals(principals);
  if (normalizedPrincipals.length === 0 || targets.length === 0) return new Set();

  const principalKeys = new Set(normalizedPrincipals.map((principal) => `${principal.type}\0${principal.value}`));
  const requested = new Map<string, Set<string>>();
  for (const target of targets) {
    if (target.platform !== "slack" && target.platform !== "whatsapp") continue;
    const targetIds = requested.get(target.platform) ?? new Set<string>();
    targetIds.add(target.targetId);
    requested.set(target.platform, targetIds);
  }

  const granted = new Set<string>();
  try {
    await Promise.all([
      resolveSlackTargets(db, principalKeys, requested.get("slack") ?? new Set(), granted, logger),
      resolveWhatsAppTargets(db, principalKeys, requested.get("whatsapp") ?? new Set(), granted),
    ]);
  } catch (error) {
    logger?.warn({ err: error }, "Membership authorization failed closed");
    return new Set();
  }
  return granted;
}

/**
 * Slack channels the viewer belongs to, read straight from the synced roster.
 *
 * The roster is the answer on its own: a row exists only for a channel Sketch
 * has access to and has synced, so there is nothing to enumerate from Slack and
 * nothing further to authorize against.
 *
 * The viewer filter runs in SQL rather than over a full table read — the roster
 * grows with the whole org while a viewer's share of it does not. The JS pass
 * below still re-checks every row against the normalized principal keys.
 */
export async function listAuthorizedSlackChannels(
  db: Kysely<DB>,
  principals: AccessPrincipal[],
  logger?: MembershipLogger,
): Promise<string[]> {
  const normalizedPrincipals = normalizeAccessPrincipals(principals);
  if (normalizedPrincipals.length === 0) return [];
  const principalKeys = new Set(normalizedPrincipals.map((principal) => `${principal.type}\0${principal.value}`));
  const slackUserIds = normalizedPrincipals
    .filter((principal) => principal.type === "slack_user")
    .map((principal) => principal.value);
  const emails = normalizedPrincipals
    .filter((principal) => principal.type === "email")
    .map((principal) => principal.value);
  if (slackUserIds.length === 0 && emails.length === 0) return [];
  try {
    const activeTeamId = (
      await db.selectFrom("settings").select("slack_team_id").where("id", "=", "default").executeTakeFirst()
    )?.slack_team_id;
    const rows = await db
      .selectFrom("slack_channel_participants")
      .leftJoin("slack_user_sync_state", (join) =>
        join
          .onRef("slack_user_sync_state.slack_user_id", "=", "slack_channel_participants.slack_user_id")
          .on("slack_user_sync_state.team_id", "=", activeTeamId ?? "")
          .on("slack_user_sync_state.inactive_at", "is", null),
      )
      .select([
        "slack_channel_participants.channel_id as channelId",
        "slack_channel_participants.slack_user_id as slackUserId",
        "slack_user_sync_state.slack_user_id as syncedSlackUserId",
        "slack_user_sync_state.email as syncedEmail",
      ])
      .where((eb) =>
        eb.or([
          ...(slackUserIds.length > 0 ? [eb("slack_channel_participants.slack_user_id", "in", slackUserIds)] : []),
          ...(emails.length > 0 ? [eb(sql<string>`lower(slack_user_sync_state.email)`, "in", emails)] : []),
        ]),
      )
      .execute();
    const channelIds = new Set<string>();
    for (const row of rows) {
      const slackUserKey = principalKey("slack_user", normalizeSlackIdentityUserId(row.slackUserId));
      const emailKey = principalKey("email", row.syncedEmail);
      if ((slackUserKey && principalKeys.has(slackUserKey)) || (emailKey && principalKeys.has(emailKey))) {
        channelIds.add(row.channelId);
      }
    }
    return [...channelIds];
  } catch (error) {
    logger?.warn({ err: error }, "Slack channel listing failed closed");
    return [];
  }
}

async function resolveSlackTargets(
  db: Kysely<DB>,
  principalKeys: Set<string>,
  targetIds: Set<string>,
  granted: Set<string>,
  logger?: MembershipLogger,
): Promise<void> {
  const activeTeamId = (
    await db.selectFrom("settings").select("slack_team_id").where("id", "=", "default").executeTakeFirst()
  )?.slack_team_id;
  for (const targetIdChunk of chunk([...targetIds], IN_CLAUSE_CHUNK_SIZE)) {
    const rows = await db
      .selectFrom("slack_channel_participants")
      .leftJoin("slack_user_sync_state", (join) =>
        join
          .onRef("slack_user_sync_state.slack_user_id", "=", "slack_channel_participants.slack_user_id")
          .on("slack_user_sync_state.team_id", "=", activeTeamId ?? "")
          .on("slack_user_sync_state.inactive_at", "is", null),
      )
      .select([
        "slack_channel_participants.channel_id as channelId",
        "slack_channel_participants.slack_user_id as slackUserId",
        "slack_user_sync_state.slack_user_id as syncedSlackUserId",
        "slack_user_sync_state.email as syncedEmail",
      ])
      .where("slack_channel_participants.channel_id", "in", targetIdChunk)
      .execute();

    for (const row of rows) {
      if (row.syncedSlackUserId === null) {
        logger?.warn({ slackUserId: row.slackUserId }, "Slack membership email resolution has no sync state");
      }
      const slackUserKey = principalKey("slack_user", normalizeSlackIdentityUserId(row.slackUserId));
      const emailKey = principalKey("email", row.syncedEmail);
      if ((slackUserKey && principalKeys.has(slackUserKey)) || (emailKey && principalKeys.has(emailKey))) {
        granted.add(`slack:${row.channelId}`);
      }
    }
  }
}

async function resolveWhatsAppTargets(
  db: Kysely<DB>,
  principalKeys: Set<string>,
  targetIds: Set<string>,
  granted: Set<string>,
): Promise<void> {
  for (const targetIdChunk of chunk([...targetIds], IN_CLAUSE_CHUNK_SIZE)) {
    const rows = await db
      .selectFrom("whatsapp_group_participants")
      .select(["group_jid", "participant_jid", "phone_e164", "lid"])
      .where("group_jid", "in", targetIdChunk)
      .execute();

    for (const row of rows) {
      const phoneKey = principalKey(
        "phone",
        normalizeWhatsAppIdentityPhone(row.phone_e164) ?? phoneFromParticipantJid(row.participant_jid),
      );
      const lidKey = principalKey("whatsapp_lid", lidFromParticipantRow(row));
      if ((phoneKey && principalKeys.has(phoneKey)) || (lidKey && principalKeys.has(lidKey))) {
        granted.add(`whatsapp:${row.group_jid}`);
      }
    }
  }
}
