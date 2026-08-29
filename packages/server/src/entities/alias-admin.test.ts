/**
 * Alias admin contract, through the HTTP routes:
 *  - add declares at human_confirmed provenance and lifts a standing rejection
 *  - delete removes every variant sharing the normalized form and records a
 *    rejection so the pipeline cannot re-mint the name
 *  - duplicates are rejected with 409, deleting an absent alias with 404
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { normalizeName } from "./name-keys";

const config = createTestConfig();
const logger = createTestLogger();
const ADMIN_EMAIL = "admin@test.com";
const PASSWORD = "testpassword123";

describe("alias admin", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    const settings = createSettingsRepository(db);
    const users = createUserRepository(db);
    await settings.create();
    await users.create({
      name: "admin",
      email: ADMIN_EMAIL,
      emailVerified: true,
      passwordHash: await hashPassword(PASSWORD),
      authRole: "admin",
      skipEntityLinking: true,
    });
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    app = createApp(db, config, { logger });
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
    });
    adminCookie = res.headers.get("set-cookie") ?? "";
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedEntity(name: string, aliases: string[] | null): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id,
        name,
        source_type: "person",
        status: "confirmed",
        hotness: 0,
        aliases: aliases ? JSON.stringify(aliases) : null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  }

  async function entityAliases(id: string): Promise<string[]> {
    const row = await db.selectFrom("entities").select("aliases").where("id", "=", id).executeTakeFirstOrThrow();
    return row.aliases ? (JSON.parse(row.aliases) as string[]) : [];
  }

  it("declares an alias at human_confirmed provenance and lifts a standing rejection", async () => {
    const entityId = await seedEntity("Sanaa Khalloq", null);
    await db
      .insertInto("entity_alias_rejections")
      .values({
        id: randomUUID(),
        entity_id: entityId,
        rejected_name: "Sana K",
        normalized_rejected_name: normalizeName("Sana K"),
        rejected_by: "someone",
        rejected_at: new Date().toISOString(),
      })
      .execute();

    const res = await app.request(`/api/entities/${entityId}/aliases`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ alias: "Sana K" }),
    });
    expect(res.status).toBe(201);
    expect(await entityAliases(entityId)).toEqual(["Sana K"]);

    const aliasRow = await db
      .selectFrom("entity_aliases")
      .select(["alias", "provenance"])
      .where("entity_id", "=", entityId)
      .executeTakeFirstOrThrow();
    expect(aliasRow).toEqual({ alias: "Sana K", provenance: "human_confirmed" });

    const rejection = await db
      .selectFrom("entity_alias_rejections")
      .select("id")
      .where("entity_id", "=", entityId)
      .executeTakeFirst();
    expect(rejection).toBeUndefined();
  });

  it("removes every variant of the alias and records a rejection", async () => {
    const entityId = await seedEntity("Sanaa Khalloq", ["Sana K", "sana k", "SK Design"]);

    const res = await app.request(`/api/entities/${entityId}/aliases?value=${encodeURIComponent("Sana K")}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: string[]; aliases: string[] };
    expect(body.removed.sort()).toEqual(["Sana K", "sana k"]);
    expect(body.aliases).toEqual(["SK Design"]);
    expect(await entityAliases(entityId)).toEqual(["SK Design"]);

    const rejection = await db
      .selectFrom("entity_alias_rejections")
      .select("normalized_rejected_name")
      .where("entity_id", "=", entityId)
      .executeTakeFirstOrThrow();
    expect(rejection.normalized_rejected_name).toBe(normalizeName("Sana K"));
  });

  it("rejects duplicate adds with 409 and absent deletes with 404", async () => {
    const entityId = await seedEntity("Sanaa Khalloq", ["Sana K"]);

    const dup = await app.request(`/api/entities/${entityId}/aliases`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ alias: "sana k" }),
    });
    expect(dup.status).toBe(409);

    const missing = await app.request(`/api/entities/${entityId}/aliases?value=${encodeURIComponent("Nobody")}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(missing.status).toBe(404);
    expect(await entityAliases(entityId)).toEqual(["Sana K"]);
  });
});
