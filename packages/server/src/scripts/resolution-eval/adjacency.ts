import type pg from "pg";

export interface AdjacencyPerson {
  id: string;
  name: string;
}

export interface AdjacencyMention {
  entityId: string;
  indexedFileId: string;
}

export interface AdjacencyEdge {
  sourceEntityId: string;
  targetEntityId: string;
}

export interface AdjacencyWrongLink {
  fileId: string;
  token: string;
  pickedEntityId: string;
  truthEntityId: string;
}

export interface AdjacencyTally {
  trials: number;
  linked: number;
  correct: number;
  wrong: number;
  abstainNoSignal: number;
  abstainAmbiguous: number;
  precision: number;
  coverage: number;
  wrongLinks: AdjacencyWrongLink[];
}

export interface AdjacencyEvaluation {
  modes: {
    edgesOnly: AdjacencyTally;
    edgesPlusCoMention: AdjacencyTally;
    edgeWinCoMentionVeto: AdjacencyTally;
  };
}

function firstToken(name: string): string {
  return name.trim().toLowerCase().split(/\s+/)[0] ?? "";
}

function emptyTally(): AdjacencyTally {
  return {
    trials: 0,
    linked: 0,
    correct: 0,
    wrong: 0,
    abstainNoSignal: 0,
    abstainAmbiguous: 0,
    precision: 0,
    coverage: 0,
    wrongLinks: [],
  };
}

function finalizeTally(tally: AdjacencyTally): AdjacencyTally {
  return {
    ...tally,
    precision: tally.linked === 0 ? 0 : tally.correct / tally.linked,
    coverage: tally.trials === 0 ? 0 : tally.linked / tally.trials,
  };
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket) bucket.add(value);
  else map.set(key, new Set([value]));
}

function hasEdge(candidateId: string, contextIds: Set<string>, edgeSet: Set<string>): boolean {
  for (const contextId of contextIds) {
    if (edgeSet.has(`${candidateId}:${contextId}`)) return true;
  }
  return false;
}

function coMentionCount(
  candidateId: string,
  contextIds: Set<string>,
  excludeFileId: string,
  entityFiles: Map<string, Set<string>>,
): number {
  const candidateFiles = entityFiles.get(candidateId);
  if (!candidateFiles) return 0;
  let hits = 0;
  for (const contextId of contextIds) {
    const contextFiles = entityFiles.get(contextId);
    if (!contextFiles) continue;
    const [small, large] =
      candidateFiles.size <= contextFiles.size ? [candidateFiles, contextFiles] : [contextFiles, candidateFiles];
    for (const fileId of small) {
      if (fileId !== excludeFileId && large.has(fileId)) {
        hits += 1;
        break;
      }
    }
  }
  return hits;
}

function scoreTrial(params: {
  mode: keyof AdjacencyEvaluation["modes"];
  candidateIds: string[];
  contextIds: Set<string>;
  fileId: string;
  edgeSet: Set<string>;
  entityFiles: Map<string, Set<string>>;
}): string[] {
  if (params.mode === "edgesOnly") {
    return params.candidateIds.filter((candidateId) => hasEdge(candidateId, params.contextIds, params.edgeSet));
  }

  if (params.mode === "edgesPlusCoMention") {
    return params.candidateIds.filter(
      (candidateId) =>
        hasEdge(candidateId, params.contextIds, params.edgeSet) ||
        coMentionCount(candidateId, params.contextIds, params.fileId, params.entityFiles) > 0,
    );
  }

  const edgeScored = params.candidateIds.filter((candidateId) =>
    hasEdge(candidateId, params.contextIds, params.edgeSet),
  );
  const rivalHasHistory =
    edgeScored.length === 1 &&
    params.candidateIds.some(
      (candidateId) =>
        candidateId !== edgeScored[0] &&
        coMentionCount(candidateId, params.contextIds, params.fileId, params.entityFiles) > 0,
    );
  return edgeScored.length === 1 && rivalHasHistory ? [] : edgeScored;
}

export function evaluateAdjacencyFixture(input: {
  persons: AdjacencyPerson[];
  mentions: AdjacencyMention[];
  edges: AdjacencyEdge[];
}): AdjacencyEvaluation {
  const personById = new Map(input.persons.map((person) => [person.id, person.name]));
  const groups = new Map<string, string[]>();
  for (const person of input.persons) {
    const token = firstToken(person.name);
    if (token.length < 3) continue;
    const bucket = groups.get(token);
    if (bucket) bucket.push(person.id);
    else groups.set(token, [person.id]);
  }
  const ambiguousGroups = new Map([...groups].filter(([, ids]) => ids.length >= 2));

  const edgeSet = new Set<string>();
  for (const edge of input.edges) {
    edgeSet.add(`${edge.sourceEntityId}:${edge.targetEntityId}`);
    edgeSet.add(`${edge.targetEntityId}:${edge.sourceEntityId}`);
  }

  const fileEntities = new Map<string, Set<string>>();
  const entityFiles = new Map<string, Set<string>>();
  for (const mention of input.mentions) {
    addToSetMap(fileEntities, mention.indexedFileId, mention.entityId);
    addToSetMap(entityFiles, mention.entityId, mention.indexedFileId);
  }

  const modes: AdjacencyEvaluation["modes"] = {
    edgesOnly: emptyTally(),
    edgesPlusCoMention: emptyTally(),
    edgeWinCoMentionVeto: emptyTally(),
  };

  for (const [fileId, entityIds] of fileEntities) {
    for (const truthEntityId of entityIds) {
      const truthName = personById.get(truthEntityId);
      if (!truthName) continue;
      const token = firstToken(truthName);
      const candidateIds = ambiguousGroups.get(token);
      if (!candidateIds || !candidateIds.includes(truthEntityId)) continue;
      const contextIds = new Set([...entityIds].filter((entityId) => !candidateIds.includes(entityId)));
      if (contextIds.size === 0) continue;

      for (const mode of Object.keys(modes) as Array<keyof AdjacencyEvaluation["modes"]>) {
        const tally = modes[mode];
        const scored = scoreTrial({ mode, candidateIds, contextIds, fileId, edgeSet, entityFiles });
        tally.trials += 1;
        if (scored.length === 1) {
          tally.linked += 1;
          if (scored[0] === truthEntityId) {
            tally.correct += 1;
          } else {
            tally.wrong += 1;
            tally.wrongLinks.push({ fileId, token, pickedEntityId: scored[0], truthEntityId });
          }
        } else if (scored.length === 0) {
          tally.abstainNoSignal += 1;
        } else {
          tally.abstainAmbiguous += 1;
        }
      }
    }
  }

  return {
    modes: {
      edgesOnly: finalizeTally(modes.edgesOnly),
      edgesPlusCoMention: finalizeTally(modes.edgesPlusCoMention),
      edgeWinCoMentionVeto: finalizeTally(modes.edgeWinCoMentionVeto),
    },
  };
}

export async function evaluateAdjacencyFromDatabase(client: pg.Client): Promise<AdjacencyEvaluation> {
  const { rows: persons } = await client.query<{ id: string; name: string }>(
    `select id, name
     from entities
     where deleted_at is null and merged_into_entity_id is null and source_type = 'person'
     order by id`,
  );
  const { rows: edges } = await client.query<{ source_entity_id: string; target_entity_id: string }>(
    `select source_entity_id, target_entity_id
     from entity_relationships
     where valid_to is null`,
  );
  const { rows: mentions } = await client.query<{ entity_id: string; indexed_file_id: string }>(
    `select distinct entity_id, indexed_file_id
     from entity_mentions
     order by indexed_file_id, entity_id`,
  );

  return evaluateAdjacencyFixture({
    persons,
    edges: edges.map((edge) => ({
      sourceEntityId: edge.source_entity_id,
      targetEntityId: edge.target_entity_id,
    })),
    mentions: mentions.map((mention) => ({
      entityId: mention.entity_id,
      indexedFileId: mention.indexed_file_id,
    })),
  });
}
