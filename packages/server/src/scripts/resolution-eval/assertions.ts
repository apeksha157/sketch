import { createHash } from "node:crypto";
import type pg from "pg";
import { evaluateAdjacencyFromDatabase } from "./adjacency";
import { buildDupSuspectGroups } from "./dup-groups";
import {
  type ResolutionEvalManifest,
  buildAliasProvenancePreview,
  firstNameCollisionPersonIds,
  isSingleTokenPersonRow,
  queueCensusFromRows,
  stalenessSweepPreview,
} from "./manifest";
import type { AssertionResult } from "./report";

interface QueueRow {
  id: string;
  proposed_name: string;
  normalized_name: string;
  entity_type: string;
  status: string;
  candidate_entity_id: string | null;
  candidate_entity_ids: string | null;
}

interface EntityRow {
  id: string;
  name: string;
  source_type: string;
  aliases: string | null;
  provenance_tier: string | null;
}

interface FileIntegrityRow {
  id: string;
  content: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function equalUnknown(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function result(input: {
  id: string;
  title: string;
  expected: unknown;
  actual: unknown;
  details?: string[];
  passed?: boolean;
}): AssertionResult {
  return {
    id: input.id,
    title: input.title,
    expected: input.expected,
    actual: input.actual,
    details: input.details,
    passed: input.passed ?? equalUnknown(input.expected, input.actual),
  };
}

async function loadPendingDeferredRows(client: pg.Client): Promise<QueueRow[]> {
  const { rows } = await client.query<QueueRow>(
    `select id, proposed_name, normalized_name, entity_type, status, candidate_entity_id, candidate_entity_ids
     from entity_review_queue
     where status in ('pending', 'deferred')
     order by entity_type, normalized_name, id`,
  );
  return rows;
}

async function loadLiveEntities(client: pg.Client): Promise<EntityRow[]> {
  const { rows } = await client.query<EntityRow>(
    `select id, name, source_type, aliases, provenance_tier
     from entities
     where deleted_at is null and merged_into_entity_id is null
     order by source_type, name, id`,
  );
  return rows;
}

async function corpusIntegrity(client: pg.Client, manifest: ResolutionEvalManifest): Promise<AssertionResult> {
  const expectedIds = manifest.files.map((file) => file.id).sort();
  if (expectedIds.length === 0) {
    return result({
      id: "corpus-integrity",
      title: "Every manifest file exists, hashes match, and content is non-empty.",
      expected: { manifestFiles: "> 0" },
      actual: { manifestFiles: 0 },
      passed: false,
      details: ["The checked-in manifest is a placeholder. Run build-manifest before using baseline assertions."],
    });
  }

  const { rows } = await client.query<FileIntegrityRow>(
    `select id, content
     from indexed_files
     where id = any($1::text[])
     order by id`,
    [expectedIds],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = expectedIds.filter((id) => !byId.has(id));
  const empty = rows
    .filter((row) => !row.content || row.content.length === 0)
    .map((row) => row.id)
    .sort();
  const mismatched = manifest.files
    .filter((file) => {
      const row = byId.get(file.id);
      return row && sha256(row.content ?? "") !== file.contentSha256;
    })
    .map((file) => file.id)
    .sort();
  return result({
    id: "corpus-integrity",
    title: "Every manifest file exists, hashes match, and content is non-empty.",
    expected: { missing: [], empty: [], mismatched: [] },
    actual: { missing, empty, mismatched },
  });
}

async function queueCensus(client: pg.Client, manifest: ResolutionEvalManifest): Promise<AssertionResult> {
  const rows = await loadPendingDeferredRows(client);
  const actual = {
    ids: {
      pendingDeferredReviewIds: rows.map((row) => row.id).sort(),
      singleTokenPersonReviewIds: rows
        .filter(isSingleTokenPersonRow)
        .map((row) => row.id)
        .sort(),
      companyPendingReviewIds: rows
        .filter((row) => row.entity_type === "company" && row.status === "pending")
        .map((row) => row.id)
        .sort(),
    },
    census: queueCensusFromRows(rows),
  };
  const expected = {
    ids: {
      pendingDeferredReviewIds: manifest.sets.pendingDeferredReviewIds,
      singleTokenPersonReviewIds: manifest.sets.singleTokenPersonReviewIds,
      companyPendingReviewIds: manifest.sets.companyPendingReviewIds,
    },
    census: manifest.expectations.queueCensus,
  };
  return result({
    id: "queue-census",
    title: "Pending/deferred queue rows match manifest census and fan-out distribution.",
    expected,
    actual,
  });
}

async function stalenessPreview(client: pg.Client, manifest: ResolutionEvalManifest): Promise<AssertionResult> {
  const rows = await loadPendingDeferredRows(client);
  const entities = await loadLiveEntities(client);
  const actual = stalenessSweepPreview(rows, entities);
  return result({
    id: "staleness-sweep-preview",
    title: "Rows exact-matching live same-type names or aliases match the free-sweep baseline.",
    expected: manifest.expectations.stalenessSweepPreview,
    actual,
  });
}

async function adjacencyGroundTruth(client: pg.Client, manifest: ResolutionEvalManifest): Promise<AssertionResult> {
  const actualEvaluation = await evaluateAdjacencyFromDatabase(client);
  const tally = actualEvaluation.modes.edgeWinCoMentionVeto;
  const actual = {
    trials: tally.trials,
    linked: tally.linked,
    correct: tally.correct,
    wrong: tally.wrong,
    abstainNoSignal: tally.abstainNoSignal,
    abstainAmbiguous: tally.abstainAmbiguous,
    precision: tally.precision,
    coverage: tally.coverage,
    knownWrongLinks: tally.wrongLinks,
  };
  return result({
    id: "adjacency-ground-truth",
    title: "Tier-1 edge-wins plus co-mention-veto simulation matches the pinned trial set.",
    expected: manifest.expectations.adjacencyGroundTruth,
    actual,
  });
}

async function aliasPreview(client: pg.Client, manifest: ResolutionEvalManifest): Promise<AssertionResult> {
  const actual = await buildAliasProvenancePreview(client, await loadLiveEntities(client));
  return result({
    id: "alias-provenance-preview",
    title: "Live alias counts by current heuristic origin signal match the manifest baseline.",
    expected: manifest.expectations.aliasProvenancePreview,
    actual,
  });
}

async function dupGroups(client: pg.Client, manifest: ResolutionEvalManifest): Promise<AssertionResult> {
  const rows = await loadPendingDeferredRows(client);
  const pairs = await buildDupSuspectGroups(
    client,
    rows.map((row) => row.id),
  );
  const actual = { pairCount: pairs.length, pairs };
  return result({
    id: "dup-groups",
    title: "Employer-sharing candidate pairs match the duplicate-suspect docket.",
    expected: manifest.expectations.dupGroups,
    actual,
  });
}

async function collisionPersonSet(client: pg.Client, manifest: ResolutionEvalManifest): Promise<AssertionResult> {
  const entities = await loadLiveEntities(client);
  return result({
    id: "first-name-collision-people",
    title: "Live person entities in first-name collision groups match the manifest id set.",
    expected: manifest.sets.firstNameCollisionPersonEntityIds,
    actual: firstNameCollisionPersonIds(entities),
  });
}

export async function runBaselineAssertions(
  client: pg.Client,
  manifest: ResolutionEvalManifest,
): Promise<AssertionResult[]> {
  return [
    await corpusIntegrity(client, manifest),
    await queueCensus(client, manifest),
    await stalenessPreview(client, manifest),
    await adjacencyGroundTruth(client, manifest),
    await aliasPreview(client, manifest),
    await dupGroups(client, manifest),
    await collisionPersonSet(client, manifest),
  ];
}
