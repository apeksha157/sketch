import { describe, expect, it } from "vitest";
import { parseLinkedinEnrichmentScope } from "./scope";

describe("parseLinkedinEnrichmentScope", () => {
  it("turns auto-merge on for rows that never stored the key and keeps an explicit off", () => {
    expect(parseLinkedinEnrichmentScope({ enrichment: { enabled: true } })).toEqual({
      enabled: true,
      dailyCap: 25,
      batch: 50,
      autoMerge: true,
    });
    expect(parseLinkedinEnrichmentScope({ enrichment: { enabled: true, autoMerge: false } }).autoMerge).toBe(false);
    expect(parseLinkedinEnrichmentScope(undefined).enabled).toBe(false);
  });
});
