/**
 * Notion connector.
 *
 * Uses the Notion REST API v1 (2022-06-28) via direct HTTP calls.
 * Auth: Internal integration token or OAuth.
 *
 * Sync strategy:
 * - Discovers databases and pages via /search endpoint
 * - Fetches page content by recursively extracting blocks → markdown
 * - Database entries: stores title + properties as structured metadata
 * - Incremental: filter by last_edited_time using cursor timestamp
 *
 * Rate limit: 3 req/s (Notion's published limit). We use a simple
 * timestamp-tracking throttle to stay within bounds.
 */
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { Connector, ConnectorCredentials, OAuthCredentials, SyncedItem } from "./types";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const TOKEN_ENDPOINT = "https://api.notion.com/v1/oauth/token";

const RATE_LIMIT_REQUESTS = 3;
const RATE_LIMIT_PERIOD_MS = 1000;
const PAGE_SIZE = 100;
const MAX_BLOCK_DEPTH = 5;

function getAccessToken(credentials: ConnectorCredentials): string {
  if (credentials.type === "api_key") return credentials.api_key;
  if (credentials.type === "oauth") return credentials.access_token;
  throw new Error("Notion connector requires api_key or oauth credentials");
}

function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

/**
 * Create per-connector-instance rate limiter and request helpers.
 * Keeps requestTimes in closure so concurrent connector syncs don't share state.
 */
function makeNotionRequests() {
  const requestTimes: number[] = [];

  async function waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_PERIOD_MS;
    while (requestTimes.length > 0 && requestTimes[0] < cutoff) {
      requestTimes.shift();
    }
    if (requestTimes.length >= RATE_LIMIT_REQUESTS) {
      const oldest = requestTimes[0];
      const waitMs = oldest + RATE_LIMIT_PERIOD_MS - now + 10;
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    requestTimes.push(Date.now());
  }

  async function notionGet(path: string, token: string, attempt = 1): Promise<unknown> {
    await waitForRateLimit();

    let response: Response;
    try {
      response = await fetch(`${NOTION_API}${path}`, {
        headers: notionHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const cause = err instanceof Error && "cause" in err ? ((err.cause as Error)?.message ?? "") : "";
      const detail = cause ? `${(err as Error).message} (${cause})` : (err as Error).message;

      if (attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return notionGet(path, token, attempt + 1);
      }

      throw new Error(`Notion API GET ${path} network error after ${MAX_RETRIES} attempts: ${detail}`);
    }

    if (response.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Notion API GET ${path} rate limited after ${MAX_RETRIES} attempts`);
      }
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 2000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return notionGet(path, token, attempt + 1);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Notion API GET ${path} failed (${response.status}): ${body}`);
    }

    return response.json();
  }

  async function notionPost(path: string, token: string, body: unknown, attempt = 1): Promise<unknown> {
    await waitForRateLimit();

    let response: Response;
    try {
      response = await fetch(`${NOTION_API}${path}`, {
        method: "POST",
        headers: notionHeaders(token),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const cause = err instanceof Error && "cause" in err ? ((err.cause as Error)?.message ?? "") : "";
      const detail = cause ? `${(err as Error).message} (${cause})` : (err as Error).message;

      if (attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return notionPost(path, token, body, attempt + 1);
      }

      throw new Error(`Notion API POST ${path} network error after ${MAX_RETRIES} attempts: ${detail}`);
    }

    if (response.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Notion API POST ${path} rate limited after ${MAX_RETRIES} attempts`);
      }
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 2000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return notionPost(path, token, body, attempt + 1);
    }

    if (!response.ok) {
      const body2 = await response.text();
      throw new Error(`Notion API POST ${path} failed (${response.status}): ${body2}`);
    }

    return response.json();
  }

  return { notionGet, notionPost };
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Extract plain text from Notion rich_text array. */
function extractRichText(
  richText: Array<{ plain_text: string; annotations?: Record<string, boolean>; href?: string }>,
): string {
  if (!richText || !Array.isArray(richText)) return "";
  return richText
    .map((item) => {
      let text = item.plain_text ?? "";
      const ann = item.annotations;
      if (ann?.bold) text = `**${text}**`;
      if (ann?.italic) text = `*${text}*`;
      if (ann?.strikethrough) text = `~~${text}~~`;
      if (ann?.code) text = `\`${text}\``;
      if (item.href) text = `[${text}](${item.href})`;
      return text;
    })
    .join("");
}

/** Convert a single Notion block to markdown text. */
function blockToMarkdown(block: { type: string; [key: string]: unknown }, depth: number): string {
  const type = block.type;
  const data = block[type] as Record<string, unknown> | undefined;
  if (!data) return "";

  const richText = data.rich_text as
    | Array<{ plain_text: string; annotations?: Record<string, boolean>; href?: string }>
    | undefined;
  const text = richText ? extractRichText(richText) : "";
  const indent = "  ".repeat(depth);

  switch (type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `${indent}- ${text}`;
    case "numbered_list_item":
      return `${indent}1. ${text}`;
    case "to_do": {
      const checked = (data.checked as boolean) ? "x" : " ";
      return `${indent}- [${checked}] ${text}`;
    }
    case "quote":
      return `> ${text}`;
    case "callout": {
      const icon = data.icon as { emoji?: string } | undefined;
      const emoji = icon?.emoji ?? "";
      return `**${emoji} ${text}**`;
    }
    case "code": {
      const lang = (data.language as string) ?? "";
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case "divider":
      return "---";
    case "equation": {
      const expr = (data.expression as string) ?? "";
      return `$$\n${expr}\n$$`;
    }
    case "bookmark":
    case "embed": {
      const url = (data.url as string) ?? "";
      return url ? `[${type}](${url})` : "";
    }
    case "image":
    case "video":
    case "file":
    case "pdf": {
      const fileData = (data.file as { url: string } | undefined) ?? (data.external as { url: string } | undefined);
      const caption = data.caption ? extractRichText(data.caption as Array<{ plain_text: string }>) : "";
      return caption ? `[${type}: ${caption}]` : `[${type}]`;
    }
    case "child_page": {
      const title = (data.title as string) ?? "";
      return `📄 **${title}** (Child Page)`;
    }
    case "child_database": {
      const dbTitle = (data.title as string) ?? "";
      return `📊 **${dbTitle}** (Database)`;
    }
    default:
      return text;
  }
}

type NotionGetFn = ReturnType<typeof makeNotionRequests>["notionGet"];
type NotionPostFn = ReturnType<typeof makeNotionRequests>["notionPost"];

/** Recursively fetch blocks and convert to markdown. */
async function extractPageContent(
  pageId: string,
  token: string,
  logger: Logger,
  notionGet: NotionGetFn,
  depth = 0,
): Promise<string[]> {
  if (depth > MAX_BLOCK_DEPTH) return [];

  const lines: string[] = [];
  let startCursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const path = startCursor
      ? `/blocks/${pageId}/children?start_cursor=${startCursor}&page_size=${PAGE_SIZE}`
      : `/blocks/${pageId}/children?page_size=${PAGE_SIZE}`;

    let response: { results: Array<Record<string, unknown>>; has_more: boolean; next_cursor: string | null };
    try {
      response = (await notionGet(path, token)) as typeof response;
    } catch (err) {
      logger.debug({ err, pageId, depth }, "Failed to fetch blocks (may be inaccessible)");
      break;
    }

    for (const block of response.results) {
      const md = blockToMarkdown(block as { type: string; [key: string]: unknown }, depth);
      if (md) lines.push(md);

      if (block.has_children && block.type !== "child_page" && block.type !== "child_database") {
        const childLines = await extractPageContent(block.id as string, token, logger, notionGet, depth + 1);
        lines.push(...childLines);
      }
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  return lines;
}

/** Format database page properties into readable text. */
function formatPropertyValue(prop: { type: string; [key: string]: unknown }): string {
  const type = prop.type;
  const value = prop[type];

  if (value === null || value === undefined) return "";

  switch (type) {
    case "title":
    case "rich_text":
      return extractRichText(value as Array<{ plain_text: string }>);
    case "number":
      return String(value);
    case "url":
    case "email":
    case "phone_number":
      return String(value ?? "");
    case "checkbox":
      return value ? "Yes" : "No";
    case "select":
    case "status":
      return (value as { name: string })?.name ?? "";
    case "multi_select":
      return (value as Array<{ name: string }>).map((o) => o.name).join(", ");
    case "date": {
      const d = value as { start?: string; end?: string };
      return d.end ? `${d.start} – ${d.end}` : (d.start ?? "");
    }
    case "people":
      return (value as Array<{ name: string }>).map((p) => p.name).join(", ");
    case "relation":
      return `${(value as unknown[]).length} relation(s)`;
    case "files":
      return `${(value as unknown[]).length} file(s)`;
    case "formula": {
      const f = value as { type: string; [key: string]: unknown };
      return String(f[f.type] ?? "");
    }
    default:
      return "";
  }
}

/** Extract title from a Notion page's properties. */
function extractPageTitle(properties: Record<string, { type: string; [key: string]: unknown }>): string {
  for (const prop of Object.values(properties)) {
    if (prop.type === "title") {
      return extractRichText(prop.title as Array<{ plain_text: string }>);
    }
  }
  return "Untitled";
}

async function refreshNotionToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const basicAuth = Buffer.from(`${credentials.client_id}:${credentials.client_secret}`).toString("base64");
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Notion token refresh failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in?: number;
  };

  return {
    ...credentials,
    access_token: data.access_token,
    token_type: data.token_type,
    ...(data.expires_in && { expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString() }),
  };
}

export function createNotionConnector(): Connector {
  // Per-connector-instance rate limiter state — not shared across concurrent syncs
  const { notionGet, notionPost } = makeNotionRequests();

  return {
    type: "notion",

    async validateCredentials(credentials) {
      const token = getAccessToken(credentials);
      await notionGet("/users/me", token);
    },

    async *sync({ credentials, scopeConfig, cursor, logger }) {
      const token = getAccessToken(credentials);
      const sinceCursor = cursor ?? null;

      yield* syncDatabases(token, sinceCursor, logger, notionGet, notionPost);
      yield* syncPages(token, sinceCursor, logger, notionGet, notionPost);
    },

    async getCursor({ currentCursor }) {
      return new Date().toISOString();
    },

    async refreshTokens(credentials) {
      if (credentials.expires_at && new Date(credentials.expires_at) > new Date()) {
        return null;
      }
      return refreshNotionToken(credentials);
    },
  };
}

/** Discover and sync all databases + their page entries. */
async function* syncDatabases(
  token: string,
  since: string | null,
  logger: Logger,
  notionGet: NotionGetFn,
  notionPost: NotionPostFn,
): AsyncGenerator<SyncedItem> {
  let startCursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, unknown> = {
      filter: { property: "object", value: "database" },
      page_size: PAGE_SIZE,
    };
    if (startCursor) body.start_cursor = startCursor;

    const response = (await notionPost("/search", token, body)) as {
      results: Array<Record<string, unknown>>;
      has_more: boolean;
      next_cursor: string | null;
    };

    for (const db of response.results) {
      if (db.archived || db.in_trash) continue;

      const lastEdited = db.last_edited_time as string;
      if (since && lastEdited && lastEdited < since) continue;

      const titleArr = (db.title as Array<{ plain_text: string }>) ?? [];
      const title = extractRichText(titleArr);
      const dbId = db.id as string;
      const url = db.url as string;

      yield {
        providerFileId: `db-${dbId}`,
        providerUrl: url ?? null,
        fileName: title || "Untitled Database",
        fileType: "database",
        contentCategory: "structured",
        content: `Database: ${title}`,
        sourcePath: null,
        contentHash: contentHash(`db-${dbId}-${lastEdited}`),
        sourceCreatedAt: (db.created_time as string) ?? null,
        sourceUpdatedAt: lastEdited ?? null,
        // Notion API doesn't expose per-page permissions — no access restrictions
      };

      yield* syncDatabasePages(dbId, title, token, since, logger, notionPost);
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }
}

/** Fetch all pages within a database. */
async function* syncDatabasePages(
  databaseId: string,
  dbTitle: string,
  token: string,
  since: string | null,
  logger: Logger,
  notionPost: NotionPostFn,
): AsyncGenerator<SyncedItem> {
  let startCursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, unknown> = { page_size: PAGE_SIZE };
    if (startCursor) body.start_cursor = startCursor;

    let response: {
      results: Array<Record<string, unknown>>;
      has_more: boolean;
      next_cursor: string | null;
    };
    try {
      response = (await notionPost(`/databases/${databaseId}/query`, token, body)) as typeof response;
    } catch (err) {
      logger.warn({ err, databaseId }, "Failed to query database");
      break;
    }

    for (const page of response.results) {
      if (page.archived || page.in_trash) continue;

      const lastEdited = page.last_edited_time as string;
      if (since && lastEdited && lastEdited < since) continue;

      const properties = page.properties as Record<string, { type: string; [key: string]: unknown }>;
      const title = extractPageTitle(properties);
      const pageId = page.id as string;
      const url = page.url as string;

      const propsText = Object.entries(properties)
        .map(([key, prop]) => {
          const val = formatPropertyValue(prop);
          return val ? `${key}: ${val}` : null;
        })
        .filter(Boolean)
        .join(" | ");

      yield {
        providerFileId: pageId,
        providerUrl: url ?? null,
        fileName: title || "Untitled",
        fileType: "page",
        contentCategory: "structured",
        content: propsText ? `${title}\n\n${propsText}` : title,
        sourcePath: dbTitle,
        contentHash: contentHash(`${pageId}-${lastEdited}`),
        sourceCreatedAt: (page.created_time as string) ?? null,
        sourceUpdatedAt: lastEdited ?? null,
      };
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }
}

/** Discover and sync standalone pages (not in a database). */
async function* syncPages(
  token: string,
  since: string | null,
  logger: Logger,
  notionGet: NotionGetFn,
  notionPost: NotionPostFn,
): AsyncGenerator<SyncedItem> {
  let startCursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, unknown> = {
      filter: { property: "object", value: "page" },
      page_size: PAGE_SIZE,
    };
    if (startCursor) body.start_cursor = startCursor;

    const response = (await notionPost("/search", token, body)) as {
      results: Array<Record<string, unknown>>;
      has_more: boolean;
      next_cursor: string | null;
    };

    for (const page of response.results) {
      if (page.archived || page.in_trash) continue;

      const lastEdited = page.last_edited_time as string;
      if (since && lastEdited && lastEdited < since) continue;

      const parent = page.parent as { type: string; database_id?: string } | undefined;
      if (parent?.type === "database_id") continue;

      const properties = page.properties as Record<string, { type: string; [key: string]: unknown }>;
      const title = extractPageTitle(properties);
      const pageId = page.id as string;
      const url = page.url as string;

      let content: string;
      try {
        const lines = await extractPageContent(pageId, token, logger, notionGet);
        content = lines.length > 0 ? `${title}\n\n${lines.join("\n\n")}` : title;
      } catch (err) {
        logger.warn({ err, pageId }, "Failed to extract page content");
        content = title;
      }

      yield {
        providerFileId: pageId,
        providerUrl: url ?? null,
        fileName: title || "Untitled",
        fileType: "page",
        contentCategory: "document",
        content,
        sourcePath: null,
        contentHash: contentHash(content),
        sourceCreatedAt: (page.created_time as string) ?? null,
        sourceUpdatedAt: lastEdited ?? null,
      };
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }
}
