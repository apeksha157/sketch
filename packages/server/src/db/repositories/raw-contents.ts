import type { Kysely } from "kysely";
import type { DB } from "../schema";

export interface UpsertRawContentInput {
  indexedFileId: string;
  kind: "transcript";
  content: string;
}

/**
 * Retrieval-only raw payloads (full transcripts etc.). Deliberately separate
 * from indexed_files.content: rows here never feed content_hash, chunking,
 * embeddings, or enrichment. char_length stores JS string length (UTF-16 code
 * units) — the same metric the retrieval handler pages by.
 */
export function createRawContentRepository(db: Kysely<DB>) {
  return {
    async upsertRawContent(input: UpsertRawContentInput): Promise<void> {
      const now = new Date().toISOString();
      await db
        .insertInto("indexed_file_raw_contents")
        .values({
          indexed_file_id: input.indexedFileId,
          kind: input.kind,
          content: input.content,
          char_length: input.content.length,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["indexed_file_id", "kind"]).doUpdateSet({
            content: input.content,
            char_length: input.content.length,
            updated_at: now,
          }),
        )
        .execute();
    },

    async getRawContent(indexedFileId: string, kind: "transcript"): Promise<{ content: string } | undefined> {
      return db
        .selectFrom("indexed_file_raw_contents")
        .select(["content"])
        .where("indexed_file_id", "=", indexedFileId)
        .where("kind", "=", kind)
        .executeTakeFirst();
    },
  };
}
