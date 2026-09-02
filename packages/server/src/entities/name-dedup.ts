import { stripDomainSuffix, tokenizeName } from "./name-tokenize";

export type CandidateValueKind = "name" | "alias";

export interface CandidatePoolEntry {
  entityId: string;
  valueKind: CandidateValueKind;
  value: string;
}

interface IndexedCandidatePoolEntry extends CandidatePoolEntry {
  entryKey: string;
  fuzzyValue: string;
}

export interface CandidatePool {
  byStrictKey: Map<string, CandidatePoolEntry[]>;
  byTokenSetKey: Map<string, CandidatePoolEntry[]>;
  entriesByKey: Map<string, IndexedCandidatePoolEntry>;
  nextEntryId: number;
}

export interface DedupHit {
  entityId: string;
  score: number;
  valueKind: CandidateValueKind;
  value: string;
}

/**
 * One-edit matches on very short strings are mostly noise (`Sam`/`Sat`). The
 * measured typo pairs this rung exists for are all at least five characters.
 */
const MIN_EDIT_DISTANCE_LENGTH = 5;
const EDIT_DISTANCE_SCORE = 0.9;

export function normalizeStrict(name: string): string {
  return stripDomainSuffix(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Order-insensitive key: lowercase, strip non-alphanumerics to spaces, then
 * sort the tokens. `Ohoud Zitan` and `Zitan, Ohoud` both collapse to
 * `ohoud zitan`, catching the "Last, First" vs "First Last" permutation class
 * that {@link normalizeStrict} (order-preserving) misses.
 *
 * Returns `""` for fewer than two tokens. A single-token bag carries no
 * reordering signal, so keying it would over-collapse bare first names
 * (`Sanaa` vs an unrelated `Sanaa`). The caller treats `""` as "no key".
 */
export function normalizeTokenSet(name: string): string {
  const tokens = tokenizeName(name);
  if (tokens.length < 2) return "";
  return tokens.sort().join(" ");
}

export function normalizeFuzzy(name: string): string {
  return stripDomainSuffix(name)
    .toLowerCase()
    .replace(/[^a-z0-9'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildCandidatePool(entries: CandidatePoolEntry[]): CandidatePool {
  const pool: CandidatePool = {
    byStrictKey: new Map(),
    byTokenSetKey: new Map(),
    entriesByKey: new Map(),
    nextEntryId: 0,
  };
  addToCandidatePool(pool, entries);
  return pool;
}

export function addToCandidatePool(pool: CandidatePool, entries: CandidatePoolEntry[]): void {
  for (const indexed of indexEntries(entries, pool)) {
    const strictKey = normalizeStrict(indexed.value);
    if (strictKey) {
      const bucket = pool.byStrictKey.get(strictKey);
      if (bucket) bucket.push(indexed);
      else pool.byStrictKey.set(strictKey, [indexed]);
    }

    const tokenSetKey = normalizeTokenSet(indexed.value);
    if (tokenSetKey) {
      const bucket = pool.byTokenSetKey.get(tokenSetKey);
      if (bucket) bucket.push(indexed);
      else pool.byTokenSetKey.set(tokenSetKey, [indexed]);
    }

    pool.entriesByKey.set(indexed.entryKey, indexed);
  }
}

export function removeFromCandidatePool(pool: CandidatePool, entityId: string): void {
  for (const [key, bucket] of pool.byStrictKey) {
    const filtered = bucket.filter((entry) => entry.entityId !== entityId);
    if (filtered.length === 0) pool.byStrictKey.delete(key);
    else if (filtered.length !== bucket.length) pool.byStrictKey.set(key, filtered);
  }

  for (const [key, bucket] of pool.byTokenSetKey) {
    const filtered = bucket.filter((entry) => entry.entityId !== entityId);
    if (filtered.length === 0) pool.byTokenSetKey.delete(key);
    else if (filtered.length !== bucket.length) pool.byTokenSetKey.set(key, filtered);
  }

  for (const [entryKey, entry] of pool.entriesByKey) {
    if (entry.entityId === entityId) {
      pool.entriesByKey.delete(entryKey);
    }
  }
}

export function findStrictMatches(name: string, pool: CandidatePool): DedupHit[] {
  const matches = pool.byStrictKey.get(normalizeStrict(name)) ?? [];
  return dedupeEntityMatches(matches.map((entry) => ({ ...entry, score: 1 })));
}

/**
 * Order-insensitive matches: entities whose name/alias is a token-permutation
 * of `name` (e.g. `Zitan, Ohoud` against an existing `Ohoud Zitan`). Score 1 —
 * the token bag is identical — but unlike a strict match this is genuinely
 * ambiguous (a reorder vs two namesakes like `Li Wang` / `Wang Li`), so callers
 * must treat it as a recall candidate to adjudicate, not an auto-link.
 */
export function findTokenSetMatches(name: string, pool: CandidatePool): DedupHit[] {
  const key = normalizeTokenSet(name);
  if (!key) return [];
  const matches = pool.byTokenSetKey.get(key) ?? [];
  return dedupeEntityMatches(matches.map((entry) => ({ ...entry, score: 1 })));
}

/**
 * Emails and letterless values (phone numbers, numeric ids) are identity
 * values: a one-edit difference there means a different identity, not a typo.
 * Exact matching handles them elsewhere, so the rung skips them on both the
 * query and pool side — fuzzy normalization would otherwise turn
 * `jane@acme.com` into the name-like `jane acme`.
 */
function isEditDistanceComparable(rawValue: string, fuzzyValue: string): boolean {
  if (fuzzyValue.length < MIN_EDIT_DISTANCE_LENGTH) return false;
  if (rawValue.includes("@")) return false;
  return /[a-z]/.test(fuzzyValue);
}

export function findEditDistanceMatches(name: string, pool: CandidatePool): DedupHit[] {
  const query = normalizeFuzzy(name);
  if (!isEditDistanceComparable(name, query)) return [];
  const matches: DedupHit[] = [];
  for (const candidate of pool.entriesByKey.values()) {
    const value = candidate.fuzzyValue;
    if (!isEditDistanceComparable(candidate.value, value)) continue;
    if (Math.abs(query.length - value.length) > 1) continue;
    if (query === value) continue;
    if (isEditDistanceAtMostOne(query, value)) matches.push({ ...candidate, score: EDIT_DISTANCE_SCORE });
  }
  return dedupeEntityMatches(matches).sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId));
}

function indexEntries(entries: CandidatePoolEntry[], pool: CandidatePool): IndexedCandidatePoolEntry[] {
  return entries.map((entry) => ({
    ...entry,
    entryKey: `${entry.entityId}:${entry.valueKind}:${pool.nextEntryId++}`,
    fuzzyValue: normalizeFuzzy(entry.value),
  }));
}

function dedupeEntityMatches(matches: DedupHit[]): DedupHit[] {
  const byEntity = new Map<string, DedupHit>();
  for (const match of matches) {
    const clean = {
      entityId: match.entityId,
      score: match.score,
      valueKind: match.valueKind,
      value: match.value,
    };
    const existing = byEntity.get(match.entityId);
    if (!existing || match.score > existing.score) byEntity.set(match.entityId, clean);
  }
  return [...byEntity.values()];
}

function isEditDistanceAtMostOne(a: string, b: string): boolean {
  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  if (i < a.length || j < b.length) edits += 1;
  return edits <= 1;
}
