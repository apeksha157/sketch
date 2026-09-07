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

export const SLACK_INTERLEAVED_ROSTER = JSON.stringify({
  channelId: "C0PBMIX",
  channelName: "pb-mix",
  participants: [
    { slackUserId: "U0CHANNEL1", displayName: "Cara Channel", kind: "teammate", email: "cara@example.com" },
    { slackUserId: "U0THREAD01", displayName: "Theo Thread", kind: "external", email: null },
  ],
});

const INTERLEAVED_THREAD_TS = "1700000000.000100";

/**
 * Seeds one conversation whose channel and thread rows interleave inside a
 * single id span, plus a channel slice and a thread slice that both fall back
 * to the id range (no `denoised_message_ids`). Without stream folding each
 * slice would list the other stream's speakers.
 */
export async function seedSlackInterleavedStreamFiles(
  db: Kysely<DB>,
  options: { channelFileId: string; threadFileId: string },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .updateTable("indexed_files")
    .set({ file_type: SLACK_CONVERSATION_SLICE_FILE_TYPE })
    .where("id", "in", [options.channelFileId, options.threadFileId])
    .execute();
  const conversation = await db
    .insertInto("conversations")
    .values({
      platform: "slack",
      kind: "channel",
      provider_conversation_id: `C0PBMIX-${options.channelFileId}`,
      display_name: "pb-mix",
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const plan = [
    { slackUserId: "U0CHANNEL1", isThreadReply: false },
    { slackUserId: "U0THREAD01", isThreadReply: true },
    { slackUserId: "U0CHANNEL1", isThreadReply: false },
    { slackUserId: "U0THREAD01", isThreadReply: true },
  ];
  const ids: number[] = [];
  for (const [index, row] of plan.entries()) {
    const inserted = await db
      .insertInto("conversation_messages")
      .values({
        conversation_id: conversation.id,
        provider_message_id: `pb-mix-${options.channelFileId}-${index}`,
        sender_jid: row.slackUserId,
        sender_name: row.slackUserId,
        text: `message ${index}`,
        received_at: now,
        effective_at: now,
        is_thread_reply: row.isThreadReply ? 1 : 0,
        provider_thread_id: row.isThreadReply ? INTERLEAVED_THREAD_TS : null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    ids.push(inserted.id);
  }

  await db
    .insertInto("conversation_slices")
    .values([
      {
        id: `slice-pb-mix-channel-${options.channelFileId}`,
        conversation_id: conversation.id,
        provider_thread_id: null,
        first_message_id: ids[0] as number,
        last_message_id: ids[3] as number,
        started_at: now,
        ended_at: now,
        message_count: 2,
        denoised_message_ids: null,
        flush_reason: "llm_boundary",
        roster_snapshot: SLACK_INTERLEAVED_ROSTER,
        salience_verdict: "kept",
        indexed_file_id: options.channelFileId,
      },
      {
        id: `slice-pb-mix-thread-${options.threadFileId}`,
        conversation_id: conversation.id,
        provider_thread_id: INTERLEAVED_THREAD_TS,
        first_message_id: ids[1] as number,
        last_message_id: ids[3] as number,
        started_at: now,
        ended_at: now,
        message_count: 2,
        denoised_message_ids: null,
        flush_reason: "gap",
        roster_snapshot: SLACK_INTERLEAVED_ROSTER,
        salience_verdict: "kept",
        indexed_file_id: options.threadFileId,
      },
    ])
    .execute();
}
