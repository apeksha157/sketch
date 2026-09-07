/**
 * Shared fixture for the Slack speaker-block tests so the SQLite and Postgres
 * suites assert on the same seeded shape.
 */
import type { Kysely } from "kysely";
import type { DB } from "../db/schema";
import { SLACK_CONVERSATION_SLICE_FILE_TYPE } from "./types";

export const SLACK_SPEAKER_ROSTER = JSON.stringify({
  channelId: "C0PBTEST",
  channelName: "pb-test",
  participants: [
    { slackUserId: "U0SPEAKER1", displayName: "Dana Teammate", kind: "teammate", email: "dana@example.com" },
    { slackUserId: "U0SPEAKER2", displayName: "Ray External", kind: "external", email: null },
    { slackUserId: "U0QUIET001", displayName: "Quiet Member", kind: "external", email: null },
  ],
});

export async function seedSlackSliceFile(
  db: Kysely<DB>,
  options: { fileId: string; connectorConfigId: string; denoised?: boolean; rosterSnapshot?: string },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .updateTable("indexed_files")
    .set({ file_type: SLACK_CONVERSATION_SLICE_FILE_TYPE })
    .where("id", "=", options.fileId)
    .execute();
  const conversation = await db
    .insertInto("conversations")
    .values({
      platform: "slack",
      kind: "channel",
      provider_conversation_id: `C0PB-${options.fileId}`,
      display_name: "pb-test",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const ids: number[] = [];
  for (const [index, slackUserId] of ["U0SPEAKER1", "U0SPEAKER2", "U0QUIET001"].entries()) {
    const row = await db
      .insertInto("conversation_messages")
      .values({
        conversation_id: conversation.id,
        provider_message_id: `pb-${options.fileId}-${index}`,
        sender_jid: slackUserId,
        sender_name: slackUserId,
        text: `message ${index}`,
        received_at: now,
        effective_at: now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    ids.push(row.id);
  }
  await db
    .insertInto("conversation_slices")
    .values({
      id: `slice-pb-slack-${options.fileId}`,
      conversation_id: conversation.id,
      first_message_id: ids[0] as number,
      last_message_id: ids[ids.length - 1] as number,
      started_at: now,
      ended_at: now,
      message_count: ids.length,
      denoised_message_ids: options.denoised === false ? null : JSON.stringify([ids[0], ids[1]]),
      flush_reason: "llm_boundary",
      roster_snapshot: options.rosterSnapshot ?? SLACK_SPEAKER_ROSTER,
      salience_verdict: "kept",
      indexed_file_id: options.fileId,
    })
    .execute();
}
