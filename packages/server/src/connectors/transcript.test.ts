import { describe, expect, it } from "vitest";
import { parseSlackChunkAttachments } from "./slack-chunk-messages";
import { parseAttachmentsJson } from "./transcript";

describe("parseAttachmentsJson", () => {
  it("extracts attachment count and the first available name", () => {
    expect(parseAttachmentsJson(null)).toEqual({ count: 0, firstName: null });
    expect(parseAttachmentsJson("[]")).toEqual({ count: 0, firstName: null });
    expect(parseAttachmentsJson("{}")).toEqual({ count: 0, firstName: null });
    expect(parseAttachmentsJson('[{"originalName":" roadmap.pdf "},{"name":"second.pdf"}]')).toEqual({
      count: 2,
      firstName: "roadmap.pdf",
    });
    expect(parseAttachmentsJson('[{"name":" brief.pdf "}]')).toEqual({ count: 1, firstName: "brief.pdf" });
  });

  it("preserves connector-specific malformed JSON handling", () => {
    expect(parseAttachmentsJson("{")).toEqual({ count: -1, firstName: null });
    expect(parseSlackChunkAttachments("{")).toEqual({ hasAttachments: false, firstName: null });
  });
});
