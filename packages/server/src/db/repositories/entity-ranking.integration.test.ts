import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, getSharedPgDb, spyOnExecutedSql } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityRepository } from "./entities";

describe("searchEntities ranking dialect parity", () => {
  let postgres!: Kysely<DB>;
  let sqlite!: Kysely<DB>;

  beforeAll(async () => {
    postgres = await getSharedPgDb();
  }, 30_000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(postgres);
    sqlite = await createTestDb();
  });

  afterEach(async () => {
    await sqlite.destroy();
    await sql`ROLLBACK`.execute(postgres);
  });

  it("ranks exact, prefix, substring, and recency matches identically", async () => {
    const actual: Record<string, { relevance: string[]; recency: string[] }> = {};

    for (const [dialect, db] of databases(sqlite, postgres)) {
      await seedCapRanking(db);
      const repo = createEntityRepository(db);

      actual[dialect] = {
        relevance: (await repo.searchEntities("  CAPMOB  ", { limit: 50 })).map((row) => row.id),
        recency: (await repo.searchEntities("capmob", { limit: 50, sortBy: "recency" })).map((row) => row.id),
      };
    }

    expect(actual.sqlite.relevance).toEqual(["rank-exact", "rank-prefix", "rank-substring-hot", "rank-substring-cold"]);
    expect(actual.sqlite.recency[0]).toBe("rank-substring-cold");
    expect(actual.postgres).toEqual(actual.sqlite);
  });

  it("puts an exact JSON alias above a hotter prefix-name match", async () => {
    const actual: Record<string, string[]> = {};

    for (const [dialect, db] of databases(sqlite, postgres)) {
      await insertEntities(db, [
        entity("alias-exact", "Zeta Holdings", 0, ["AliasNeedle"]),
        entity("alias-prefix", "Aliasneedle Project", 100),
      ]);

      actual[dialect] = (await createEntityRepository(db).searchEntities("aliasneedle")).map((row) => row.id);
    }

    expect(actual.sqlite).toEqual(["alias-exact", "alias-prefix"]);
    expect(actual.postgres).toEqual(actual.sqlite);
  });

  it("does not tokenize email-shaped input", async () => {
    const actual: Record<string, string[]> = {};

    for (const [dialect, db] of databases(sqlite, postgres)) {
      await insertEntities(db, [
        entity("email-ranjith", "Ranjith", 0, ["ranjith@capmobfinance.com"]),
        entity("email-shreeja", "Shreeja", 100, ["shreeja@capmobfinance.com"]),
      ]);

      actual[dialect] = (await createEntityRepository(db).searchEntities("ranjith@capmobfinance.com")).map(
        (row) => row.id,
      );
    }

    expect(actual.sqlite).toEqual(["email-ranjith"]);
    expect(actual.postgres).toEqual(actual.sqlite);
  });

  it("treats LIKE wildcards and the escape character literally", async () => {
    const actual: Record<string, { percent: string[]; underscore: string[]; hash: string[]; literalAlias: string[] }> =
      {};

    for (const [dialect, db] of databases(sqlite, postgres)) {
      const repo = createEntityRepository(db);
      const percent = (await repo.searchEntities("%")).map((row) => row.id);
      const underscore = (await repo.searchEntities("_")).map((row) => row.id);
      await insertEntities(db, [
        entity("literal-percent", "Percent Holder", 0, ["Margin %"]),
        entity("literal-hash", "Series #", 0),
      ]);
      const literalAlias = (await repo.searchEntities("Margin %")).map((row) => row.id);
      const hash = (await repo.searchEntities("Series #")).map((row) => row.id);
      actual[dialect] = { percent, underscore, hash, literalAlias };
    }

    expect(actual.sqlite).toEqual({
      percent: [],
      underscore: [],
      hash: ["literal-hash"],
      literalAlias: ["literal-percent"],
    });
    expect(actual.postgres).toEqual(actual.sqlite);
  });

  it("uses filtered, thresholded tokens only for explicitly enabled relevance fallback", async () => {
    const actual: Record<
      string,
      {
        defaultWholeString: string[];
        fallback: string[];
        ordinaryFilePhrase: string[];
        sportsPhrase: string[];
        recency: string[];
        exact: string[];
        exactQueryCount: number;
        emptyQueryCount: number;
      }
    > = {};

    for (const [dialect, db] of databases(sqlite, postgres)) {
      await insertEntities(db, [
        entity("tokens-capmobfinance", "Capmobfinance", 20),
        entity("tokens-financial-services", "Capmob Financial Services", 10),
        entity("tokens-bizloan", "Bizloan Finance", 100),
        entity("tokens-exact", "Alpha Beta", 0),
        entity("tokens-decoy", "Beta Consulting", 100),
        entity("tokens-meeting", "Meeting Minds Experts", 100),
        entity("tokens-automation", "Workflow Automation", 100),
        entity("tokens-sportsfever", "SportsFever360", 30),
        entity("tokens-gulf-sports", "Gulf Sports Media FZ LLC", 20, ["Sports 360 Gulf"]),
        entity("tokens-sport360", "Sport360", 10, ["Sports 360"]),
        entity("tokens-360-comms", "360 Comms", 100),
        entity("tokens-360-auto", "360 Auto", 100),
        entity("tokens-ships", "Shipping Contact", 100, ["ships-360.com"]),
      ]);
      const repo = createEntityRepository(db);
      const defaultWholeString = (await repo.searchEntities("Capmob finance")).map((row) => row.id);
      const fallback = (await repo.searchEntities("Capmob finance", { tokenFallback: true })).map((row) => row.id);
      const ordinaryFilePhrase = (
        await repo.searchEntities("onboarding meeting automation", { tokenFallback: true })
      ).map((row) => row.id);
      const sportsPhrase = (
        await repo.searchEntities("Sports 360 facilitation agreement", { tokenFallback: true })
      ).map((row) => row.id);
      const recency = (await repo.searchEntities("Capmob finance", { sortBy: "recency", tokenFallback: true })).map(
        (row) => row.id,
      );
      const sqlSpy = spyOnExecutedSql(db);
      try {
        const exact = (await repo.searchEntities("Alpha Beta", { tokenFallback: true })).map((row) => row.id);
        const exactQueryCount = sqlSpy.count;
        const beforeEmpty = sqlSpy.count;
        await repo.searchEntities("   ", { tokenFallback: true });
        actual[dialect] = {
          defaultWholeString,
          fallback,
          ordinaryFilePhrase,
          sportsPhrase,
          recency,
          exact,
          exactQueryCount,
          emptyQueryCount: sqlSpy.count - beforeEmpty,
        };
      } finally {
        sqlSpy.mockRestore();
      }
    }

    expect(actual.sqlite.defaultWholeString).toEqual([]);
    expect(actual.sqlite.fallback).toEqual(["tokens-capmobfinance", "tokens-financial-services"]);
    expect(actual.sqlite.ordinaryFilePhrase).toEqual([]);
    expect(actual.sqlite.sportsPhrase).toEqual(["tokens-sportsfever", "tokens-gulf-sports", "tokens-sport360"]);
    expect(actual.sqlite.recency).toEqual([]);
    expect(actual.sqlite.exact).toEqual(["tokens-exact"]);
    expect(actual.sqlite.exactQueryCount).toBe(1);
    expect(actual.sqlite.emptyQueryCount).toBe(0);
    expect(actual.postgres).toEqual(actual.sqlite);
  });

  it("orders case-varied names identically after tier and hotness ties", async () => {
    const actual: Record<string, string[]> = {};

    for (const [dialect, db] of databases(sqlite, postgres)) {
      await insertEntities(db, [entity("case-zeta", "Zeta match", 10), entity("case-apple", "apple match", 10)]);
      actual[dialect] = (await createEntityRepository(db).searchEntities("match")).map((row) => row.id);
    }

    expect(actual.sqlite).toEqual(["case-apple", "case-zeta"]);
    expect(actual.postgres).toEqual(actual.sqlite);
  });
});

function databases(sqlite: Kysely<DB>, postgres: Kysely<DB>) {
  return [
    ["sqlite", sqlite],
    ["postgres", postgres],
  ] as const;
}

function entity(id: string, name: string, hotness: number, aliases?: string[]) {
  const now = "2026-09-06T00:00:00.000Z";
  return {
    id,
    name,
    source_type: "company",
    aliases: aliases ? JSON.stringify(aliases) : null,
    status: "confirmed" as const,
    hotness,
    created_at: now,
    updated_at: now,
  };
}

async function insertEntities(db: Kysely<DB>, rows: ReturnType<typeof entity>[]) {
  await db.insertInto("entities").values(rows).execute();
}

async function seedCapRanking(db: Kysely<DB>) {
  const filler = Array.from({ length: 46 }, (_, index) =>
    entity(`rank-filler-${index}`, `Capital Record ${index.toString().padStart(2, "0")}`, index),
  );
  await insertEntities(db, [
    entity("rank-exact", "Capmob", 0),
    entity("rank-prefix", "Capmob Ventures", 1),
    entity("rank-substring-hot", "People at Capmob", 100),
    entity("rank-substring-cold", "Notes on Capmob", 10),
    ...filler,
  ]);

  const now = "2026-09-06T00:00:00.000Z";
  await db
    .insertInto("connector_configs")
    .values({
      id: "ranking-config",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "ranking-test",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values([
      indexedFile("ranking-old-file", "2026-09-01T00:00:00.000Z", now),
      indexedFile("ranking-new-file", "2026-09-05T00:00:00.000Z", now),
    ])
    .execute();
  await db
    .insertInto("entity_mentions")
    .values([
      mention("ranking-old-mention", "rank-exact", "ranking-old-file", "2026-09-01T00:00:00.000Z"),
      mention("ranking-new-mention", "rank-substring-cold", "ranking-new-file", "2026-09-05T00:00:00.000Z"),
    ])
    .execute();
}

function indexedFile(id: string, sourceUpdatedAt: string, syncedAt: string) {
  return {
    id,
    connector_config_id: "ranking-config",
    provider_file_id: id,
    file_name: id,
    file_type: "doc",
    content_category: "document",
    source: "google_drive",
    source_updated_at: sourceUpdatedAt,
    synced_at: syncedAt,
  };
}

function mention(id: string, entityId: string, indexedFileId: string, mentionedAt: string) {
  return {
    id,
    entity_id: entityId,
    indexed_file_id: indexedFileId,
    chunk_index: null,
    context_snippet: null,
    confidence: "EXTRACTED" as const,
    source: "test",
    relation: "mentioned" as const,
    mentioned_at: mentionedAt,
  };
}
