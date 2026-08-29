import type pg from "pg";

export interface DupSuspectPair {
  reviewId: string;
  employerEntityId: string;
  candidateEntityIds: [string, string];
}

interface ReviewCandidateRow {
  id: string;
  candidate_entity_id: string | null;
  candidate_entity_ids: string | null;
}

const EMPLOYER_RELATIONSHIP_TYPES = new Set(["works_at"]);

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function candidateEntityIds(row: ReviewCandidateRow): string[] {
  return [
    ...new Set(
      [row.candidate_entity_id, ...parseStringArray(row.candidate_entity_ids)].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  ].sort();
}

function pairwise(ids: string[]): Array<[string, string]> {
  const sorted = [...new Set(ids)].sort();
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      pairs.push([sorted[i], sorted[j]]);
    }
  }
  return pairs;
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket) bucket.add(value);
  else map.set(key, new Set([value]));
}

export async function buildDupSuspectGroups(client: pg.Client, reviewIds?: string[]): Promise<DupSuspectPair[]> {
  const valuesClause = reviewIds && reviewIds.length > 0 ? "and q.id = any($1::text[])" : "";
  const queryParams = reviewIds && reviewIds.length > 0 ? [reviewIds] : [];
  const { rows: reviews } = await client.query<ReviewCandidateRow>(
    `select q.id, q.candidate_entity_id, q.candidate_entity_ids
     from entity_review_queue q
     where q.status in ('pending', 'deferred')
       and q.entity_type = 'person'
       ${valuesClause}
     order by q.id`,
    queryParams,
  );

  const candidateIds = [...new Set(reviews.flatMap(candidateEntityIds))].sort();
  if (candidateIds.length === 0) return [];

  const { rows: relationRows } = await client.query<{
    source_entity_id: string;
    target_entity_id: string;
    relationship_type: string;
  }>(
    `select source_entity_id, target_entity_id, relationship_type
     from entity_relationships
     where valid_to is null
       and relationship_type = any($1::text[])
       and source_entity_id = any($2::text[])
     order by source_entity_id, target_entity_id`,
    [[...EMPLOYER_RELATIONSHIP_TYPES], candidateIds],
  );
  const employersByCandidate = new Map<string, Set<string>>();
  for (const row of relationRows) {
    addToSetMap(employersByCandidate, row.source_entity_id, row.target_entity_id);
  }

  const pairs: DupSuspectPair[] = [];
  const seen = new Set<string>();
  for (const review of reviews) {
    const ids = candidateEntityIds(review);
    if (ids.length < 2) continue;
    const candidatesByEmployer = new Map<string, string[]>();
    for (const candidateId of ids) {
      for (const employerId of employersByCandidate.get(candidateId) ?? []) {
        const bucket = candidatesByEmployer.get(employerId);
        if (bucket) bucket.push(candidateId);
        else candidatesByEmployer.set(employerId, [candidateId]);
      }
    }
    for (const [employerEntityId, employerCandidateIds] of candidatesByEmployer) {
      for (const candidatePair of pairwise(employerCandidateIds)) {
        const key = `${review.id}:${employerEntityId}:${candidatePair[0]}:${candidatePair[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ reviewId: review.id, employerEntityId, candidateEntityIds: candidatePair });
      }
    }
  }

  return pairs.sort(
    (a, b) =>
      a.reviewId.localeCompare(b.reviewId) ||
      a.employerEntityId.localeCompare(b.employerEntityId) ||
      a.candidateEntityIds[0].localeCompare(b.candidateEntityIds[0]) ||
      a.candidateEntityIds[1].localeCompare(b.candidateEntityIds[1]),
  );
}
