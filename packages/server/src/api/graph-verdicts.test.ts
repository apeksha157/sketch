/**
 * The graph-verdicts API is the Your Org review surface's backend: plain
 * admin-gated (no dev-tools flag), and its cross-run listing must return
 * exactly the rows still needing a human — awaiting or approved, never
 * superseded or terminal — because the band renders whatever this returns.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { type StoreGraphVerdictInput, createGraphVerdictRepository } from "../db/repositories/graph-verdicts";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const PASSWORD = "testpassword123";
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";

async function seedUsers(db: Kysely<DB>): Promise<{ adminId: string }> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
  });
  await users.create({
    name: "member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "member",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const admin = await users.findByEmail(ADMIN_EMAIL);
  if (!admin) throw new Error("admin missing");
  return { adminId: admin.id };
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

function verdictInput(overrides: Partial<StoreGraphVerdictInput> & { runId: string }): StoreGraphVerdictInput {
  return {
    action: "merge_into",
    subjectEntityId: "ent-subject",
    subjectName: "Subject",
    subjectEntityType: "company",
    targetEntityId: "ent-target",
    targetName: "Target",
    reason: "test proposal",
    evidenceJson: "{}",
    evidenceFingerprint: "fp",
    validationStatus: "ok",
    validationReason: null,
    wouldChangeJson: null,
    status: "awaiting_human",
    ...overrides,
  };
}

describe("graph-verdicts open listing", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let memberCookie: string;
  let adminId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const seeded = await seedUsers(db);
    adminId = seeded.adminId;
    app = createApp(db, createTestConfig({}), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("stays admin-only: members get 403 with no dev-tools flag involved", async () => {
    const member = await app.request("/api/graph-verdicts?status=awaiting_human,approved", {
      headers: { Cookie: memberCookie },
    });
    expect(member.status).toBe(403);

    const admin = await app.request("/api/graph-verdicts?status=awaiting_human,approved", {
      headers: { Cookie: adminCookie },
    });
    expect(admin.status).toBe(200);
  });

  it("returns awaiting and approved rows only, excluding superseded and decided ones", async () => {
    const verdicts = createGraphVerdictRepository(db);
    const run = await verdicts.createRun({
      source: "test",
      proposedByUserId: adminId,
      tokenId: null,
      note: null,
      verdictsProposed: 4,
    });

    const first = await verdicts.storeVerdicts([
      verdictInput({ runId: run.id, subjectEntityId: "ent-a", subjectName: "Alpha" }),
      verdictInput({ runId: run.id, subjectEntityId: "ent-b", subjectName: "Beta", action: "archive" }),
      verdictInput({ runId: run.id, subjectEntityId: "ent-c", subjectName: "Gamma", action: "archive" }),
    ]);
    const [, betaId, gammaId] = first.ids;
    if (!betaId || !gammaId) throw new Error("seed ids missing");
    await verdicts.markApproved({ id: betaId, actorUserId: adminId });
    await verdicts.markRejected({ id: gammaId, actorUserId: adminId });
    const replacement = await verdicts.storeVerdicts([
      verdictInput({ runId: run.id, subjectEntityId: "ent-a", subjectName: "Alpha (re-proposed)" }),
    ]);

    const res = await app.request("/api/graph-verdicts?status=awaiting_human,approved", {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verdicts: { id: string; status: string; subjectName: string }[] };

    expect(body.verdicts.map((v) => v.id).sort()).toEqual([betaId, replacement.ids[0]].sort());
    const statuses = new Set(body.verdicts.map((v) => v.status));
    expect(statuses).toEqual(new Set(["awaiting_human", "approved"]));
    expect(body.verdicts.some((v) => v.subjectName === "Alpha")).toBe(false);
  });

  it("rejects unsupported status filters instead of silently widening the list", async () => {
    for (const bad of ["", "applied", "awaiting_human,applied"]) {
      const res = await app.request(`/api/graph-verdicts?status=${bad}`, { headers: { Cookie: adminCookie } });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNSUPPORTED_FILTER");
    }
  });
});

describe("graph-verdict evidence resolution", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let memberCookie: string;
  let adminId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const seeded = await seedUsers(db);
    adminId = seeded.adminId;
    app = createApp(db, createTestConfig({}), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedVerdictWithFiles(evidenceJson: string): Promise<string> {
    await db
      .insertInto("entities")
      .values({
        id: "ent-subject",
        name: "Subject",
        source_type: "company",
        subtype: null,
        aliases: null,
        metadata: null,
        source_ref_id: null,
        status: "confirmed",
        hotness: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({ id: "cfg-ev", connector_type: "fireflies", auth_type: "oauth", credentials: "{}", created_by: adminId })
      .execute();
    const now = new Date().toISOString();
    for (const [id, updatedAt] of [
      ["file-old", "2026-08-01T00:00:00.000Z"],
      ["file-new", "2026-08-20T00:00:00.000Z"],
    ] as const) {
      await db
        .insertInto("indexed_files")
        .values({
          id,
          connector_config_id: "cfg-ev",
          provider_file_id: id,
          file_name: `${id}.txt`,
          file_type: "meeting",
          content_category: "meeting",
          source: "fireflies",
          content_hash: `hash-${id}`,
          is_archived: 0,
          synced_at: now,
          source_updated_at: updatedAt,
        })
        .execute();
    }
    await db
      .insertInto("entity_mentions")
      .values({
        id: "mention-ev",
        entity_id: "ent-subject",
        indexed_file_id: "file-new",
        chunk_index: 0,
        context_snippet: "Subject confirmed the rollout in this call",
        confidence: "EXTRACTED",
        source: "llm_extraction",
        relation: "mentioned",
        mentioned_at: now,
      })
      .execute();

    const verdicts = createGraphVerdictRepository(db);
    const run = await verdicts.createRun({
      source: "test",
      proposedByUserId: adminId,
      tokenId: null,
      note: null,
      verdictsProposed: 1,
    });
    const stored = await verdicts.storeVerdicts([verdictInput({ runId: run.id, evidenceJson })]);
    const id = stored.ids[0];
    if (!id) throw new Error("verdict id missing");
    return id;
  }

  it("resolves evidence file ids to names and subject snippets, newest first, null snippet when none", async () => {
    const id = await seedVerdictWithFiles(JSON.stringify({ fileIds: ["file-old", "file-new"], notes: [] }));

    const res = await app.request(`/api/graph-verdicts/${id}/evidence`, { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { fileId: string; fileName: string; contextSnippet: string | null }[];
    };
    expect(body.rows.map((r) => r.fileId)).toEqual(["file-new", "file-old"]);
    expect(body.rows[0]?.fileName).toBe("file-new.txt");
    expect(body.rows[0]?.contextSnippet).toBe("Subject confirmed the rollout in this call");
    expect(body.rows[1]?.contextSnippet).toBeNull();
  });

  it("returns empty rows for evidence without file ids and 404 for unknown verdicts", async () => {
    const id = await seedVerdictWithFiles(JSON.stringify({ samples: ["a task title"] }));

    const res = await app.request(`/api/graph-verdicts/${id}/evidence`, { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rows: unknown[] }).rows).toEqual([]);

    const missing = await app.request("/api/graph-verdicts/nope/evidence", { headers: { Cookie: adminCookie } });
    expect(missing.status).toBe(404);
  });

  it("stays admin-only", async () => {
    const id = await seedVerdictWithFiles(JSON.stringify({ fileIds: ["file-new"] }));
    const res = await app.request(`/api/graph-verdicts/${id}/evidence`, { headers: { Cookie: memberCookie } });
    expect(res.status).toBe(403);
  });
});
