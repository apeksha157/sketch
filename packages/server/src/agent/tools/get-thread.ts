import type { Kysely } from "kysely";
import { sql } from "kysely";
import { z } from "zod/v4";
import { resolveContentPrincipals } from "../../access/principals";
import { parseEmailAddrJson } from "../../connectors/email/envelope-metadata";
import { idInList } from "../../connectors/id-in-list";
import { filterAccessibleFileIds } from "../../connectors/search";
import type { AccessPrincipal } from "../../connectors/types";
import {
  type FileViewer,
  THREAD_FILE_COLUMNS,
  countThreadFiles,
  createConnectorRepository,
  listThreadFiles,
} from "../../db/repositories/connectors";
import type { DB } from "../../db/schema";
import { contentPrincipalDeps, viewerForPrincipals } from "./entity-visibility";
import type { SketchMcpDeps, ToolResult } from "./types";

const EMAIL_SOURCES = new Set(["gmail", "outlook"]);

export const getThreadToolDescription = [
  "Get the whole conversation or rollup for an indexed file as structured JSON, oldest first.",
  "Use this after sketch_search, sketch_search_entities, or sketch_get_entity returns a fileId and you need the surrounding thread.",
].join("\n\n");

export const getThreadToolSchema = {
  fileId: z.string().describe("Indexed file ID to use as the thread anchor."),
  limit: z.number().int().min(1).max(200).optional().describe("Max messages to return. Default 50."),
  offset: z.number().int().min(0).optional().describe("Zero-based message offset for paging. Default 0."),
  maxCharsPerMessage: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe("Max content characters per message. Default 2000."),
};

export type GetThreadArgs = z.infer<z.ZodObject<typeof getThreadToolSchema>>;

type ThreadKind = "email_thread" | "linkedin_conversation" | "calendar_series" | "crm_record" | "single";

type ThreadRow = Awaited<ReturnType<typeof listThreadFiles>>[number];

interface MessageOutput {
  fileId: string;
  occurredAt: string | null;
  title: string;
  source: string;
  fileType: string | null;
  author: string | null;
  url: string | null;
  content: string;
  contentTruncated: boolean;
}

function notFound(): ToolResult {
  return { content: [{ type: "text", text: "Thread not found." }] };
}

function occurredAt(row: Pick<ThreadRow, "source_updated_at" | "source_created_at">): string | null {
  return row.source_updated_at ?? row.source_created_at;
}

function threadKey(connectorConfigId: string, threadId: string | null, fileId: string): string {
  return `${connectorConfigId}:${threadId ?? fileId}`;
}

function visibilityFor(principals: AccessPrincipal[] | undefined, slackEntitySyncEnabled: boolean) {
  return principals === undefined ? undefined : { principals, slackEntitySyncEnabled };
}

async function loadEmailMetadata(db: Kysely<DB>, fileIds: string[]) {
  if (fileIds.length === 0)
    return new Map<string, { subject: string | null; sentAt: string | null; author: string | null }>();
  const rows = await db
    .selectFrom("email_message_envelopes")
    .select(["indexed_file_id", "subject", "sent_at", "from_json"])
    .where(idInList(db, sql.ref("email_message_envelopes.indexed_file_id"), fileIds))
    .execute();
  return new Map(
    rows.map((row) => {
      const from = parseEmailAddrJson(row.from_json);
      return [row.indexed_file_id, { subject: row.subject, sentAt: row.sent_at, author: from.name || from.email }];
    }),
  );
}

async function loadMessageContent(
  db: Kysely<DB>,
  messages: MessageOutput[],
  opts: { maxCharsPerMessage: number; maxTotalChars: number },
): Promise<boolean> {
  if (messages.length === 0) return false;
  const rows = await db
    .selectFrom("indexed_files")
    .select(["id", "content", "summary"])
    .where(
      idInList(
        db,
        sql.ref("indexed_files.id"),
        messages.map((message) => message.fileId),
      ),
    )
    .execute();
  const contentByFile = new Map(rows.map((row) => [row.id, row.content ?? row.summary ?? ""]));
  let used = 0;
  let truncated = false;

  for (const message of messages) {
    if (used >= opts.maxTotalChars) {
      truncated = true;
      continue;
    }
    const content = contentByFile.get(message.fileId) ?? "";
    const available = opts.maxTotalChars - used;
    const output = content.slice(0, Math.min(opts.maxCharsPerMessage, available));
    message.content = output;
    message.contentTruncated = content.length > output.length;
    used += output.length;
    if (message.contentTruncated) truncated = true;
  }

  return truncated;
}

function serializeRows(
  rows: ThreadRow[],
  emailMetadata: Awaited<ReturnType<typeof loadEmailMetadata>>,
): MessageOutput[] {
  return rows.map((row) => {
    const email = emailMetadata.get(row.id);
    return {
      fileId: row.id,
      occurredAt: email?.sentAt ?? occurredAt(row),
      title: email?.subject ?? row.file_name,
      source: row.source,
      fileType: row.file_type,
      author: email?.author ?? null,
      url: row.provider_url,
      content: "",
      contentTruncated: false,
    };
  });
}

async function loadThreadSummary(
  db: Kysely<DB>,
  connectorConfigId: string,
  threadId: string,
  canShow: boolean,
): Promise<{ summary: string | null; summaryWithheld?: true }> {
  if (!canShow) return { summary: null, summaryWithheld: true };
  const row = await db
    .selectFrom("email_thread_summaries")
    .select("summary")
    .where("connector_config_id", "=", connectorConfigId)
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
  return { summary: row?.summary ?? null };
}

async function loadCrmSummary(
  db: Kysely<DB>,
  connectorConfigId: string,
  groupId: string,
  canShow: boolean,
): Promise<{ summary: string | null; summaryWithheld?: true }> {
  if (!canShow) return { summary: null, summaryWithheld: true };
  const row = await db
    .selectFrom("crm_object_summaries")
    .select("summary")
    .where("connector_config_id", "=", connectorConfigId)
    .where("group_id", "=", groupId)
    .executeTakeFirst();
  return { summary: row?.summary ?? null };
}

async function rawVisibleFileCount(
  db: Kysely<DB>,
  fileIds: string[],
  principals: AccessPrincipal[] | undefined,
  slackEntitySyncEnabled: boolean,
): Promise<number> {
  if (principals === undefined) return fileIds.length;
  const visible = await filterAccessibleFileIds(db, fileIds, principals, slackEntitySyncEnabled);
  return visible.size;
}

async function loadCrmAnchorRow(
  db: Kysely<DB>,
  connectorConfigId: string,
  groupId: string,
): Promise<ThreadRow | undefined> {
  return db
    .selectFrom("indexed_files")
    .select([...THREAD_FILE_COLUMNS])
    .where("indexed_files.connector_config_id", "=", connectorConfigId)
    .where("indexed_files.provider_file_id", "=", groupId)
    .where("indexed_files.rollup_group_id", "=", groupId)
    .where("indexed_files.is_archived", "=", 0)
    .executeTakeFirst();
}

export async function handleGetThread(args: GetThreadArgs, deps: SketchMcpDeps): Promise<ToolResult> {
  if (!deps.db) {
    return { content: [{ type: "text", text: "Thread lookup not available." }] };
  }

  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const maxCharsPerMessage = args.maxCharsPerMessage ?? 2000;
  const slackEntitySyncEnabled = deps.slackEntitySyncEnabled ?? true;
  const principals = await resolveContentPrincipals(contentPrincipalDeps(deps));
  if (principals !== undefined && principals.length === 0) return notFound();

  const viewer = viewerForPrincipals(principals, slackEntitySyncEnabled);
  const connectorRepo = createConnectorRepository(deps.db);
  const anchor = await connectorRepo.getRollupAnchorRef(args.fileId, viewer);
  if (!anchor) return notFound();

  const visibility = visibilityFor(principals, slackEntitySyncEnabled);
  let kind: ThreadKind = "single";
  let key = threadKey(anchor.connector_config_id, anchor.thread_id, anchor.id);
  let total = 1;
  let rows: ThreadRow[] = [];
  let summaryState: { summary: string | null; summaryWithheld?: true } = { summary: null };

  const threadScope = anchor.thread_id
    ? { connectorConfigId: anchor.connector_config_id, by: { threadId: anchor.thread_id } as const }
    : null;
  const pageThread = (scope: NonNullable<typeof threadScope>) =>
    listThreadFiles(deps.db as Kysely<DB>, { ...scope, visibility, limit, offset });

  if (threadScope && EMAIL_SOURCES.has(anchor.source)) {
    kind = "email_thread";
    total = await countThreadFiles(deps.db, { ...threadScope, visibility });
    rows = await pageThread(threadScope);
    const rawTotal = await countThreadFiles(deps.db, threadScope);
    summaryState = await loadThreadSummary(
      deps.db,
      anchor.connector_config_id,
      threadScope.by.threadId,
      principals === undefined || total === rawTotal,
    );
  } else if (threadScope && anchor.file_type === "linkedin_conversation") {
    kind = "linkedin_conversation";
    total = await countThreadFiles(deps.db, { ...threadScope, visibility });
    rows = await pageThread(threadScope);
  } else if (threadScope && anchor.file_type === "calendar_event") {
    total = await countThreadFiles(deps.db, { ...threadScope, visibility });
    kind = total > 1 ? "calendar_series" : "single";
    rows = await pageThread(threadScope);
  } else if (anchor.rollup_group_id) {
    kind = "crm_record";
    key = `${anchor.connector_config_id}:${anchor.rollup_group_id}`;
    const groupScope = { connectorConfigId: anchor.connector_config_id, by: { rollupGroupId: anchor.rollup_group_id } };
    total = await countThreadFiles(deps.db, { ...groupScope, visibility });
    const anchorRow = await loadCrmAnchorRow(deps.db, anchor.connector_config_id, anchor.rollup_group_id);
    const anchorVisible =
      anchorRow !== undefined &&
      (await rawVisibleFileCount(deps.db, [anchorRow.id], principals, slackEntitySyncEnabled)) === 1;
    const includeAnchor = offset === 0 && anchorVisible;
    const activityLimit = includeAnchor ? limit - 1 : limit;
    const activityOffset = anchorVisible ? Math.max(0, offset - 1) : offset;
    const activities =
      activityLimit > 0
        ? await listThreadFiles(deps.db, {
            ...groupScope,
            visibility,
            excludeProviderFileId: anchor.rollup_group_id,
            limit: activityLimit,
            offset: activityOffset,
          })
        : [];
    rows = [...(includeAnchor && anchorRow ? [anchorRow] : []), ...activities];
    const rawTotal = await countThreadFiles(deps.db, groupScope);
    summaryState = await loadCrmSummary(
      deps.db,
      anchor.connector_config_id,
      anchor.rollup_group_id,
      principals === undefined || total === rawTotal,
    );
  } else {
    rows = offset === 0 && limit > 0 ? [anchor] : [];
  }

  const emailMetadata =
    kind === "email_thread"
      ? await loadEmailMetadata(
          deps.db,
          rows.map((row) => row.id),
        )
      : new Map();
  const messages = serializeRows(rows, emailMetadata);
  const truncated = await loadMessageContent(deps.db, messages, {
    maxCharsPerMessage,
    maxTotalChars: deps.publicMcp?.maxFileContentChars ?? 50_000,
  });
  const response = {
    kind,
    threadKey: key,
    ...summaryState,
    total,
    offset,
    messages,
    ...(truncated ? { truncated: true } : {}),
  };

  return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
}
