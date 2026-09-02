/**
 * extractSnippet contract: it is the exact check behind a broad SQL LIKE
 * pre-filter, so it must (1) cut a readable window around a case-insensitive
 * match, (2) return null when the name is absent or blank, and (3) not be
 * fooled by whitespace-heavy content.
 */
import { describe, expect, it } from "vitest";
import { extractSnippet } from "./evidence-snippets";

describe("extractSnippet", () => {
  it("cuts a word-bounded window around a case-insensitive match with ellipses", () => {
    const padding = "lorem ipsum dolor sit amet ".repeat(20);
    const content = `${padding}the ATLAS ROLLOUT ships after Diwali ${padding}`;
    const snippet = extractSnippet(content, "Atlas Rollout");
    expect(snippet).toBeTruthy();
    expect(snippet).toContain("ATLAS ROLLOUT ships after Diwali");
    expect(snippet?.startsWith("…")).toBe(true);
    expect(snippet?.endsWith("…")).toBe(true);
    expect((snippet ?? "").length).toBeLessThan(260);
  });

  it("returns null when the name is absent or blank", () => {
    expect(extractSnippet("no relevant text here", "Atlas Rollout")).toBeNull();
    expect(extractSnippet("anything", "   ")).toBeNull();
  });

  it("collapses newlines and repeated whitespace so snippets stay one line", () => {
    const content = "meeting notes\n\n\nAtlas Rollout\t\tis   on track\nnext topic";
    expect(extractSnippet(content, "atlas rollout")).toBe("meeting notes Atlas Rollout is on track next topic");
  });
});
