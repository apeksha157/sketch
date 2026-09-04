import { type Kysely, sql } from "kysely";
import type { DB } from "../db/schema";
import { SLACK_CHANNEL_STREAM_KEY, SLACK_ROUTER_STREAM_KEY } from "./slack-chunker";
import { IN_CLAUSE_CHUNK_SIZE, chunk } from "./sync-utils";

interface DiscoveryRow {
  conversation_id: number;
  is_thread_reply: number;
  thread_key: string | null;
  max_id: number | string;
  row_count: number | string;
}

export interface SlackChunkDiscoveryOptions {
  db: Kysely<DB>;
  pageRows: number;
  maxPages: number;
  now?: Date;
  afterPagePersisted?: (page: number) => void | Promise<void>;
}

export interface SlackChunkDiscoverySummary {
  pages: number;
  streamsMarkedPending: number;
  conversationsTouched: number;
}

async function minimumPendingId(db: Kysely<DB>): Promise<number | null> {
  const result = await sql<{ min_id: number | string | null }>`
    SELECT MIN(m.id) AS min_id
    FROM conversation_messages AS m
    INNER JOIN conversations AS c ON c.id = m.conversation_id
    LEFT JOIN conversation_slice_stream_cursors AS r
      ON r.conversation_id = m.conversation_id
      AND r.stream_key = ${SLACK_ROUTER_STREAM_KEY}
    WHERE c.platform = 'slack'
      AND c.kind = 'channel'
      AND m.source = 'live'
      AND m.id > COALESCE(r.last_message_id, 0)
  `.execute(db);
  const value = result.rows[0]?.min_id;
  return value === null || value === undefined ? null : Number(value);
}

async function discoverPage(db: Kysely<DB>, pageMax: number): Promise<DiscoveryRow[]> {
  const result = await sql<DiscoveryRow>`
    SELECT
      m.conversation_id,
      m.is_thread_reply,
      CASE WHEN m.is_thread_reply = 1 THEN m.provider_thread_id ELSE NULL END AS thread_key,
      MAX(m.id) AS max_id,
      COUNT(*) AS row_count
    FROM conversation_messages AS m
    INNER JOIN conversations AS c ON c.id = m.conversation_id
    LEFT JOIN conversation_slice_stream_cursors AS r
      ON r.conversation_id = m.conversation_id
      AND r.stream_key = ${SLACK_ROUTER_STREAM_KEY}
    WHERE c.platform = 'slack'
      AND c.kind = 'channel'
      AND m.source = 'live'
      AND m.id > COALESCE(r.last_message_id, 0)
      AND m.id <= ${pageMax}
    GROUP BY
      m.conversation_id,
      m.is_thread_reply,
      CASE WHEN m.is_thread_reply = 1 THEN m.provider_thread_id ELSE NULL END
  `.execute(db);
  return result.rows;
}

async function persistPage(db: Kysely<DB>, rows: DiscoveryRow[], now: string): Promise<void> {
  const grouped = new Map<number, { routerMax: number; streamKeys: Set<string> }>();
  for (const row of rows) {
    const conversationId = Number(row.conversation_id);
    const group = grouped.get(conversationId) ?? { routerMax: 0, streamKeys: new Set<string>() };
    group.routerMax = Math.max(group.routerMax, Number(row.max_id));
    const streamKey = row.is_thread_reply === 1 && row.thread_key ? row.thread_key : SLACK_CHANNEL_STREAM_KEY;
    group.streamKeys.add(streamKey);
    grouped.set(conversationId, group);
  }

  await db.transaction().execute(async (trx) => {
    for (const [conversationId, group] of grouped) {
      await trx
        .insertInto("conversation_slice_stream_cursors")
        .values({
          conversation_id: conversationId,
          stream_key: SLACK_ROUTER_STREAM_KEY,
          last_message_id: group.routerMax,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["conversation_id", "stream_key"]).doUpdateSet({
            last_message_id: sql`CASE
              WHEN conversation_slice_stream_cursors.last_message_id IS NULL
                OR conversation_slice_stream_cursors.last_message_id < excluded.last_message_id
              THEN excluded.last_message_id
              ELSE conversation_slice_stream_cursors.last_message_id
            END`,
            updated_at: now,
          }),
        )
        .execute();
      const streamRows = [...group.streamKeys].map((streamKey) => ({
        conversation_id: conversationId,
        stream_key: streamKey,
        pending_since: now,
        updated_at: now,
      }));
      for (const streamRowChunk of chunk(streamRows, IN_CLAUSE_CHUNK_SIZE)) {
        await trx
          .insertInto("conversation_slice_stream_cursors")
          .values(streamRowChunk)
          .onConflict((oc) =>
            oc.columns(["conversation_id", "stream_key"]).doUpdateSet({ pending_since: now, updated_at: now }),
          )
          .execute();
      }
    }
  });
}

export async function discoverSlackChunkStreams(
  options: SlackChunkDiscoveryOptions,
): Promise<SlackChunkDiscoverySummary> {
  const pageRows = Math.max(1, options.pageRows);
  const maxPages = Math.max(1, options.maxPages);
  const now = (options.now ?? new Date()).toISOString();
  const conversations = new Set<number>();
  let pages = 0;
  let streamsMarkedPending = 0;

  while (pages < maxPages) {
    const minId = await minimumPendingId(options.db);
    if (minId === null) break;
    const rows = await discoverPage(options.db, minId + pageRows);
    if (rows.length === 0) break;
    await persistPage(options.db, rows, now);
    pages += 1;
    await options.afterPagePersisted?.(pages);
    streamsMarkedPending += rows.length;
    for (const row of rows) conversations.add(Number(row.conversation_id));
  }

  return { pages, streamsMarkedPending, conversationsTouched: conversations.size };
}
