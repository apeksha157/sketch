import { describe, expect, it } from "vitest";
import { type LegacyCompareMention, type ReportLoopMention, alignMentions } from "./consolidated-loop-report";

function legacy(overrides: Partial<LegacyCompareMention> & Pick<LegacyCompareMention, "key" | "name" | "type">) {
  return { status: "none" as const, ...overrides };
}

describe("alignMentions", () => {
  it("classifies different targets, unresolved mentions, and ambiguous legacy reviews", () => {
    const legacyRows: LegacyCompareMention[] = [
      legacy({
        key: "sam\tperson",
        name: "Sam",
        type: "person",
        status: "ambiguous",
        entityIds: [],
        reviewIds: ["review-1", "review-2"],
      }),
      legacy({
        key: "acme\tcompany",
        name: "Acme",
        type: "company",
        status: "linked",
        entityId: "legacy-acme",
        entityName: "Acme Legacy",
      }),
      legacy({ key: "alex\tperson", name: "Alex", type: "person" }),
    ];
    const loopMentions: ReportLoopMention[] = [
      {
        mention: "Acme",
        type: "company",
        variations: [],
        resolution: { kind: "matched", entityId: "loop-acme" },
      },
      {
        mention: "Alex",
        type: "person",
        variations: [],
        resolution: { kind: "hold", reason: "no confident match", candidates: [] },
      },
      {
        mention: "Sam",
        type: "person",
        variations: [],
        resolution: { kind: "new", rejectedCandidates: ["rejected-sam"] },
      },
    ];

    const aligned = alignMentions(
      legacyRows,
      loopMentions,
      new Map([["rejected-sam", { name: "Rejected Sam", live: true }]]),
    );

    expect(aligned.map((row) => [row.key, row.verdict])).toEqual([
      ["acme\tcompany", "different_target"],
      ["alex\tperson", "both_unresolved"],
      ["sam\tperson", "indeterminate"],
    ]);
    expect(aligned[2].loop?.rejectedCandidates).toEqual([{ entityId: "rejected-sam", name: "Rejected Sam" }]);
  });
});
