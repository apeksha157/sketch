import { describe, expect, it } from "vitest";
import { freezeSelection, suiteFamilies, verdictFor } from "./contracts";
import { isMinuteSchedule } from "./core";

describe("core automation checks", () => {
  it("rejects schedules that happen to match one observed tick", () => {
    expect(isMinuteSchedule("interval", "60", "UTC")).toBe(true);
    expect(isMinuteSchedule("cron", "* * * * *", "Asia/Kolkata")).toBe(true);
    expect(isMinuteSchedule("cron", "*/2 * * * *", "UTC")).toBe(false);
    expect(isMinuteSchedule("cron", "* 12 * * *", "UTC")).toBe(false);
    expect(isMinuteSchedule("cron", "* * * * 1", "UTC")).toBe(false);
    expect(isMinuteSchedule("cron", "* * * 1,7 *", "UTC")).toBe(false);
    expect(isMinuteSchedule("interval", "120", "UTC")).toBe(false);
    expect(isMinuteSchedule("once", "2026-09-08", "UTC")).toBe(false);
  });
  it("cannot pass with manual execution or only authoring evidence", () => {
    expect(verdictFor("core_note", [{ id: "authoring", label: "saved", status: "passed", evidence: "exists" }])).toBe(
      "unverified",
    );
    expect(
      verdictFor("read_count", [{ id: "direct_agent", label: "agent", status: "passed", evidence: "claimed 3" }]),
    ).toBe("unverified");
  });
  it("supports ten balanced cases in each test area without crossing suites", () => {
    for (const suiteId of ["automation_core", "integrations", "automations"] as const) {
      const families = suiteFamilies[suiteId];
      const cases = Array.from({ length: 10 }, (_, index) => ({
        family: families[index % families.length],
        variant: Math.floor(index / families.length),
      }));
      expect(freezeSelection({ cases }, 10, suiteId)).toHaveLength(10);
      expect(() =>
        freezeSelection({ cases }, 10, suiteId === "automations" ? "automation_core" : "automations"),
      ).toThrow();
    }
  });
});
