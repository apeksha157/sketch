import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import type { DB } from "../db/schema";
import { materializeUnmaterializedFacts } from "../entities/materialize";
import { createTestDb, createTestLogger } from "../test-utils";
import { runConnectorSync } from "./sync";
import { serializeCredentials } from "./sync-utils";
import type { ConnectorType } from "./types";

const USER_ID = "container-activation-user";

interface ClickUpFixture {
  team: { id: string; name: string; members: Array<{ user: { id: number; username: string; email?: string } }> };
  spaces: Array<{ id: string; name: string; private?: boolean; features?: { sprints?: { enabled?: boolean } } }>;
  foldersBySpace: Record<string, Array<{ id: string; name: string }>>;
  listsByFolder: Record<
    string,
    Array<{ id: string; name: string; task_count?: number; start_date?: string; due_date?: string }>
  >;
  folderlessListsBySpace: Record<
    string,
    Array<{ id: string; name: string; task_count?: number; start_date?: string; due_date?: string }>
  >;
  tasksByList: Record<string, unknown[]>;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

function graphqlResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

function clickupTask(input: {
  id: string;
  name: string;
  list: { id: string; name: string };
  spaceId: string;
  folder?: { id: string; name: string };
}) {
  return {
    id: input.id,
    name: input.name,
    description: "",
    status: { status: "open", type: "open" },
    priority: null,
    creator: { id: "creator-1", username: "Owner", email: "owner@example.com" },
    assignees: [],
    tags: [],
    date_created: "1780000000000",
    date_updated: "1780000001000",
    url: `https://app.clickup.com/t/${input.id}`,
    parent: null,
    list: input.list,
    folder: input.folder,
    space: { id: input.spaceId },
    custom_fields: [],
  };
}

function mockClickUpFetch(fixture: ClickUpFixture): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;

    if (path === "/api/v2/team") return jsonResponse({ teams: [fixture.team] });
    if (path === `/api/v2/team/${fixture.team.id}/space`) return jsonResponse({ spaces: fixture.spaces });
    if (path === `/api/v3/workspaces/${fixture.team.id}/docs`) return jsonResponse({ docs: [] });

    for (const space of fixture.spaces) {
      if (path === `/api/v2/space/${space.id}/folder`) {
        return jsonResponse({ folders: fixture.foldersBySpace[space.id] ?? [] });
      }
      if (path === `/api/v2/space/${space.id}/list`) {
        return jsonResponse({ lists: fixture.folderlessListsBySpace[space.id] ?? [] });
      }
    }

    for (const [folderId, lists] of Object.entries(fixture.listsByFolder)) {
      if (path === `/api/v2/folder/${folderId}/list`) return jsonResponse({ lists });
    }

    for (const [listId, tasks] of Object.entries(fixture.tasksByList)) {
      if (path === `/api/v2/list/${listId}/task`) return jsonResponse({ tasks, last_page: true });
    }

    return new Response(JSON.stringify({ error: `unexpected path ${path}` }), { status: 404 });
  });
}

async function seedUser(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Container Activation User",
      email: "container-activation@example.com",
      email_verified_at: now,
      password_hash: "hash",
      auth_role: "admin",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}

async function seedConnector(db: Kysely<DB>, connectorType: ConnectorType, scopeConfig: Record<string, unknown>) {
  await seedUser(db);
  return createConnectorRepository(db).createConfig({
    connectorType,
    authType: "api_key",
    credentials: serializeCredentials({ type: "api_key", api_key: `${connectorType}-token` }),
    scopeConfig: JSON.stringify(scopeConfig),
    createdBy: USER_ID,
    syncStatus: "active",
  });
}

async function seedClassifiedContainer(
  db: Kysely<DB>,
  input: {
    connectorConfigId: string;
    connectorType: ConnectorType;
    externalId: string;
    levelKey: string;
    name: string;
    classification: "team" | "project" | "time_box" | "account" | "ignore";
    classificationStatus?: string;
  },
): Promise<void> {
  await db
    .insertInto("containers")
    .values({
      id: `${input.connectorConfigId}-${input.externalId}`,
      connector_config_id: input.connectorConfigId,
      connector_type: input.connectorType,
      external_id: input.externalId,
      level_key: input.levelKey,
      name: input.name,
      path_ids: "[]",
      path_names: "[]",
      classification: input.classification,
      classification_status: input.classificationStatus ?? "accepted",
    })
    .execute();
}

async function runSync(db: Kysely<DB>, connectorConfigId: string, mode: "shadow" | "active"): Promise<void> {
  await runConnectorSync(
    db,
    connectorConfigId,
    createTestLogger(),
    { CONTAINER_CLASSIFICATION_MODE: mode },
    { postSyncMode: "deferred" },
  );
  await materializeUnmaterializedFacts(db, createTestLogger());
}

async function clickupStructuralSnapshot(db: Kysely<DB>) {
  const refs = await db
    .selectFrom("entity_source_refs")
    .innerJoin("entities", "entities.id", "entity_source_refs.entity_id")
    .select(["entity_source_refs.source_id", "entities.source_type"])
    .where("entity_source_refs.source", "=", "clickup")
    .orderBy("entity_source_refs.source_id", "asc")
    .execute();
  const tasks = await db
    .selectFrom("tasks")
    .leftJoin("entity_source_refs", "entity_source_refs.entity_id", "tasks.parent_entity_id")
    .select(["tasks.source_task_id", "tasks.parent_entity_id", "entity_source_refs.source_id as parent_source_id"])
    .orderBy("tasks.source_task_id", "asc")
    .execute();
  return { refs, tasks };
}

describe("ClickUp container classification activation", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("falls back to stored level mapping for unclassified containers in active mode", async () => {
    const folder = { id: "folder-fallback", name: "Fallback Project" };
    const list = { id: "list-fallback", name: "Delivery Tasks" };
    const fixture: ClickUpFixture = {
      team: { id: "workspace-fallback", name: "Fallback Workspace", members: [] },
      spaces: [{ id: "space-fallback", name: "Delivery" }],
      foldersBySpace: { "space-fallback": [folder] },
      listsByFolder: { "folder-fallback": [list] },
      folderlessListsBySpace: { "space-fallback": [] },
      tasksByList: {
        "list-fallback": [
          clickupTask({ id: "task-fallback", name: "Keep parent", list, spaceId: "space-fallback", folder }),
        ],
      },
    };
    const scopeConfig = { hierarchyMapping: { levels: { folder: "project", list: "ignore" } } };

    mockClickUpFetch(fixture);
    const shadowConnector = await seedConnector(db, "clickup", scopeConfig);
    await runSync(db, shadowConnector.id, "shadow");
    const shadow = await clickupStructuralSnapshot(db);

    vi.restoreAllMocks();
    await db.destroy();
    db = await createTestDb();
    mockClickUpFetch(fixture);
    const activeConnector = await seedConnector(db, "clickup", scopeConfig);
    await runSync(db, activeConnector.id, "active");
    const active = await clickupStructuralSnapshot(db);

    expect(active.refs).toEqual(shadow.refs);
    expect(
      active.tasks.map((task) => ({ sourceTaskId: task.source_task_id, parentSourceId: task.parent_source_id })),
    ).toEqual(
      shadow.tasks.map((task) => ({ sourceTaskId: task.source_task_id, parentSourceId: task.parent_source_id })),
    );
    const folderRef = active.refs.find((ref) => ref.source_id === "folder-fallback");
    const fallbackTask = active.tasks.find((task) => task.source_task_id === "task-fallback");
    expect(folderRef?.source_type).toBe("project");
    expect(fallbackTask?.parent_entity_id).toBeTruthy();
    expect(fallbackTask?.parent_source_id).toBe("folder-fallback");
  });

  it("applies team/project/ignore classifications and skips Linear ignored project seeding", async () => {
    const teamFolder = { id: "folder-team", name: "Support Team" };
    const projectFolder = { id: "folder-project", name: "Client Launch" };
    const teamList = { id: "list-team", name: "Team Work" };
    const projectList = { id: "list-project", name: "Project Work" };
    mockClickUpFetch({
      team: { id: "workspace-active", name: "Active Workspace", members: [] },
      spaces: [{ id: "space-active", name: "Delivery" }],
      foldersBySpace: { "space-active": [teamFolder, projectFolder] },
      listsByFolder: { "folder-team": [teamList], "folder-project": [projectList] },
      folderlessListsBySpace: { "space-active": [] },
      tasksByList: {
        "list-team": [
          clickupTask({
            id: "task-team-folder",
            name: "No project parent",
            list: teamList,
            spaceId: "space-active",
            folder: teamFolder,
          }),
        ],
        "list-project": [
          clickupTask({
            id: "task-project-folder",
            name: "Keep project parent",
            list: projectList,
            spaceId: "space-active",
            folder: projectFolder,
          }),
        ],
      },
    });
    const connector = await seedConnector(db, "clickup", {
      hierarchyMapping: { levels: { folder: "project", list: "ignore" } },
    });
    await seedClassifiedContainer(db, {
      connectorConfigId: connector.id,
      connectorType: "clickup",
      externalId: "folder-team",
      levelKey: "folder",
      name: "Support Team",
      classification: "team",
    });
    await seedClassifiedContainer(db, {
      connectorConfigId: connector.id,
      connectorType: "clickup",
      externalId: "folder-project",
      levelKey: "folder",
      name: "Client Launch",
      classification: "project",
    });
    await runSync(db, connector.id, "active");

    const clickupRefs = await db
      .selectFrom("entity_source_refs")
      .innerJoin("entities", "entities.id", "entity_source_refs.entity_id")
      .select(["entity_source_refs.source_id", "entities.source_type"])
      .where("entity_source_refs.source", "=", "clickup")
      .orderBy("entity_source_refs.source_id", "asc")
      .execute();
    expect(clickupRefs).toEqual(
      expect.arrayContaining([
        { source_id: "folder-team", source_type: "team" },
        { source_id: "folder-project", source_type: "project" },
      ]),
    );
    const clickupTasks = await db
      .selectFrom("tasks")
      .leftJoin("entity_source_refs", "entity_source_refs.entity_id", "tasks.parent_entity_id")
      .select(["tasks.source_task_id", "tasks.parent_entity_id", "entity_source_refs.source_id as parent_source_id"])
      .where("tasks.source", "=", "clickup")
      .orderBy("tasks.source_task_id", "asc")
      .execute();
    expect(clickupTasks).toEqual([
      {
        source_task_id: "task-project-folder",
        parent_entity_id: expect.any(String),
        parent_source_id: "folder-project",
      },
      { source_task_id: "task-team-folder", parent_entity_id: null, parent_source_id: null },
    ]);

    vi.restoreAllMocks();
    const ignoreList = { id: "list-ignore", name: "Ignored List" };
    mockClickUpFetch({
      team: { id: "workspace-ignore", name: "Ignore Workspace", members: [] },
      spaces: [{ id: "space-ignore", name: "Intake" }],
      foldersBySpace: { "space-ignore": [] },
      listsByFolder: {},
      folderlessListsBySpace: { "space-ignore": [ignoreList] },
      tasksByList: {
        "list-ignore": [
          clickupTask({ id: "task-ignore-list", name: "No list project", list: ignoreList, spaceId: "space-ignore" }),
        ],
      },
    });
    const ignoreConnector = await seedConnector(db, "clickup", {
      hierarchyMapping: { levels: { space: "ignore", list: "project" } },
    });
    await seedClassifiedContainer(db, {
      connectorConfigId: ignoreConnector.id,
      connectorType: "clickup",
      externalId: "list-ignore",
      levelKey: "list",
      name: "Ignored List",
      classification: "ignore",
      classificationStatus: "historical",
    });
    await runSync(db, ignoreConnector.id, "active");
    await expect(
      db
        .selectFrom("entity_source_refs")
        .select("source_id")
        .where("source", "=", "clickup")
        .where("source_id", "=", "list-ignore")
        .execute(),
    ).resolves.toHaveLength(0);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        graphqlResponse({
          data: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "lin-issue-1",
                  identifier: "PLAT-1",
                  title: "Keep task project metadata",
                  description: null,
                  url: "https://linear.example/issue/PLAT-1",
                  state: { name: "Todo", type: "unstarted" },
                  priority: 3,
                  priorityLabel: "Medium",
                  assignee: null,
                  labels: { nodes: [] },
                  team: { id: "lin-team-1", name: "Platform", key: "PLAT" },
                  project: { id: "lin-proj-1", name: "Atlas Launch" },
                  estimate: null,
                  dueDate: null,
                  createdAt: "2026-06-08T00:00:00.000Z",
                  updatedAt: "2026-06-10T00:00:00.000Z",
                  comments: { nodes: [] },
                },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        graphqlResponse({
          data: {
            teams: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "lin-team-1", name: "Platform", key: "PLAT", members: { nodes: [] } }],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        graphqlResponse({
          data: {
            projects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "lin-proj-1",
                  name: "Atlas Launch",
                  description: "Launch coordination",
                  url: "https://linear.example/project/lin-proj-1",
                  state: "started",
                  lead: null,
                  startDate: "2026-06-01",
                  targetDate: "2026-07-15",
                  teams: { nodes: [{ name: "Platform", key: "PLAT" }] },
                  createdAt: "2026-06-01T00:00:00.000Z",
                  updatedAt: "2026-06-10T00:00:00.000Z",
                },
              ],
            },
          },
        }),
      );
    const linearConnector = await seedConnector(db, "linear", {});
    await seedClassifiedContainer(db, {
      connectorConfigId: linearConnector.id,
      connectorType: "linear",
      externalId: "lin-proj-1",
      levelKey: "project",
      name: "Atlas Launch",
      classification: "account",
    });
    await runSync(db, linearConnector.id, "active");
    await expect(
      db.selectFrom("entity_source_refs").select("source_id").where("source", "=", "linear").execute(),
    ).resolves.toEqual([{ source_id: "lin-team-1" }]);
    await expect(
      db
        .selectFrom("tasks")
        .select(["parent_name"])
        .where("source_task_id", "=", "lin-issue-1")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ parent_name: "Platform Atlas Launch" });
  });

  it("creates matching work cycles for time_box classification and legacy list sprint mapping", async () => {
    const folder = { id: "folder-cycle", name: "Delivery Project" };
    const classifiedList = {
      id: "list-time-box",
      name: "Sprint 42",
      start_date: "1780272000000",
      due_date: "1782864000000",
    };
    const legacyList = {
      id: "list-legacy-sprint",
      name: "Sprint 42",
      start_date: "1780272000000",
      due_date: "1782864000000",
    };
    const fixtureWithClassifiedList: ClickUpFixture = {
      team: { id: "workspace-cycle", name: "Cycle Workspace", members: [] },
      spaces: [{ id: "space-cycle", name: "Delivery", features: { sprints: { enabled: false } } }],
      foldersBySpace: { "space-cycle": [folder] },
      listsByFolder: { "folder-cycle": [classifiedList] },
      folderlessListsBySpace: { "space-cycle": [] },
      tasksByList: {
        "list-time-box": [
          clickupTask({
            id: "task-time-box",
            name: "Classified cycle task",
            list: classifiedList,
            spaceId: "space-cycle",
            folder,
          }),
        ],
      },
    };
    mockClickUpFetch(fixtureWithClassifiedList);
    const connector = await seedConnector(db, "clickup", {
      hierarchyMapping: { levels: { folder: "project", list: "ignore" } },
    });
    await seedClassifiedContainer(db, {
      connectorConfigId: connector.id,
      connectorType: "clickup",
      externalId: "list-time-box",
      levelKey: "list",
      name: "Sprint 42",
      classification: "time_box",
    });
    await runSync(db, connector.id, "active");
    await expect(db.selectFrom("work_cycles").select("external_ref").execute()).resolves.toEqual([
      { external_ref: "list-time-box" },
    ]);

    vi.restoreAllMocks();
    mockClickUpFetch({
      ...fixtureWithClassifiedList,
      listsByFolder: { "folder-cycle": [classifiedList, legacyList] },
      tasksByList: {
        ...fixtureWithClassifiedList.tasksByList,
        "list-legacy-sprint": [
          clickupTask({
            id: "task-legacy-sprint",
            name: "Legacy cycle task",
            list: legacyList,
            spaceId: "space-cycle",
            folder,
          }),
        ],
      },
    });
    await db
      .updateTable("connector_configs")
      .set({
        scope_config: JSON.stringify({ hierarchyMapping: { levels: { folder: "project", list: "sprint" } } }),
      })
      .where("id", "=", connector.id)
      .execute();
    await runSync(db, connector.id, "active");

    const cycles = await db
      .selectFrom("work_cycles")
      .select(["external_ref", "source", "name", "sequence", "starts_at", "ends_at", "state", "scope_entity_id"])
      .orderBy("external_ref", "asc")
      .execute();
    expect(cycles).toHaveLength(2);
    const legacyCycle = cycles.find((cycle) => cycle.external_ref === "list-legacy-sprint");
    const classifiedCycle = cycles.find((cycle) => cycle.external_ref === "list-time-box");
    expect(legacyCycle).toBeDefined();
    expect(classifiedCycle).toBeDefined();
    expect({ ...classifiedCycle, external_ref: legacyCycle?.external_ref }).toEqual(legacyCycle);
  });
});
