import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import type { GeminiGenerator } from "../connectors/gemini-generate";
import { readHierarchyMappingConfig } from "../connectors/hierarchy-mapping";
import type { AgenticOptions, AgenticOutcome } from "../connectors/openrouter-generate";
import { type StoreGraphVerdictInput, createGraphVerdictRepository } from "../db/repositories/graph-verdicts";
import type { ConnectorConfigsTable, ContainersTable, DB, IndexedFilesTable } from "../db/schema";
import {
  filesForContainer,
  parseJsonArray,
  pathForContainer,
  prepareFilesForContainerMatching,
} from "./container-file-matcher";
import { containerVerdictFingerprint } from "./verdict-fingerprint";

export type ContainerJudgeClassification = "team" | "project" | "time_box" | "account" | "ignore";
export type ContainerJudgeEntityStatus = "active" | "historical";

export interface ContainerJudgeAgenticGenerator {
  generateAgenticJSON<T>(prompt: string, opts: AgenticOptions): Promise<AgenticOutcome<T>>;
}

export interface ContainerJudgeDeps {
  db: Kysely<DB>;
  logger: Pick<Logger, "warn" | "info">;
  generator?: GeminiGenerator | null;
  agenticGenerator?: ContainerJudgeAgenticGenerator | null;
  model?: string | null;
}

export interface ContainerJudgeResult {
  groupsJudged: number;
  containersPrompted: number;
  verdictsAccepted: number;
  verdictsStored: number;
  verdictsBounced: number;
  groupsFailed: number;
}

type ContainerRow = Selectable<ContainersTable>;
type ConnectorConfigRow = Selectable<ConnectorConfigsTable>;
type IndexedFileRow = Pick<
  Selectable<IndexedFilesTable>,
  | "provider_file_id"
  | "rollup_group_id"
  | "file_name"
  | "source_path"
  | "source_meta"
  | "source_created_at"
  | "source_updated_at"
  | "synced_at"
>;

type ContainerStatsContext = {
  id: string;
  name: string;
  levelKey: string;
  pathNames: string[];
  path: string[];
  levelPrior: string | null;
  itemCount: number;
  firstItemAt: string | null;
  lastItemAt: string | null;
  siblingNames: string[];
  siblingClassifications: Array<{
    id: string;
    name: string;
    classification: string | null;
    entityStatus: string | null;
  }>;
  samples: string[];
};

type JudgeGroup = {
  key: string;
  parentContainerId: string | null;
  containers: ContainerRow[];
};

type RawContainerVerdict = {
  containerId?: unknown;
  classification?: unknown;
  entityStatus?: unknown;
  reason?: unknown;
};

export type ContainerJudgeVerdict = {
  containerId: string;
  classification: ContainerJudgeClassification;
  entityStatus: ContainerJudgeEntityStatus;
  reason: string;
};

const CLASSIFICATIONS = new Set<ContainerJudgeClassification>(["team", "project", "time_box", "account", "ignore"]);
const ENTITY_STATUSES = new Set<ContainerJudgeEntityStatus>(["active", "historical"]);

function parseScopeConfig(row: ConnectorConfigRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.scope_config) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function pathFor(container: ContainerRow): string[] {
  return pathForContainer(container);
}

function parentGroupKey(parentContainerId: string | null): string {
  return parentContainerId ?? "__root__";
}

function groupContainers(containers: ContainerRow[]): JudgeGroup[] {
  const byParent = new Map<string, JudgeGroup>();
  for (const container of containers) {
    const key = parentGroupKey(container.parent_container_id);
    const group = byParent.get(key);
    if (group) {
      group.containers.push(container);
    } else {
      byParent.set(key, { key, parentContainerId: container.parent_container_id, containers: [container] });
    }
  }
  return [...byParent.values()].map((group) => ({
    ...group,
    containers: group.containers.sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    ),
  }));
}

function sampleTitles(files: IndexedFileRow[], limit = 12): string[] {
  const sorted = [...files].sort((left, right) => {
    const leftKey = left.source_updated_at ?? left.source_created_at ?? left.synced_at ?? "";
    const rightKey = right.source_updated_at ?? right.source_created_at ?? right.synced_at ?? "";
    if (leftKey !== rightKey) return leftKey.localeCompare(rightKey);
    return left.file_name.localeCompare(right.file_name);
  });
  if (sorted.length <= limit) return sorted.map((file) => file.file_name);
  const indexes = new Set<number>([0, sorted.length - 1]);
  const remaining = limit - indexes.size;
  for (let i = 1; i <= remaining; i++) {
    indexes.add(Math.floor((i * (sorted.length - 1)) / (remaining + 1)));
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => sorted[index]?.file_name)
    .filter((title): title is string => typeof title === "string" && title.length > 0);
}

function levelPriorFor(container: ContainerRow, connector: ConnectorConfigRow): string | null {
  const scope = parseScopeConfig(connector);
  const mapping = readHierarchyMappingConfig(scope.hierarchyMapping);
  return mapping.levels[container.level_key] ?? null;
}

async function listActiveContainerVerdictIds(db: Kysely<DB>, containerIds: string[]): Promise<Set<string>> {
  if (containerIds.length === 0) return new Set();
  const rows = await db
    .selectFrom("graph_verdicts")
    .select("subject_container_id")
    .where("action", "=", "classify_container")
    .where("status", "in", ["awaiting_human", "approved"])
    .where("superseded_at", "is", null)
    .where("subject_container_id", "in", containerIds)
    .execute();
  return new Set(rows.map((row) => row.subject_container_id).filter((id): id is string => typeof id === "string"));
}

async function loadConnector(db: Kysely<DB>, connectorConfigId: string): Promise<ConnectorConfigRow | null> {
  const row = await db
    .selectFrom("connector_configs")
    .selectAll()
    .where("id", "=", connectorConfigId)
    .executeTakeFirst();
  return row ?? null;
}

async function loadUnclassifiedDocket(db: Kysely<DB>, connectorConfigId: string): Promise<ContainerRow[]> {
  const rows = await db
    .selectFrom("containers")
    .selectAll()
    .where("connector_config_id", "=", connectorConfigId)
    .where("classification", "is", null)
    .where("verdict_id", "is", null)
    .orderBy("parent_container_id", "asc")
    .orderBy("name", "asc")
    .execute();
  const active = await listActiveContainerVerdictIds(
    db,
    rows.map((row) => row.id),
  );
  return rows.filter((row) => !active.has(row.id));
}

async function loadConnectorContainers(db: Kysely<DB>, connectorConfigId: string): Promise<ContainerRow[]> {
  return db.selectFrom("containers").selectAll().where("connector_config_id", "=", connectorConfigId).execute();
}

async function loadIndexedFileRows(
  db: Kysely<DB>,
  connectorConfigId: string,
  connectorType: string,
): Promise<IndexedFileRow[]> {
  return db
    .selectFrom("indexed_files")
    .select([
      "provider_file_id",
      "rollup_group_id",
      "file_name",
      "source_path",
      "source_meta",
      "source_created_at",
      "source_updated_at",
      "synced_at",
    ])
    .where("connector_config_id", "=", connectorConfigId)
    .where("source", "=", connectorType)
    .where("is_archived", "=", 0)
    .execute();
}

/**
 * Samples are only computed for docket containers: the prompt and stored
 * evidence only ever read samples for containers being judged, and matching
 * files to a container is the expensive part of context building.
 */
function buildStatsContexts(params: {
  connector: ConnectorConfigRow;
  containers: ContainerRow[];
  files: IndexedFileRow[];
  sampleContainerIds: Set<string>;
}): Map<string, ContainerStatsContext> {
  const siblingsByParent = new Map<string, ContainerRow[]>();
  for (const container of params.containers) {
    const key = parentGroupKey(container.parent_container_id);
    siblingsByParent.set(key, [...(siblingsByParent.get(key) ?? []), container]);
  }
  const filesWithMeta = prepareFilesForContainerMatching(params.files);
  const contexts = new Map<string, ContainerStatsContext>();
  for (const container of params.containers) {
    const siblings = (siblingsByParent.get(parentGroupKey(container.parent_container_id)) ?? []).filter(
      (candidate) => candidate.id !== container.id,
    );
    contexts.set(container.id, {
      id: container.id,
      name: container.name,
      levelKey: container.level_key,
      pathNames: parseJsonArray(container.path_names),
      path: pathFor(container),
      levelPrior: levelPriorFor(container, params.connector),
      itemCount: container.item_count,
      firstItemAt: container.first_item_at,
      lastItemAt: container.last_item_at,
      siblingNames: siblings.map((sibling) => sibling.name).sort((left, right) => left.localeCompare(right)),
      siblingClassifications: siblings
        .map((sibling) => ({
          id: sibling.id,
          name: sibling.name,
          classification: sibling.classification,
          entityStatus: sibling.classification_status,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      samples: params.sampleContainerIds.has(container.id)
        ? sampleTitles(filesForContainer(container, filesWithMeta), 12)
        : [],
    });
  }
  return contexts;
}

function buildContainerJudgePrompt(group: JudgeGroup, contexts: Map<string, ContainerStatsContext>): string {
  const lines: string[] = [
    "You are classifying newly discovered project-management containers for a work graph.",
    "Classify only the containers listed below. Use the per-level hierarchy mapping as a prior, not as a rule.",
    "",
    "Allowed classifications:",
    '- "team" — a real organizational team or delivery unit.',
    '- "project" — a real delivery project or workstream.',
    '- "time_box" — sprint, cycle, dated batch, event, or other time-bounded work bucket.',
    '- "account" — client, account, or engagement-shaped container.',
    '- "ignore" — junk, admin, demo, archive, doc folder, CRM row list, or otherwise not graph structure.',
    "",
    'Entity status must be "active" or "historical".',
    "Keep each reason to one short sentence. Return JSON only.",
    "",
    "Containers:",
  ];
  for (const container of group.containers) {
    const context = contexts.get(container.id);
    if (!context) continue;
    lines.push(
      `- containerId: ${container.id}`,
      `  name: ${context.name}`,
      `  levelKey: ${context.levelKey}`,
      `  path: ${context.path.join(" > ")}`,
      `  levelPrior: ${context.levelPrior ?? "none"}`,
      `  itemStats: count=${context.itemCount}, first=${context.firstItemAt ?? "none"}, last=${
        context.lastItemAt ?? "none"
      }`,
      `  siblings: ${context.siblingNames.length > 0 ? context.siblingNames.join(", ") : "none"}`,
      `  samples: ${context.samples.length > 0 ? context.samples.join(" | ") : "none"}`,
    );
  }
  lines.push(
    "",
    "Respond with JSON only:",
    JSON.stringify({
      verdicts: [
        {
          containerId: "...",
          classification: "team|project|time_box|account|ignore",
          entityStatus: "active|historical",
          reason: "one short sentence",
        },
      ],
    }),
    "Return at most one verdict per listed container. Omit a container if evidence is insufficient.",
  );
  return lines.join("\n");
}

function validateContainerJudgeVerdicts(
  group: JudgeGroup,
  raw: unknown,
  logger: Pick<Logger, "warn">,
): ContainerJudgeVerdict[] {
  const allowed = new Map(group.containers.map((container) => [container.id, container]));
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { verdicts?: unknown }).verdicts)) {
    logger.warn(
      { containerCount: group.containers.length, reason: "malformed_output" },
      "Dropped container judge output",
    );
    return [];
  }
  const seen = new Set<string>();
  const verdicts: ContainerJudgeVerdict[] = [];
  for (const item of (raw as { verdicts: unknown[] }).verdicts) {
    if (!item || typeof item !== "object") {
      logger.warn({ reason: "malformed_verdict" }, "Dropped container judge verdict");
      continue;
    }
    const verdict = item as RawContainerVerdict;
    const containerId = typeof verdict.containerId === "string" ? verdict.containerId : null;
    const container = containerId ? allowed.get(containerId) : null;
    if (!containerId || !container) {
      logger.warn({ containerId: containerId ?? null, reason: "unknown_container" }, "Dropped container judge verdict");
      continue;
    }
    if (seen.has(containerId)) {
      logger.warn({ containerName: container.name, reason: "duplicate_container" }, "Dropped container judge verdict");
      continue;
    }
    seen.add(containerId);
    if (!CLASSIFICATIONS.has(verdict.classification as ContainerJudgeClassification)) {
      logger.warn(
        { containerName: container.name, reason: "invalid_classification" },
        "Dropped container judge verdict",
      );
      continue;
    }
    if (!ENTITY_STATUSES.has(verdict.entityStatus as ContainerJudgeEntityStatus)) {
      logger.warn(
        { containerName: container.name, reason: "invalid_entity_status" },
        "Dropped container judge verdict",
      );
      continue;
    }
    verdicts.push({
      containerId,
      classification: verdict.classification as ContainerJudgeClassification,
      entityStatus: verdict.entityStatus as ContainerJudgeEntityStatus,
      reason: typeof verdict.reason === "string" ? verdict.reason.slice(0, 500) : "",
    });
  }
  return verdicts;
}

function verdictInput(params: {
  runId: string;
  container: ContainerRow;
  verdict: ContainerJudgeVerdict;
  samples: string[];
}): StoreGraphVerdictInput {
  return {
    runId: params.runId,
    action: "classify_container",
    subjectEntityId: null,
    subjectContainerId: params.container.id,
    subjectName: params.container.name,
    subjectEntityType: "container_classification",
    targetEntityId: null,
    resolvedTargetEntityId: null,
    targetName: null,
    reason: params.verdict.reason,
    evidenceJson: JSON.stringify({
      classification: params.verdict.classification,
      entityStatus: params.verdict.entityStatus,
      samples: params.samples,
    }),
    evidenceFingerprint: containerVerdictFingerprint({ action: "classify_container", container: params.container }),
    validationStatus: "ok",
    validationReason: null,
    wouldChangeJson: JSON.stringify({ containers: 1 }),
    status: "awaiting_human",
  };
}

function containerStatsTool(contexts: Map<string, ContainerStatsContext>) {
  return {
    name: "container_stats",
    description:
      "Return roster-free stats for a known container id: name, path, item stats, and sibling classifications.",
    parameters: {
      type: "object",
      properties: { containerId: { type: "string", description: "container id from the prompt" } },
      required: ["containerId"],
    },
    run: async (args: unknown) => {
      const containerId =
        args && typeof args === "object" && typeof (args as { containerId?: unknown }).containerId === "string"
          ? (args as { containerId: string }).containerId
          : null;
      if (!containerId) throw new Error("container_stats requires a containerId argument");
      const context = contexts.get(containerId);
      if (!context) throw new Error("unknown containerId");
      return JSON.stringify({
        id: context.id,
        name: context.name,
        levelKey: context.levelKey,
        pathNames: context.pathNames,
        path: context.path,
        levelPrior: context.levelPrior,
        itemCount: context.itemCount,
        firstItemAt: context.firstItemAt,
        lastItemAt: context.lastItemAt,
        siblingNames: context.siblingNames,
        siblingClassifications: context.siblingClassifications,
      });
    },
  };
}

async function judgeGroup(params: {
  deps: ContainerJudgeDeps;
  group: JudgeGroup;
  contexts: Map<string, ContainerStatsContext>;
  prompt: string;
}): Promise<ContainerJudgeVerdict[]> {
  const generateOptions = {
    maxTokens: 8192,
    label: "container-judge",
    model: params.deps.model,
    reasoningEffort: "medium" as const,
    thinkingBudget: null,
  };
  const raw = params.deps.agenticGenerator
    ? (
        await params.deps.agenticGenerator.generateAgenticJSON<unknown>(params.prompt, {
          ...generateOptions,
          tools: [containerStatsTool(params.contexts)],
          maxToolRounds: 3,
          onToolStep: async () => {},
        })
      ).value
    : await params.deps.generator?.generateJSON<unknown>(params.prompt, generateOptions);
  return validateContainerJudgeVerdicts(params.group, raw, params.deps.logger);
}

export async function judgeUnclassifiedContainers(
  deps: ContainerJudgeDeps,
  connectorConfigId: string,
): Promise<ContainerJudgeResult> {
  const empty: ContainerJudgeResult = {
    groupsJudged: 0,
    containersPrompted: 0,
    verdictsAccepted: 0,
    verdictsStored: 0,
    verdictsBounced: 0,
    groupsFailed: 0,
  };
  if (!deps.generator && !deps.agenticGenerator) {
    deps.logger.warn({ connectorConfigId }, "Skipping container judge without generator");
    return empty;
  }
  const connector = await loadConnector(deps.db, connectorConfigId);
  if (!connector) {
    deps.logger.warn({ connectorConfigId }, "Skipping container judge for missing connector");
    return empty;
  }
  const docket = await loadUnclassifiedDocket(deps.db, connectorConfigId);
  if (docket.length === 0) return empty;
  const [containers, files] = await Promise.all([
    loadConnectorContainers(deps.db, connectorConfigId),
    loadIndexedFileRows(deps.db, connectorConfigId, connector.connector_type),
  ]);
  const contexts = buildStatsContexts({
    connector,
    containers,
    files,
    sampleContainerIds: new Set(docket.map((container) => container.id)),
  });
  const groups = groupContainers(docket);
  const accepted: ContainerJudgeVerdict[] = [];
  const containersById = new Map(docket.map((container) => [container.id, container]));
  const result = { ...empty, groupsJudged: groups.length, containersPrompted: docket.length };
  for (const group of groups) {
    const prompt = buildContainerJudgePrompt(group, contexts);
    try {
      accepted.push(...(await judgeGroup({ deps, group, contexts, prompt })));
    } catch (err) {
      result.groupsFailed += 1;
      deps.logger.warn(
        {
          errorType: err instanceof Error ? err.name : typeof err,
          connectorConfigId,
          parentContainerId: group.parentContainerId,
          containerNames: group.containers.map((container) => container.name),
          containerCount: group.containers.length,
        },
        "Container judge group failed",
      );
    }
  }
  result.verdictsAccepted = accepted.length;
  if (accepted.length === 0) return result;
  const repo = createGraphVerdictRepository(deps.db);
  const run = await repo.createRun({
    source: "container-judge",
    proposedByUserId: connector.created_by,
    tokenId: null,
    note: null,
    verdictsProposed: accepted.length,
  });
  const storeInputs = accepted
    .map((verdict) => {
      const container = containersById.get(verdict.containerId);
      const context = contexts.get(verdict.containerId);
      return container ? verdictInput({ runId: run.id, container, verdict, samples: context?.samples ?? [] }) : null;
    })
    .filter((input): input is StoreGraphVerdictInput => input !== null);
  const stored = await repo.storeVerdicts(storeInputs);
  result.verdictsStored = stored.rows.filter((row) => row.status === "awaiting_human").length;
  result.verdictsBounced = stored.rows.filter((row) => row.status === "bounced").length;
  deps.logger.info(
    {
      connectorConfigId,
      containersPrompted: result.containersPrompted,
      verdictsStored: result.verdictsStored,
      verdictsBounced: result.verdictsBounced,
      groupsFailed: result.groupsFailed,
    },
    "Container judge completed",
  );
  return result;
}
