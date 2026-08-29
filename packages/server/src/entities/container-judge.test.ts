import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeminiGenerator } from "../connectors/gemini-generate";
import { createGraphVerdictRepository } from "../db/repositories/graph-verdicts";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { judgeUnclassifiedContainers } from "./container-judge";
import { containerVerdictFingerprint } from "./verdict-fingerprint";

const USER_ID = "container-judge-user";
const CONNECTOR_ID = "container-judge-connector";
const NOW = "2026-08-22T00:00:00.000Z";

type TestLogger = Pick<Logger, "warn" | "info"> & {
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
};

function testLogger(): TestLogger {
  return {
    warn: vi.fn(),
    info: vi.fn(),
  } as TestLogger;
}

function generatorFor(raw: unknown, prompts: string[] = []): GeminiGenerator {
  return {
    async generate() {
      return JSON.stringify(raw);
    },
    async generateJSON<T>(prompt: string) {
      prompts.push(prompt);
      return raw as T;
    },
  };
}

function throwingGenerator(prompts: string[] = []): GeminiGenerator {
  return {
    async generate() {
      throw new Error("judge boom");
    },
    async generateJSON<T>(prompt: string) {
      prompts.push(prompt);
      throw new Error("judge boom");
    },
  };
}

async function seedUser(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: USER_ID, name: "Container Judge User" }).execute();
}

async function seedConnector(db: Kysely<DB>, scopeConfig: Record<string, unknown> = {}): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "clickup",
      auth_type: "api_key",
      credentials: "{}",
      scope_config: JSON.stringify(scopeConfig),
      created_by: USER_ID,
    })
    .execute();
}

async function seedContainer(
  db: Kysely<DB>,
  input: {
    id: string;
    externalId?: string;
    name: string;
    levelKey?: string;
    parentContainerId?: string | null;
    pathNames?: string[];
    classification?: string | null;
    classificationStatus?: string | null;
    verdictId?: string | null;
    itemCount?: number;
    firstItemAt?: string | null;
    lastItemAt?: string | null;
  },
): Promise<void> {
  await db
    .insertInto("containers")
    .values({
      id: input.id,
      connector_config_id: CONNECTOR_ID,
      connector_type: "clickup",
      external_id: input.externalId ?? input.id,
      level_key: input.levelKey ?? "folder",
      name: input.name,
      path_ids: JSON.stringify([]),
      path_names: JSON.stringify(input.pathNames ?? ["Workspace", "Space"]),
      parent_container_id: input.parentContainerId === undefined ? "space-parent" : input.parentContainerId,
      item_count: input.itemCount ?? 0,
      first_item_at: input.firstItemAt ?? null,
      last_item_at: input.lastItemAt ?? null,
      classification: input.classification ?? null,
      classification_status: input.classificationStatus ?? null,
      verdict_id: input.verdictId ?? null,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

async function seedIndexedFile(
  db: Kysely<DB>,
  input: {
    id: string;
    providerFileId: string;
    fileName: string;
    sourcePath?: string | null;
    sourceMeta?: Record<string, unknown> | null;
    sourceUpdatedAt?: string | null;
  },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: input.id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: input.providerFileId,
      file_name: input.fileName,
      content_category: "structured",
      source: "clickup",
      source_path: input.sourcePath ?? null,
      source_meta: input.sourceMeta === undefined ? null : JSON.stringify(input.sourceMeta),
      source_updated_at: input.sourceUpdatedAt ?? null,
      synced_at: NOW,
    })
    .execute();
}

async function seedVerdict(
  db: Kysely<DB>,
  input: { id: string; containerId: string; status: "awaiting_human" | "approved" | "applied" | "rejected" },
): Promise<void> {
  await db
    .insertInto("graph_verdict_runs")
    .values({
      id: `${input.id}-run`,
      source: "test",
      proposed_by_user_id: USER_ID,
      token_id: null,
      note: null,
      verdicts_proposed: 1,
      verdicts_stored: 1,
      verdicts_bounced: 0,
    })
    .execute();
  await db
    .insertInto("graph_verdicts")
    .values({
      id: input.id,
      run_id: `${input.id}-run`,
      action: "classify_container",
      subject_entity_id: null,
      subject_container_id: input.containerId,
      subject_name: input.containerId,
      subject_entity_type: "container_classification",
      target_entity_id: null,
      resolved_target_entity_id: null,
      target_name: null,
      reason: "Seeded verdict.",
      evidence_json: "{}",
      evidence_fingerprint: "seeded-fingerprint",
      validation_status: "ok",
      validation_reason: null,
      would_change_json: null,
      status: input.status,
      superseded_at: null,
      decided_at: input.status === "awaiting_human" ? null : NOW,
      decided_by_user_id: input.status === "awaiting_human" ? null : USER_ID,
      applied_ledger_ref: input.status === "applied" ? "label:team" : null,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

describe("judgeUnclassifiedContainers", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("selects only unsettled containers and prompts with path, prior, sibling, and sample context", async () => {
    await seedConnector(db, { hierarchyMapping: { levels: { folder: "project" } } });
    await seedContainer(db, {
      id: "space-parent",
      name: "Space",
      levelKey: "space",
      parentContainerId: null,
      pathNames: ["Workspace"],
      classification: "project",
      classificationStatus: "active",
    });
    await seedContainer(db, {
      id: "settled-folder",
      name: "Settled Folder",
      classification: "ignore",
      classificationStatus: "active",
    });
    await seedContainer(db, { id: "human-folder", name: "Human Folder" });
    await seedContainer(db, { id: "pending-folder", name: "Pending Folder" });
    await seedContainer(db, {
      id: "labeled-folder",
      name: "Already Labeled",
      classification: "project",
      classificationStatus: "active",
    });
    await seedContainer(db, {
      id: "plain-folder",
      externalId: "plain-ext",
      name: "Plain Folder",
      itemCount: 2,
      firstItemAt: "2026-08-01T00:00:00.000Z",
      lastItemAt: "2026-08-20T00:00:00.000Z",
    });
    await seedContainer(db, { id: "sibling-folder", externalId: "sibling-ext", name: "Sibling Plain" });
    await seedVerdict(db, { id: "human-verdict", containerId: "human-folder", status: "applied" });
    await db.updateTable("containers").set({ verdict_id: "human-verdict" }).where("id", "=", "human-folder").execute();
    await seedVerdict(db, { id: "pending-verdict", containerId: "pending-folder", status: "awaiting_human" });
    await seedIndexedFile(db, {
      id: "plain-sample-1",
      providerFileId: "task-1",
      fileName: "Launch checklist",
      sourcePath: "Workspace / Space / Plain Folder / List A",
      sourceMeta: { folderId: "plain-ext" },
      sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
    });
    await seedIndexedFile(db, {
      id: "sibling-sample-1",
      providerFileId: "task-2",
      fileName: "Fallback path sample",
      sourcePath: "Workspace / Space / Sibling Plain / List B",
      sourceMeta: null,
      sourceUpdatedAt: "2026-08-11T00:00:00.000Z",
    });
    const prompts: string[] = [];

    const result = await judgeUnclassifiedContainers(
      { db, logger: testLogger(), generator: generatorFor({ verdicts: [] }, prompts) },
      CONNECTOR_ID,
    );

    expect(result).toMatchObject({ groupsJudged: 1, containersPrompted: 2, verdictsAccepted: 0 });
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("containerId: plain-folder");
    expect(prompt).toContain("containerId: sibling-folder");
    expect(prompt).not.toContain("containerId: settled-folder");
    expect(prompt).not.toContain("containerId: human-folder");
    expect(prompt).not.toContain("containerId: pending-folder");
    expect(prompt).not.toContain("containerId: labeled-folder");
    expect(prompt).toContain("name: Plain Folder");
    expect(prompt).toContain("path: Workspace > Space > Plain Folder");
    expect(prompt).toContain("levelPrior: project");
    expect(prompt).toContain("itemStats: count=2");
    expect(prompt).toContain("siblings: Already Labeled, Human Folder, Pending Folder, Settled Folder, Sibling Plain");
    expect(prompt).toContain("Launch checklist");
    expect(prompt).toContain("Fallback path sample");
  });

  it("stores awaiting human verdicts with fingerprint and evidence without duplicating on a second run", async () => {
    await seedConnector(db, { hierarchyMapping: { levels: { folder: "project" } } });
    await seedContainer(db, {
      id: "space-parent",
      name: "Space",
      levelKey: "space",
      parentContainerId: null,
      pathNames: ["Workspace"],
      classification: "project",
      classificationStatus: "active",
    });
    await seedContainer(db, {
      id: "judge-folder",
      externalId: "judge-ext",
      name: "Growth Team",
      itemCount: 4,
    });
    await seedIndexedFile(db, {
      id: "judge-sample",
      providerFileId: "task-judge",
      fileName: "Growth weekly planning",
      sourcePath: "Workspace / Space / Growth Team / Backlog",
      sourceMeta: { folderId: "judge-ext" },
    });
    const generator = generatorFor({
      verdicts: [
        {
          containerId: "judge-folder",
          classification: "team",
          entityStatus: "active",
          reason: "The folder represents an ongoing team backlog.",
        },
      ],
    });

    const first = await judgeUnclassifiedContainers({ db, logger: testLogger(), generator }, CONNECTOR_ID);

    expect(first).toMatchObject({ verdictsAccepted: 1, verdictsStored: 1, verdictsBounced: 0 });
    const rows = await db.selectFrom("graph_verdicts").selectAll().execute();
    expect(rows).toHaveLength(1);
    const verdict = rows[0];
    const container = await db
      .selectFrom("containers")
      .selectAll()
      .where("id", "=", "judge-folder")
      .executeTakeFirstOrThrow();
    expect(verdict).toMatchObject({
      action: "classify_container",
      subject_container_id: "judge-folder",
      subject_name: "Growth Team",
      subject_entity_type: "container_classification",
      reason: "The folder represents an ongoing team backlog.",
      validation_status: "ok",
      status: "awaiting_human",
    });
    expect(verdict?.evidence_fingerprint).toBe(
      containerVerdictFingerprint({ action: "classify_container", container }),
    );
    expect(JSON.parse(verdict?.evidence_json ?? "{}")).toEqual({
      classification: "team",
      entityStatus: "active",
      samples: ["Growth weekly planning"],
    });

    const second = await judgeUnclassifiedContainers({ db, logger: testLogger(), generator }, CONNECTOR_ID);

    expect(second).toMatchObject({ containersPrompted: 0, verdictsStored: 0 });
    await expect(db.selectFrom("graph_verdicts").selectAll().execute()).resolves.toHaveLength(1);
    const runRows = await createGraphVerdictRepository(db).listRunsWithRollups();
    expect(runRows).toHaveLength(1);
  });

  it("drops invalid and malformed model output and contains judge failures", async () => {
    await seedConnector(db, { hierarchyMapping: { levels: { folder: "project" } } });
    await seedContainer(db, {
      id: "space-parent",
      name: "Space",
      levelKey: "space",
      parentContainerId: null,
      pathNames: ["Workspace"],
      classification: "project",
      classificationStatus: "active",
    });
    await seedContainer(db, { id: "invalid-class", name: "Invalid Class" });
    await seedContainer(db, { id: "invalid-status", name: "Invalid Status" });
    const logger = testLogger();

    const invalid = await judgeUnclassifiedContainers(
      {
        db,
        logger,
        generator: generatorFor({
          verdicts: [
            { containerId: "unknown-container", classification: "team", entityStatus: "active", reason: "Unknown." },
            { containerId: "invalid-class", classification: "program", entityStatus: "active", reason: "Bad class." },
            { containerId: "invalid-status", classification: "team", entityStatus: "pending", reason: "Bad status." },
          ],
        }),
      },
      CONNECTOR_ID,
    );

    expect(invalid).toMatchObject({ verdictsAccepted: 0, verdictsStored: 0 });
    await expect(db.selectFrom("graph_verdicts").selectAll().execute()).resolves.toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: "unknown-container", reason: "unknown_container" }),
      "Dropped container judge verdict",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "Invalid Class", reason: "invalid_classification" }),
      "Dropped container judge verdict",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "Invalid Status", reason: "invalid_entity_status" }),
      "Dropped container judge verdict",
    );

    const malformed = await judgeUnclassifiedContainers(
      { db, logger, generator: generatorFor("not-json") },
      CONNECTOR_ID,
    );

    expect(malformed).toMatchObject({ verdictsAccepted: 0, verdictsStored: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ containerCount: 2, reason: "malformed_output" }),
      "Dropped container judge output",
    );

    await expect(
      judgeUnclassifiedContainers({ db, logger, generator: throwingGenerator() }, CONNECTOR_ID),
    ).resolves.toMatchObject({ groupsFailed: 1, verdictsStored: 0 });
    await expect(db.selectFrom("graph_verdicts").selectAll().execute()).resolves.toHaveLength(0);
  });
});
