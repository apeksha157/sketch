import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { buildSyncLanes, seedTeamDirectoryEntities } from "./sync";
import { runWithConcurrency } from "./sync-utils";

describe("seedTeamDirectoryEntities", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("does not seed external app users and promotes internal roster matches", async () => {
    await db
      .insertInto("users")
      .values([
        {
          id: "external-user",
          name: "External User",
          email: "external@outside.example",
          type: "external",
        },
        {
          id: "internal-user",
          name: "Internal User",
          email: "internal@example.com",
          type: "human",
        },
      ])
      .execute();
    await db
      .insertInto("entities")
      .values({
        id: "existing-internal-user",
        name: "Existing Internal User",
        source_type: "person",
        subtype: null,
        aliases: JSON.stringify(["internal@example.com"]),
        metadata: JSON.stringify({ email: "internal@example.com" }),
        source_ref_id: null,
        status: "confirmed",
        provenance_tier: "inferred",
        hotness: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    await createEntityDomainsRepository(db).upsertDomain({
      entityId: "existing-internal-user",
      domain: "example.com",
      kind: "corporate",
      source: "test",
    });

    await seedTeamDirectoryEntities(db, createTestLogger());

    await expect(
      db.selectFrom("entities").select("id").where("name", "=", "External User").execute(),
    ).resolves.toHaveLength(0);
    await expect(
      db.selectFrom("entities").select("subtype").where("id", "=", "existing-internal-user").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ subtype: "internal" });
  });
});

describe("buildSyncLanes", () => {
  it("collapses Microsoft connectors into one lane, preserving order, and keeps others singleton", () => {
    const lanes = buildSyncLanes([
      { connector_type: "outlook", id: "o" },
      { connector_type: "zoho_crm", id: "z" },
      { connector_type: "outlook_calendar", id: "c" },
      { connector_type: "gmail", id: "g" },
      { connector_type: "teams", id: "t" },
    ]);

    expect(lanes).toEqual([
      [{ connector_type: "zoho_crm", id: "z" }],
      [{ connector_type: "gmail", id: "g" }],
      [
        { connector_type: "outlook", id: "o" },
        { connector_type: "outlook_calendar", id: "c" },
        { connector_type: "teams", id: "t" },
      ],
    ]);
  });

  it("emits no empty Microsoft lane when no Microsoft connectors are present", () => {
    expect(buildSyncLanes([{ connector_type: "slack", id: "s" }])).toEqual([[{ connector_type: "slack", id: "s" }]]);
    expect(buildSyncLanes([])).toEqual([]);
  });

  it("never overlaps Microsoft syncs under runWithConcurrency while others run alongside", async () => {
    const configs = [
      { connector_type: "outlook", id: "o" },
      { connector_type: "zoho_crm", id: "z" },
      { connector_type: "outlook_calendar", id: "c" },
      { connector_type: "teams", id: "t" },
    ];
    let microsoftActive = 0;
    let maxMicrosoftActive = 0;
    let totalActive = 0;
    let maxTotalActive = 0;

    await runWithConcurrency(buildSyncLanes(configs), 4, async (lane) => {
      for (const config of lane) {
        const isMicrosoft = config.connector_type !== "zoho_crm";
        totalActive += 1;
        maxTotalActive = Math.max(maxTotalActive, totalActive);
        if (isMicrosoft) {
          microsoftActive += 1;
          maxMicrosoftActive = Math.max(maxMicrosoftActive, microsoftActive);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (isMicrosoft) microsoftActive -= 1;
        totalActive -= 1;
      }
    });

    expect(maxMicrosoftActive).toBe(1);
    expect(maxTotalActive).toBeGreaterThan(1);
  });
});
