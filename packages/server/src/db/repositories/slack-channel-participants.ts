import { type Kysely, sql } from "kysely";
import type { DB } from "../schema";

export function createSlackChannelParticipantsRepository(db: Kysely<DB>) {
  return {
    async upsert(channelId: string, slackUserId: string, lastSeenAt = new Date().toISOString()): Promise<void> {
      await db
        .insertInto("slack_channel_participants")
        .values({
          channel_id: channelId,
          slack_user_id: slackUserId,
          last_seen_at: lastSeenAt,
        })
        .onConflict((oc) =>
          oc.columns(["channel_id", "slack_user_id"]).doUpdateSet({
            last_seen_at: sql`excluded.last_seen_at`,
          }),
        )
        .execute();
    },

    /**
     * DB-backed replacement for `SlackBot.isUserInChannel`, which paginates
     * `conversations.members` live. The roster here is what `authorizedTargets`
     * already trusts for access decisions.
     */
    async hasParticipant(channelId: string, slackUserId: string): Promise<boolean> {
      const row = await db
        .selectFrom("slack_channel_participants")
        .select("channel_id")
        .where("channel_id", "=", channelId)
        .where("slack_user_id", "=", slackUserId)
        .executeTakeFirst();
      return row !== undefined;
    },

    /** True when any roster row exists for the channel, i.e. it has been synced. */
    async hasRoster(channelId: string): Promise<boolean> {
      const row = await db
        .selectFrom("slack_channel_participants")
        .select("channel_id")
        .where("channel_id", "=", channelId)
        .executeTakeFirst();
      return row !== undefined;
    },

    async remove(channelId: string, slackUserId: string): Promise<void> {
      await db
        .deleteFrom("slack_channel_participants")
        .where("channel_id", "=", channelId)
        .where("slack_user_id", "=", slackUserId)
        .execute();
    },

    async clearAll(): Promise<void> {
      await db.deleteFrom("slack_channel_participants").execute();
    },

    async replaceChannelRoster(
      channelId: string,
      slackUserIds: string[],
      lastSeenAt = new Date().toISOString(),
      preserveSeenAfter?: string,
    ): Promise<void> {
      const members = [...new Set(slackUserIds.map((id) => id.trim()).filter((id) => id.length > 0))];
      if (members.length === 0) throw new Error("Slack channel roster must not be empty");

      await db.transaction().execute(async (trx) => {
        await (preserveSeenAfter
          ? trx
              .deleteFrom("slack_channel_participants")
              .where("channel_id", "=", channelId)
              .where("last_seen_at", "<=", preserveSeenAfter)
          : trx.deleteFrom("slack_channel_participants").where("channel_id", "=", channelId)
        ).execute();
        await trx
          .insertInto("slack_channel_participants")
          .values(
            members.map((slackUserId) => ({
              channel_id: channelId,
              slack_user_id: slackUserId,
              last_seen_at: lastSeenAt,
            })),
          )
          .onConflict((oc) =>
            oc.columns(["channel_id", "slack_user_id"]).doUpdateSet({
              last_seen_at: sql`excluded.last_seen_at`,
            }),
          )
          .execute();
      });
    },
  };
}
