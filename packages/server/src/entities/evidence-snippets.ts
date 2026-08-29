import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { DB } from "../db/schema";

/**
 * Cut a short quote around the first occurrence of `name` in `content`.
 * Returns null when the name doesn't actually appear — callers may pre-filter
 * with a broader SQL LIKE and rely on this as the exact check.
 */
export function extractSnippet(content: string, name: string, windowChars = 90): string | null {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return null;
  const haystack = content.toLowerCase();
  const idx = haystack.indexOf(needle);
  if (idx === -1) return null;

  let start = Math.max(0, idx - windowChars);
  let end = Math.min(content.length, idx + needle.length + windowChars);
  if (start > 0) {
    const boundary = content.indexOf(" ", start);
    if (boundary !== -1 && boundary < idx) start = boundary + 1;
  }
  if (end < content.length) {
    const boundary = content.lastIndexOf(" ", end);
    if (boundary > idx + needle.length) end = boundary;
  }

  const body = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < content.length ? "…" : ""}`;
}

/**
 * Read-time snippets for review-queue evidence: for each file, the first
 * chunk that mentions the proposed name, cut to a quote. One query for the
 * whole evidence list; the LIKE is a broad pre-filter (wildcards in the name
 * are not escaped) and {@link extractSnippet} is the exact check.
 */
export async function snippetsForFiles(db: Kysely<DB>, fileIds: string[], name: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const needle = name.trim().toLowerCase();
  if (fileIds.length === 0 || needle.length === 0) return out;

  const rows = await db
    .selectFrom("document_chunks")
    .select(["indexed_file_id", "chunk_index", "content"])
    .where("indexed_file_id", "in", fileIds)
    .where(sql`lower(content)`, "like", `%${needle}%`)
    .orderBy("indexed_file_id")
    .orderBy("chunk_index")
    .limit(200)
    .execute();

  for (const row of rows) {
    if (out.has(row.indexed_file_id)) continue;
    const snippet = extractSnippet(row.content, name);
    if (snippet) out.set(row.indexed_file_id, snippet);
  }
  return out;
}
