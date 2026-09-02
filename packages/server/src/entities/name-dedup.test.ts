import { describe, expect, it } from "vitest";
import {
  buildCandidatePool,
  findEditDistanceMatches,
  findStrictMatches,
  findTokenSetMatches,
  normalizeTokenSet,
  removeFromCandidatePool,
} from "./name-dedup";

describe("name-dedup", () => {
  it("strict-normalizes whitespace, casing, and punctuation", () => {
    const pool = buildCandidatePool([{ entityId: "redseer", valueKind: "name", value: "Redseer Consulting" }]);

    expect(findStrictMatches("RedseerConsulting", pool)).toEqual([
      { entityId: "redseer", score: 1, valueKind: "name", value: "Redseer Consulting" },
    ]);
    expect(findStrictMatches("REDSEER consulting", pool)).toEqual([
      { entityId: "redseer", score: 1, valueKind: "name", value: "Redseer Consulting" },
    ]);
    expect(findStrictMatches("Redseer  Consulting", pool)).toEqual([
      { entityId: "redseer", score: 1, valueKind: "name", value: "Redseer Consulting" },
    ]);
  });

  it("findEditDistanceMatches surfaces one-edit typos but skips exact, short, and identity values", () => {
    const pool = buildCandidatePool([
      { entityId: "akanksha", valueKind: "name", value: "Akanksha" },
      { entityId: "sami", valueKind: "name", value: "Sami" },
      { entityId: "iris", valueKind: "alias", value: "manual1@charlie.com" },
      { entityId: "phone", valueKind: "name", value: "+919867353742" },
    ]);

    expect(findEditDistanceMatches("Akansha", pool)).toEqual([
      { entityId: "akanksha", score: 0.9, valueKind: "name", value: "Akanksha" },
    ]);
    expect(findEditDistanceMatches("Akanksha", pool)).toEqual([]);
    expect(findEditDistanceMatches("Sani", pool)).toEqual([]);
    expect(findEditDistanceMatches("Manual Charlie", pool)).toEqual([]);
    expect(findEditDistanceMatches("manual0@charlie.com", pool)).toEqual([]);
    expect(findEditDistanceMatches("+919867353745", pool)).toEqual([]);
  });

  it("unifies a word-order permutation the strict key misses", () => {
    const pool = buildCandidatePool([{ entityId: "ohoud", valueKind: "name", value: "Ohoud Zitan" }]);

    expect(findStrictMatches("Zitan, Ohoud", pool)).toEqual([]);
    expect(findTokenSetMatches("Zitan, Ohoud", pool)).toEqual([
      { entityId: "ohoud", score: 1, valueKind: "name", value: "Ohoud Zitan" },
    ]);
  });

  it("does not key bare single-token names", () => {
    expect(normalizeTokenSet("Sanaa")).toBe("");
    const pool = buildCandidatePool([{ entityId: "sanaa-a", valueKind: "name", value: "Sanaa" }]);
    expect(findTokenSetMatches("Sanaa", pool)).toEqual([]);
  });

  it("prunes token-set buckets when an entity is removed", () => {
    const pool = buildCandidatePool([{ entityId: "ohoud", valueKind: "name", value: "Ohoud Zitan" }]);
    removeFromCandidatePool(pool, "ohoud");

    expect(findTokenSetMatches("Zitan, Ohoud", pool)).toEqual([]);
    expect(pool.byTokenSetKey.size).toBe(0);
  });
});
