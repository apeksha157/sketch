/**
 * Tests for the tagging module.
 *
 * Focuses on the quarter end-date calculation which had a bug where
 * [3, 6, 9, 12].includes(q * 3) was always true (q*3 is always in that list),
 * causing all quarters to be assigned "30" as the end day.
 *
 * Fixed to use a lookup table: { 3: "31", 6: "30", 9: "30", 12: "31" }
 * (March 31, June 30, September 30, December 31).
 */
import { describe, expect, it } from "vitest";
import { tagShortContent } from "./tagging";

describe("tagShortContent — quarter end-date calculation", () => {
  it("Q1 ends on March 31", () => {
    const result = tagShortContent("Q1 2025 results", "report.txt");
    const tf = result.timeframes.find((t) => t.context === "Q1 2025");
    expect(tf).toBeDefined();
    expect(tf?.endDate).toBe("2025-03-31");
  });

  it("Q2 ends on June 30", () => {
    const result = tagShortContent("Q2 2025 results", "report.txt");
    const tf = result.timeframes.find((t) => t.context === "Q2 2025");
    expect(tf).toBeDefined();
    expect(tf?.endDate).toBe("2025-06-30");
  });

  it("Q3 ends on September 30", () => {
    const result = tagShortContent("Q3 2025 results", "report.txt");
    const tf = result.timeframes.find((t) => t.context === "Q3 2025");
    expect(tf).toBeDefined();
    expect(tf?.endDate).toBe("2025-09-30");
  });

  it("Q4 ends on December 31", () => {
    const result = tagShortContent("Q4 2025 results", "report.txt");
    const tf = result.timeframes.find((t) => t.context === "Q4 2025");
    expect(tf).toBeDefined();
    expect(tf?.endDate).toBe("2025-12-31");
  });

  it("Q1 starts on January 1", () => {
    const result = tagShortContent("Q1 2024 planning", "doc.txt");
    const tf = result.timeframes.find((t) => t.context === "Q1 2024");
    expect(tf?.startDate).toBe("2024-01-01");
  });

  it("Q4 starts on October 1", () => {
    const result = tagShortContent("Q4 2024 review", "doc.txt");
    const tf = result.timeframes.find((t) => t.context === "Q4 2024");
    expect(tf?.startDate).toBe("2024-10-01");
  });
});
