import { createHash } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import { createEntityRepository, normalizeContactPointValue } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import {
  GRAPH_VERDICT_ACTIVE_STATUSES,
  type StoreGraphVerdictInput,
  createGraphVerdictRepository,
} from "../db/repositories/graph-verdicts";
import { createMembershipSuppressionRepository } from "../db/repositories/membership-suppressions";
import type { ConnectorConfigsTable, ContainersTable, DB, IndexedFilesTable } from "../db/schema";
import { filesForContainer, prepareFilesForContainerMatching } from "./container-file-matcher";
import { containerVerdictFingerprint } from "./verdict-fingerprint";

export interface ContainerMembershipDeps {
  db: Kysely<DB>;
  logger: Pick<Logger, "info" | "warn">;
}

export interface ContainerMembershipResult {
  containers: number;
  people: number;
  windowsWritten: number;
  windowsClosed: number;
  maturityProposals: number;
}

type ConnectorRow = Pick<Selectable<ConnectorConfigsTable>, "id" | "connector_type" | "created_by">;
type ContainerRow = Selectable<ContainersTable>;
type MembershipFileRow = Pick<
  Selectable<IndexedFilesTable>,
  | "id"
  | "provider_file_id"
  | "rollup_group_id"
  | "file_name"
  | "source_path"
  | "source_meta"
  | "source_created_at"
  | "source_updated_at"
  | "synced_at"
>;

type AttributionFactRow = {
  indexed_file_id: string;
  fact_type: string;
  relation: string;
  subject_email: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  synced_at: string;
};

type Attribution = {
  fileId: string;
  personEntityId: string;
  email: string;
  month: string;
};

type ResolvedAttributions = {
  primary: Attribution[];
  authored: Attribution[];
};

type DerivedWindow = {
  sourceEntityId: string;
  targetEntityId: string;
  containerExternalId: string;
  validFrom: string;
  validTo: string | null;
  itemCount: number;
  share: number;
  authoredShare: number;
  evidenceFileId: string;
};

const DERIVED_MEMBERSHIP_SOURCE = "derived_membership";
const MATURITY_RULE_DEAD_TEAM = "dead_team";
const DAYS_TO_MATURE = 60;
const MATURE_TEAM_MIN_ITEMS = 30;

/**
 * Habuild measurement, 2026-08-22: a 50% home-share floor was the lowest floor
 * where every person had one home folder, the minimum item threshold was lowered
 * from 3 to 2 after QA Command Center lost real members at 3, and minimum
 * day-span was dropped because bulk-created ClickUp batches are legitimate.
 */
export const MEMBERSHIP_ENTRY_HOME_SHARE = 0.5;
export const MEMBERSHIP_ENTRY_MIN_CONTAINER_ITEMS = 2;

/**
 * Habuild measurement, 2026-08-22: a lower exit band was dropped because dips
 * were bimodal, while two consecutive observation months suppressed 73% of
 * one-month flaps. An observation month has at least two attributed items
 * anywhere in the connection for that person.
 */
export const MEMBERSHIP_EXIT_CONSECUTIVE_MONTHS = 2;
export const MEMBERSHIP_OBSERVATION_MONTH_MIN_ITEMS = 2;

function normalizeEmail(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return normalizeContactPointValue("email", raw);
  } catch {
    return null;
  }
}

function monthFor(row: Pick<AttributionFactRow, "source_updated_at" | "source_created_at" | "synced_at">): string {
  const value = row.source_updated_at ?? row.source_created_at ?? row.synced_at;
  return value.slice(0, 7);
}

function firstDayOfMonth(month: string): string {
  return `${month}-01T00:00:00.000Z`;
}

function endOfMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber ?? 1, 0, 23, 59, 59, 999)).toISOString();
}

function addCount(map: Map<string, number>, key: string, increment = 1): void {
  map.set(key, (map.get(key) ?? 0) + increment);
}

function pairKey(sourceEntityId: string, targetEntityId: string, validFrom: string): string {
  return `${sourceEntityId}\0${targetEntityId}\0${validFrom}`;
}

function parseEvidenceJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function loadConnector(db: Kysely<DB>, connectorConfigId: string): Promise<ConnectorRow | null> {
  const row = await db
    .selectFrom("connector_configs")
    .select(["id", "connector_type", "created_by"])
    .where("id", "=", connectorConfigId)
    .executeTakeFirst();
  return row ?? null;
}

async function loadTargetContainers(db: Kysely<DB>, connectorConfigId: string): Promise<ContainerRow[]> {
  return db
    .selectFrom("containers")
    .selectAll()
    .where("connector_config_id", "=", connectorConfigId)
    .where("classification", "=", "team")
    .where("classified_entity_id", "is not", null)
    .orderBy("id", "asc")
    .execute();
}

/**
 * Stale-close scope covers every classified container entity of the connection, not only
 * the current team containers: a container reclassified away from team must have its open
 * derived member windows closed, and edges carry no connector column of their own.
 */
async function loadConnectionContainerEntityIds(db: Kysely<DB>, connectorConfigId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("containers")
    .select("classified_entity_id")
    .where("connector_config_id", "=", connectorConfigId)
    .where("classified_entity_id", "is not", null)
    .execute();
  return [...new Set(rows.map((row) => row.classified_entity_id).filter((id): id is string => typeof id === "string"))];
}

async function loadFiles(db: Kysely<DB>, connector: ConnectorRow): Promise<MembershipFileRow[]> {
  return db
    .selectFrom("indexed_files")
    .select([
      "id",
      "provider_file_id",
      "rollup_group_id",
      "file_name",
      "source_path",
      "source_meta",
      "source_created_at",
      "source_updated_at",
      "synced_at",
    ])
    .where("connector_config_id", "=", connector.id)
    .where("source", "=", connector.connector_type)
    .where("is_archived", "=", 0)
    .execute();
}

async function loadAttributionFacts(db: Kysely<DB>, connectorConfigId: string): Promise<AttributionFactRow[]> {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .innerJoin("indexed_files", "indexed_files.id", "indexed_file_facts.indexed_file_id")
    .select([
      "indexed_file_facts.indexed_file_id as indexed_file_id",
      "indexed_file_facts.fact_type as fact_type",
      "indexed_file_facts.relation as relation",
      "indexed_file_facts.subject_email as subject_email",
      "indexed_files.source_created_at as source_created_at",
      "indexed_files.source_updated_at as source_updated_at",
      "indexed_files.synced_at as synced_at",
    ])
    .where("indexed_file_facts.connector_config_id", "=", connectorConfigId)
    .where("indexed_file_facts.deleted_at", "is", null)
    .where("indexed_file_facts.indexed_file_id", "is not", null)
    .where("indexed_file_facts.subject_email", "is not", null)
    .where("indexed_file_facts.fact_type", "in", ["assignee", "author"])
    .where("indexed_file_facts.relation", "in", ["assigned", "authored"])
    .where("indexed_files.is_archived", "=", 0)
    .execute();
  return rows.flatMap((row) =>
    row.indexed_file_id
      ? [
          {
            indexed_file_id: row.indexed_file_id,
            fact_type: row.fact_type,
            relation: row.relation,
            subject_email: row.subject_email,
            source_created_at: row.source_created_at,
            source_updated_at: row.source_updated_at,
            synced_at: row.synced_at,
          },
        ]
      : [],
  );
}

async function resolveAttributions(
  db: Kysely<DB>,
  facts: AttributionFactRow[],
  suppressedEmails: Set<string>,
): Promise<ResolvedAttributions> {
  const byFile = new Map<string, { month: string; assignees: Set<string>; authors: Set<string> }>();
  const allEmails = new Set<string>();
  for (const fact of facts) {
    const email = normalizeEmail(fact.subject_email);
    if (!email || suppressedEmails.has(email)) continue;
    allEmails.add(email);
    const bucket = byFile.get(fact.indexed_file_id) ?? {
      month: monthFor(fact),
      assignees: new Set<string>(),
      authors: new Set<string>(),
    };
    if (fact.fact_type === "assignee" || fact.relation === "assigned") bucket.assignees.add(email);
    if (fact.fact_type === "author" || fact.relation === "authored") bucket.authors.add(email);
    byFile.set(fact.indexed_file_id, bucket);
  }

  const peopleByEmail = await createEntityRepository(db).getPersonEntitiesByEmails([...allEmails]);
  const resolved = new Map<string, string>();
  for (const [email, people] of peopleByEmail) {
    if (people.length === 1) resolved.set(email, people[0].id);
  }

  const primary: Attribution[] = [];
  const authored: Attribution[] = [];
  for (const [fileId, bucket] of byFile) {
    const primaryEmails = bucket.assignees.size > 0 ? bucket.assignees : bucket.authors;
    for (const email of primaryEmails) {
      const personEntityId = resolved.get(email);
      if (!personEntityId) continue;
      primary.push({
        fileId,
        personEntityId,
        email,
        month: bucket.month,
      });
    }
    for (const email of bucket.authors) {
      const personEntityId = resolved.get(email);
      if (!personEntityId) continue;
      authored.push({
        fileId,
        personEntityId,
        email,
        month: bucket.month,
      });
    }
  }
  return { primary, authored };
}

function deriveWindowsForPersonContainer(params: {
  personEntityId: string;
  targetEntityId: string;
  containerExternalId: string;
  months: string[];
  personMonthTotals: Map<string, number>;
  containerMonthCounts: Map<string, number>;
  containerMonthFiles: Map<string, string[]>;
  authoredCount: number;
}): DerivedWindow[] {
  const windows: DerivedWindow[] = [];
  let inWindow = false;
  let firstContainerMonth: string | null = null;
  let validFromMonth: string | null = null;
  let segmentContainerCount = 0;
  let segmentTotalCount = 0;
  let consecutiveBelow = 0;
  let segmentFileIds: string[] = [];

  for (const month of params.months) {
    const total = params.personMonthTotals.get(month) ?? 0;
    const containerCount = params.containerMonthCounts.get(month) ?? 0;
    const files = params.containerMonthFiles.get(month) ?? [];
    if (!inWindow && containerCount > 0 && !firstContainerMonth) firstContainerMonth = month;
    segmentContainerCount += containerCount;
    segmentTotalCount += total;
    segmentFileIds = [...segmentFileIds, ...files];

    let enteredThisMonth = false;
    if (
      !inWindow &&
      firstContainerMonth &&
      segmentContainerCount >= MEMBERSHIP_ENTRY_MIN_CONTAINER_ITEMS &&
      segmentTotalCount > 0 &&
      segmentContainerCount / segmentTotalCount >= MEMBERSHIP_ENTRY_HOME_SHARE
    ) {
      inWindow = true;
      validFromMonth = firstContainerMonth;
      enteredThisMonth = true;
    }

    if (!inWindow || enteredThisMonth) continue;
    if (total >= MEMBERSHIP_OBSERVATION_MONTH_MIN_ITEMS) {
      const monthlyShare = total > 0 ? containerCount / total : 0;
      consecutiveBelow = monthlyShare < MEMBERSHIP_ENTRY_HOME_SHARE ? consecutiveBelow + 1 : 0;
      if (consecutiveBelow >= MEMBERSHIP_EXIT_CONSECUTIVE_MONTHS && validFromMonth) {
        const share = segmentTotalCount > 0 ? segmentContainerCount / segmentTotalCount : 0;
        windows.push({
          sourceEntityId: params.personEntityId,
          targetEntityId: params.targetEntityId,
          containerExternalId: params.containerExternalId,
          validFrom: firstDayOfMonth(validFromMonth),
          validTo: endOfMonth(month),
          itemCount: segmentContainerCount,
          share,
          authoredShare: segmentContainerCount > 0 ? params.authoredCount / segmentContainerCount : 0,
          evidenceFileId: [...new Set(segmentFileIds)].sort()[0] ?? "",
        });
        inWindow = false;
        firstContainerMonth = null;
        validFromMonth = null;
        segmentContainerCount = 0;
        segmentTotalCount = 0;
        consecutiveBelow = 0;
        segmentFileIds = [];
      }
    }
  }

  if (inWindow && validFromMonth) {
    const share = segmentTotalCount > 0 ? segmentContainerCount / segmentTotalCount : 0;
    windows.push({
      sourceEntityId: params.personEntityId,
      targetEntityId: params.targetEntityId,
      containerExternalId: params.containerExternalId,
      validFrom: firstDayOfMonth(validFromMonth),
      validTo: null,
      itemCount: segmentContainerCount,
      share,
      authoredShare: segmentContainerCount > 0 ? params.authoredCount / segmentContainerCount : 0,
      evidenceFileId: [...new Set(segmentFileIds)].sort()[0] ?? "",
    });
  }
  return windows.filter((window) => window.evidenceFileId.length > 0);
}

function maturityFingerprint(input: { containerId: string; rule: string; memberCount: number }): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

/**
 * Rejected maturity reopens are remembered by the maturityFingerprint embedded
 * in evidence_json. The guard scans all prior classify_container verdicts for
 * that container, so the same arithmetic contradiction is never re-asked after
 * a human rejection even though migration 213 allows new awaiting_human rows
 * after an applied verdict.
 */
async function shouldProposeMaturityVerdict(
  db: Kysely<DB>,
  containerId: string,
  fingerprint: string,
): Promise<boolean> {
  const rows = await db
    .selectFrom("graph_verdicts")
    .select(["status", "evidence_json"])
    .where("action", "=", "classify_container")
    .where("subject_container_id", "=", containerId)
    .where("superseded_at", "is", null)
    .execute();
  if (rows.some((row) => (GRAPH_VERDICT_ACTIVE_STATUSES as readonly string[]).includes(row.status))) return false;
  for (const row of rows) {
    const evidence = parseEvidenceJson(row.evidence_json);
    const maturity = evidence.maturity;
    if (maturity && typeof maturity === "object" && !Array.isArray(maturity)) {
      const stored = (maturity as Record<string, unknown>).maturityFingerprint;
      if (stored === fingerprint) return false;
    }
  }
  return true;
}

function maturityVerdictInput(params: {
  runId: string;
  container: ContainerRow;
  maturityFingerprint: string;
}): StoreGraphVerdictInput {
  return {
    runId: params.runId,
    action: "classify_container",
    subjectEntityId: params.container.classified_entity_id,
    subjectContainerId: params.container.id,
    subjectName: params.container.name,
    subjectEntityType: "container_classification",
    targetEntityId: null,
    resolvedTargetEntityId: null,
    targetName: null,
    reason: "Mature team container has no derived home members.",
    evidenceJson: JSON.stringify({
      classification: "team",
      entityStatus: "historical",
      samples: [],
      maturity: {
        rule: MATURITY_RULE_DEAD_TEAM,
        memberCount: 0,
        maturityFingerprint: params.maturityFingerprint,
      },
    }),
    evidenceFingerprint: containerVerdictFingerprint({ action: "classify_container", container: params.container }),
    validationStatus: "ok",
    validationReason: null,
    wouldChangeJson: JSON.stringify({ containers: 1 }),
    status: "awaiting_human",
  };
}

async function countOpenDerivedMembers(db: Kysely<DB>, teamEntityIds: string[]): Promise<Map<string, number>> {
  if (teamEntityIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("entity_relationships")
    .select(["target_entity_id", (eb) => eb.fn.countAll().as("count")])
    .where("relationship_type", "=", "member_of")
    .where("source", "=", DERIVED_MEMBERSHIP_SOURCE)
    .where("valid_to", "is", null)
    .where("target_entity_id", "in", teamEntityIds)
    .groupBy("target_entity_id")
    .execute();
  return new Map(rows.map((row) => [row.target_entity_id, Number(row.count)]));
}

async function countDerivedMemberWindows(db: Kysely<DB>, teamEntityIds: string[]): Promise<Map<string, number>> {
  if (teamEntityIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("entity_relationships")
    .select(["target_entity_id", (eb) => eb.fn.countAll().as("count")])
    .where("relationship_type", "=", "member_of")
    .where("source", "=", DERIVED_MEMBERSHIP_SOURCE)
    .where("target_entity_id", "in", teamEntityIds)
    .groupBy("target_entity_id")
    .execute();
  return new Map(rows.map((row) => [row.target_entity_id, Number(row.count)]));
}

export async function proposeContainerMaturityReopens(
  deps: ContainerMembershipDeps,
  connectorConfigId: string,
): Promise<number> {
  const connector = await loadConnector(deps.db, connectorConfigId);
  if (!connector) return 0;
  const cutoff = Date.now() - DAYS_TO_MATURE * 24 * 60 * 60 * 1000;
  const containers = await deps.db
    .selectFrom("containers")
    .selectAll()
    .where("connector_config_id", "=", connectorConfigId)
    .where("classification", "=", "team")
    .where("classification_status", "=", "active")
    .where("classified_entity_id", "is not", null)
    .where("item_count", ">=", MATURE_TEAM_MIN_ITEMS)
    .where("first_item_at", "is not", null)
    .execute();
  const mature = containers.filter((container) => {
    const first = container.first_item_at ? Date.parse(container.first_item_at) : Number.NaN;
    return Number.isFinite(first) && first < cutoff;
  });
  const teamEntityIds = mature
    .map((container) => container.classified_entity_id)
    .filter((id): id is string => typeof id === "string");
  const openCounts = await countOpenDerivedMembers(deps.db, teamEntityIds);
  const windowCounts = await countDerivedMemberWindows(deps.db, teamEntityIds);
  const pendingInputs: StoreGraphVerdictInput[] = [];

  for (const container of mature) {
    const teamEntityId = container.classified_entity_id;
    if (!teamEntityId) continue;
    const openMembers = openCounts.get(teamEntityId) ?? 0;
    if (openMembers !== 0) continue;
    const fingerprint = maturityFingerprint({
      containerId: container.id,
      rule: MATURITY_RULE_DEAD_TEAM,
      memberCount: windowCounts.get(teamEntityId) ?? 0,
    });
    if (!(await shouldProposeMaturityVerdict(deps.db, container.id, fingerprint))) continue;
    pendingInputs.push(maturityVerdictInput({ runId: "", container, maturityFingerprint: fingerprint }));
  }

  if (pendingInputs.length === 0) return 0;
  const verdictRepo = createGraphVerdictRepository(deps.db);
  const run = await verdictRepo.createRun({
    source: "container-maturity",
    proposedByUserId: connector.created_by,
    tokenId: null,
    note: null,
    verdictsProposed: pendingInputs.length,
  });
  await verdictRepo.storeVerdicts(pendingInputs.map((input) => ({ ...input, runId: run.id })));
  deps.logger.info(
    { connectorId: connectorConfigId, containerCount: mature.length, proposalCount: pendingInputs.length },
    "Container maturity validation proposed reopens",
  );
  return pendingInputs.length;
}

/**
 * Membership derivation is always a full per-connection recompute from
 * (activity, membership_suppressions). This is what makes suppression-list
 * changes deterministic and idempotent without triggers or dirty flags.
 */
export async function deriveContainerMembership(
  deps: ContainerMembershipDeps,
  connectorConfigId: string,
): Promise<ContainerMembershipResult> {
  const connector = await loadConnector(deps.db, connectorConfigId);
  if (!connector) {
    return { containers: 0, people: 0, windowsWritten: 0, windowsClosed: 0, maturityProposals: 0 };
  }
  const targetContainers = await loadTargetContainers(deps.db, connectorConfigId);
  const staleCloseEntityIds = await loadConnectionContainerEntityIds(deps.db, connectorConfigId);
  if (targetContainers.length === 0 && staleCloseEntityIds.length === 0) {
    return { containers: 0, people: 0, windowsWritten: 0, windowsClosed: 0, maturityProposals: 0 };
  }

  const files = await loadFiles(deps.db, connector);
  const filesWithMeta = prepareFilesForContainerMatching(files);
  const containerFileIds = new Map<string, Set<string>>();
  for (const container of targetContainers) {
    containerFileIds.set(container.id, new Set(filesForContainer(container, filesWithMeta).map((file) => file.id)));
  }

  const suppressedEmails = new Set(await createMembershipSuppressionRepository(deps.db).list(connectorConfigId));
  const facts = await loadAttributionFacts(deps.db, connectorConfigId);
  const resolvedAttributions = await resolveAttributions(deps.db, facts, suppressedEmails);
  const attributions = resolvedAttributions.primary;
  const factMonths = [...new Set(facts.map((fact) => monthFor(fact)))].sort();
  const personIds = [...new Set(attributions.map((attribution) => attribution.personEntityId))].sort();
  const months = [...new Set(attributions.map((attribution) => attribution.month))].sort();
  const personMonthTotalsByPerson = new Map<string, Map<string, number>>();
  const attributionsByFile = new Map<string, Attribution[]>();
  const authoredAttributionsByFile = new Map<string, Attribution[]>();

  for (const attribution of attributions) {
    const totals = personMonthTotalsByPerson.get(attribution.personEntityId) ?? new Map<string, number>();
    addCount(totals, attribution.month);
    personMonthTotalsByPerson.set(attribution.personEntityId, totals);
    const fileAttributions = attributionsByFile.get(attribution.fileId) ?? [];
    fileAttributions.push(attribution);
    attributionsByFile.set(attribution.fileId, fileAttributions);
  }
  for (const attribution of resolvedAttributions.authored) {
    const fileAttributions = authoredAttributionsByFile.get(attribution.fileId) ?? [];
    fileAttributions.push(attribution);
    authoredAttributionsByFile.set(attribution.fileId, fileAttributions);
  }

  const windows: DerivedWindow[] = [];
  for (const container of targetContainers) {
    if (!container.classified_entity_id) continue;
    const fileIds = containerFileIds.get(container.id) ?? new Set<string>();
    const containerCounts = new Map<string, Map<string, number>>();
    const containerFiles = new Map<string, Map<string, string[]>>();
    const authoredCounts = new Map<string, number>();
    for (const fileId of fileIds) {
      for (const attribution of attributionsByFile.get(fileId) ?? []) {
        const counts = containerCounts.get(attribution.personEntityId) ?? new Map<string, number>();
        addCount(counts, attribution.month);
        containerCounts.set(attribution.personEntityId, counts);
        const filesByMonth = containerFiles.get(attribution.personEntityId) ?? new Map<string, string[]>();
        filesByMonth.set(attribution.month, [...(filesByMonth.get(attribution.month) ?? []), fileId]);
        containerFiles.set(attribution.personEntityId, filesByMonth);
      }
      for (const attribution of authoredAttributionsByFile.get(fileId) ?? []) {
        addCount(authoredCounts, attribution.personEntityId);
      }
    }
    for (const [personEntityId, containerMonthCounts] of containerCounts) {
      windows.push(
        ...deriveWindowsForPersonContainer({
          personEntityId,
          targetEntityId: container.classified_entity_id,
          containerExternalId: container.external_id,
          months,
          personMonthTotals: personMonthTotalsByPerson.get(personEntityId) ?? new Map<string, number>(),
          containerMonthCounts,
          containerMonthFiles: containerFiles.get(personEntityId) ?? new Map<string, string[]>(),
          authoredCount: authoredCounts.get(personEntityId) ?? 0,
        }),
      );
    }
  }

  const domainsRepo = createEntityDomainsRepository(deps.db);
  let windowsWritten = 0;
  let windowsClosed = 0;
  const openKeys = new Set<string>();
  for (const window of windows) {
    const relationshipId = await domainsRepo.upsertMemberOf({
      personEntityId: window.sourceEntityId,
      teamEntityId: window.targetEntityId,
      confidence: "EXTRACTED",
      confidenceScore: window.share,
      source: DERIVED_MEMBERSHIP_SOURCE,
      validFrom: window.validFrom,
    });
    windowsWritten++;
    await domainsRepo.addEvidence({
      relationshipId,
      indexedFileId: window.evidenceFileId,
      evidenceKey: `membership:${window.containerExternalId}`,
      note: JSON.stringify({
        itemCount: window.itemCount,
        share: window.share,
        authoredShare: window.authoredShare,
      }),
    });
    if (window.validTo) {
      const closed = await domainsRepo.closeRelationshipWindow({
        sourceEntityId: window.sourceEntityId,
        targetEntityId: window.targetEntityId,
        relationshipType: "member_of",
        validFrom: window.validFrom,
        validTo: window.validTo,
      });
      if (closed) windowsClosed++;
    } else {
      openKeys.add(pairKey(window.sourceEntityId, window.targetEntityId, window.validFrom));
    }
  }

  const staleCloseTo =
    factMonths.length > 0
      ? endOfMonth(factMonths[factMonths.length - 1])
      : endOfMonth(new Date().toISOString().slice(0, 7));
  const existingOpen =
    staleCloseEntityIds.length > 0
      ? await deps.db
          .selectFrom("entity_relationships")
          .select(["source_entity_id", "target_entity_id", "valid_from"])
          .where("relationship_type", "=", "member_of")
          .where("source", "=", DERIVED_MEMBERSHIP_SOURCE)
          .where("valid_to", "is", null)
          .where("target_entity_id", "in", staleCloseEntityIds)
          .execute()
      : [];
  for (const row of existingOpen) {
    if (openKeys.has(pairKey(row.source_entity_id, row.target_entity_id, row.valid_from))) continue;
    const closed = await domainsRepo.closeRelationshipWindow({
      sourceEntityId: row.source_entity_id,
      targetEntityId: row.target_entity_id,
      relationshipType: "member_of",
      validFrom: row.valid_from,
      validTo: staleCloseTo,
    });
    if (closed) windowsClosed++;
  }

  deps.logger.info(
    {
      connectorId: connectorConfigId,
      containerCount: targetContainers.length,
      personCount: personIds.length,
      windowCount: windows.length,
      closedCount: windowsClosed,
      suppressedCount: suppressedEmails.size,
    },
    "Container membership recomputed",
  );

  return {
    containers: targetContainers.length,
    people: personIds.length,
    windowsWritten,
    windowsClosed,
    maturityProposals: 0,
  };
}
