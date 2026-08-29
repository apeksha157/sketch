import { describe, expect, it } from "vitest";
import { buildEvalReport } from "./report";

describe("resolution eval report", () => {
  it("counts passing and failing assertions", () => {
    const report = buildEvalReport({
      database: "sketch_canvas_ai_eval",
      assertionSet: "baseline",
      manifestGeneratedAt: "2026-08-29T00:00:00.000Z",
      now: new Date("2026-08-29T01:00:00.000Z"),
      assertions: [
        { id: "pass", title: "pass", passed: true, expected: 1, actual: 1 },
        { id: "fail", title: "fail", passed: false, expected: 1, actual: 2 },
      ],
    });

    expect(report.summary).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(report.runId).toBe("2026-08-29T01-00-00-000Z");
  });
});
