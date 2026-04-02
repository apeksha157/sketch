/**
 * Repository for outreach_messages.
 *
 * Outreach messages track agent-initiated DMs from one user's agent to another user, including
 * the full response lifecycle. The two main read patterns are: pending outreach TO a recipient
 * (injected into the recipient's agent context before each run) and outreach FROM a requester
 * (so the requester's agent can see pending/responded questions it sent).
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../schema";

export function createOutreachRepository(db: Kysely<DB>) {
  return {
    async create(data: {
      requesterUserId: string;
      recipientUserId: string;
      message: string;
      taskContext?: string;
      platform: string;
      channelId?: string;
      messageRef?: string;
      requesterPlatform: string;
      requesterChannel: string;
      requesterThreadTs?: string;
    }) {
      const id = randomUUID();
      await db
        .insertInto("outreach_messages")
        .values({
          id,
          requester_user_id: data.requesterUserId,
          recipient_user_id: data.recipientUserId,
          message: data.message,
          task_context: data.taskContext ?? null,
          platform: data.platform,
          channel_id: data.channelId ?? null,
          message_ref: data.messageRef ?? null,
          requester_platform: data.requesterPlatform,
          requester_channel: data.requesterChannel,
          requester_thread_ts: data.requesterThreadTs ?? null,
        })
        .execute();
      return db.selectFrom("outreach_messages").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async findPendingForRecipient(userId: string) {
      return db
        .selectFrom("outreach_messages")
        .selectAll()
        .where("recipient_user_id", "=", userId)
        .where("status", "=", "pending")
        .orderBy("created_at", "asc")
        .execute();
    },

    async findForRequester(userId: string) {
      return db
        .selectFrom("outreach_messages")
        .selectAll()
        .where("requester_user_id", "=", userId)
        .where("status", "in", ["pending", "responded"])
        .orderBy("created_at", "asc")
        .execute();
    },

    async findPendingForRequester(userId: string) {
      return db
        .selectFrom("outreach_messages")
        .selectAll()
        .where("requester_user_id", "=", userId)
        .where("status", "=", "pending")
        .orderBy("created_at", "asc")
        .execute();
    },

    async markResponded(id: string, response: string) {
      await db
        .updateTable("outreach_messages")
        .set({ status: "responded", response, responded_at: new Date().toISOString() })
        .where("id", "=", id)
        .where("status", "=", "pending")
        .execute();
      return db.selectFrom("outreach_messages").selectAll().where("id", "=", id).executeTakeFirst();
    },

    async findById(id: string) {
      return db.selectFrom("outreach_messages").selectAll().where("id", "=", id).executeTakeFirst();
    },

    async expireOlderThan(hours: number) {
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      return db
        .updateTable("outreach_messages")
        .set({ status: "expired" })
        .where("status", "=", "pending")
        .where("created_at", "<", cutoff)
        .execute();
    },
  };
}
