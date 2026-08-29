import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { DB } from "../db/schema";

export interface AdjacencySignals {
  hasEdge(candidateId: string, contextIds: ReadonlySet<string>): boolean;
  rivalCoMentionCount(candidateId: string, contextIds: ReadonlySet<string>, excludeFileId: string): number;
}

export type AdjacencyDecision =
  | { kind: "link"; winnerId: string }
  | { kind: "contested"; scoredIds: string[] }
  | { kind: "abstain"; vetoed: boolean };

/**
 * Implements the pinned T2 edge-wins rule exactly as measured by the eval
 * harness: current relationship edges are the only positive signal, while raw
 * other-file co-mentions are only a veto against a unique edge winner. The
 * co_mention sweep's `contributes_to` edges intentionally count as edge signal
 * here even though raw co-mentions also feed the veto; the validated numbers
 * were measured with that non-independence.
 */
export function decideAdjacency(
  candidateIds: readonly string[],
  contextIds: ReadonlySet<string>,
  currentFileId: string,
  signals: AdjacencySignals,
): AdjacencyDecision {
  const uniqueCandidateIds = [...new Set(candidateIds)];
  const edgeScored = uniqueCandidateIds.filter((candidateId) => signals.hasEdge(candidateId, contextIds));
  const rivalHasHistory =
    edgeScored.length === 1 &&
    uniqueCandidateIds.some(
      (candidateId) =>
        candidateId !== edgeScored[0] && signals.rivalCoMentionCount(candidateId, contextIds, currentFileId) > 0,
    );
  if (edgeScored.length === 1 && !rivalHasHistory) return { kind: "link", winnerId: edgeScored[0] };
  if (edgeScored.length >= 2) return { kind: "contested", scoredIds: edgeScored };
  return { kind: "abstain", vetoed: rivalHasHistory };
}

export async function loadAdjacencySignals(
  db: Kysely<DB>,
  candidateIds: readonly string[],
  contextIds: ReadonlySet<string>,
  currentFileId: string,
): Promise<AdjacencySignals> {
  const candidates = [...new Set(candidateIds)];
  const contexts = [...new Set(contextIds)];
  const edgeSet = new Set<string>();
  const coMentionsByCandidate = new Map<string, number>();
  if (candidates.length === 0 || contexts.length === 0) {
    return {
      hasEdge: () => false,
      rivalCoMentionCount: () => 0,
    };
  }

  const edgeRows = await db
    .selectFrom("entity_relationships")
    .select(["source_entity_id", "target_entity_id"])
    .where("valid_to", "is", null)
    .where((eb) =>
      eb.or([
        eb.and([eb("source_entity_id", "in", candidates), eb("target_entity_id", "in", contexts)]),
        eb.and([eb("source_entity_id", "in", contexts), eb("target_entity_id", "in", candidates)]),
      ]),
    )
    .execute();
  for (const row of edgeRows) {
    edgeSet.add(`${row.source_entity_id}:${row.target_entity_id}`);
    edgeSet.add(`${row.target_entity_id}:${row.source_entity_id}`);
  }

  const coMentionRows = await db
    .selectFrom("entity_mentions as candidate_mention")
    .innerJoin(
      "entity_mentions as context_mention",
      "context_mention.indexed_file_id",
      "candidate_mention.indexed_file_id",
    )
    .select([
      "candidate_mention.entity_id as candidateId",
      sql<number>`COUNT(DISTINCT candidate_mention.indexed_file_id)`.as("sharedFileCount"),
    ])
    .where("candidate_mention.entity_id", "in", candidates)
    .where("context_mention.entity_id", "in", contexts)
    .where("candidate_mention.indexed_file_id", "!=", currentFileId)
    .groupBy("candidate_mention.entity_id")
    .execute();
  for (const row of coMentionRows) coMentionsByCandidate.set(row.candidateId, Number(row.sharedFileCount));

  return {
    hasEdge: (candidateId, ids) => {
      for (const contextId of ids) {
        if (edgeSet.has(`${candidateId}:${contextId}`)) return true;
      }
      return false;
    },
    rivalCoMentionCount: (candidateId) => coMentionsByCandidate.get(candidateId) ?? 0,
  };
}
