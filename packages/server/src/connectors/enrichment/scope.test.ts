import { describe, expect, it } from "vitest";
import { parseLinkedinEnrichmentScope, resolveLinkedinChunkEngineEnabled } from "./scope";

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

describe("resolveLinkedinChunkEngineEnabled", () => {
  it("lets the connector's own switch win over the deployment default in both directions", () => {
    expect(resolveLinkedinChunkEngineEnabled({ scopeConfig: { chunkEngine: true }, envDefault: false })).toBe(true);
    expect(resolveLinkedinChunkEngineEnabled({ scopeConfig: { chunkEngine: false }, envDefault: true })).toBe(false);
  });

  it("falls back to the deployment default when the connector has never been switched", () => {
    expect(resolveLinkedinChunkEngineEnabled({ scopeConfig: {}, envDefault: true })).toBe(true);
    expect(resolveLinkedinChunkEngineEnabled({ scopeConfig: {}, envDefault: false })).toBe(false);
    expect(resolveLinkedinChunkEngineEnabled({ scopeConfig: null, envDefault: undefined })).toBe(false);
  });

  it("ignores a non-boolean stored value rather than treating it as on", () => {
    expect(resolveLinkedinChunkEngineEnabled({ scopeConfig: { chunkEngine: "true" }, envDefault: false })).toBe(false);
  });
});
