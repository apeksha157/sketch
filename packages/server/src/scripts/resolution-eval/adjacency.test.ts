import { describe, expect, it } from "vitest";
import { evaluateAdjacencyFixture } from "./adjacency";

describe("resolution eval adjacency simulation", () => {
  it("vetoes a single edge winner when a rival has co-mention history with the same context", () => {
    const result = evaluateAdjacencyFixture({
      persons: [
        { id: "person-a", name: "Vishal Sharma" },
        { id: "person-b", name: "Vishal Mehta" },
      ],
      edges: [{ sourceEntityId: "person-a", targetEntityId: "company-context" }],
      mentions: [
        { entityId: "person-a", indexedFileId: "file-current" },
        { entityId: "company-context", indexedFileId: "file-current" },
        { entityId: "person-b", indexedFileId: "file-prior" },
        { entityId: "company-context", indexedFileId: "file-prior" },
      ],
    });

    expect(result.modes.edgesOnly).toMatchObject({ trials: 2, linked: 2, correct: 1, wrong: 1 });
    expect(result.modes.edgeWinCoMentionVeto).toMatchObject({
      trials: 2,
      linked: 1,
      correct: 0,
      wrong: 1,
      abstainNoSignal: 1,
    });
    expect(result.modes.edgeWinCoMentionVeto.wrongLinks).toEqual([
      { fileId: "file-prior", token: "vishal", pickedEntityId: "person-a", truthEntityId: "person-b" },
    ]);
  });
});
