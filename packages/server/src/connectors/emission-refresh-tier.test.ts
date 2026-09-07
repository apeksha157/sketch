import { describe, expect, it } from "vitest";
import { buildEmissionAnchor, emissionRefreshTier, parseEmissionAnchor } from "./emission-refresh-tier";

describe("emissionRefreshTier", () => {
  it("selects tier two for count, time, boundary revision, and shrink", () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    const previous = {
      firstMessageId: 10,
      messageCount: 12,
      emittedAt: "2026-07-17T11:30:00.000Z",
      enrichedMessageCount: 10,
      enrichedAt: "2026-07-17T11:30:00.000Z",
    };
    const base = {
      status: "open" as const,
      firstMessageId: 10,
      messageCount: 12,
      previous,
      refreshMessages: 5,
      refreshMaxMinutes: 120,
      now,
    };

    expect(emissionRefreshTier(base)).toBe("embeddings_only");
    expect(emissionRefreshTier({ ...base, messageCount: 15 })).toBe("full");
    expect(
      emissionRefreshTier({
        ...base,
        now: new Date("2026-07-17T14:00:00.000Z"),
      }),
    ).toBe("full");
    expect(emissionRefreshTier({ ...base, firstMessageId: 11 })).toBe("full");
    expect(emissionRefreshTier({ ...base, messageCount: 11 })).toBe("full");
    expect(emissionRefreshTier({ ...base, status: "closed" })).toBe("full");
  });

  it("refreshes fully when no anchor was recorded", () => {
    expect(
      emissionRefreshTier({
        status: "open",
        firstMessageId: 10,
        messageCount: 12,
        previous: null,
        refreshMessages: 5,
        refreshMaxMinutes: 120,
        now: new Date("2026-07-17T12:00:00.000Z"),
      }),
    ).toBe("full");
  });
});

describe("parseEmissionAnchor", () => {
  const anchor = {
    firstMessageId: 10,
    messageCount: 12,
    emittedAt: "2026-07-17T11:30:00.000Z",
    enrichedMessageCount: 10,
    enrichedAt: "2026-07-17T11:30:00.000Z",
  };

  it("reads a complete anchor", () => {
    expect(parseEmissionAnchor(JSON.stringify(anchor))).toEqual(anchor);
  });

  it("rejects absent, unreadable, incomplete, and unparseable-timestamp source meta", () => {
    expect(parseEmissionAnchor(null)).toBeNull();
    expect(parseEmissionAnchor("not json")).toBeNull();
    expect(parseEmissionAnchor(JSON.stringify({ ...anchor, enrichedMessageCount: undefined }))).toBeNull();
    expect(parseEmissionAnchor(JSON.stringify({ ...anchor, enrichedAt: "not a date" }))).toBeNull();
    expect(parseEmissionAnchor(JSON.stringify({ ...anchor, emittedAt: "not a date" }))).toBeNull();
  });
});

describe("buildEmissionAnchor", () => {
  const previous = {
    firstMessageId: 10,
    messageCount: 12,
    emittedAt: "2026-07-17T11:30:00.000Z",
    enrichedMessageCount: 10,
    enrichedAt: "2026-07-17T11:30:00.000Z",
  };

  it("stamps the emission as the enrichment on a full refresh", () => {
    expect(
      buildEmissionAnchor({
        firstMessageId: 10,
        messageCount: 14,
        emittedAt: "2026-07-17T12:00:00.000Z",
        refreshTier: "full",
        previous,
      }),
    ).toEqual({
      firstMessageId: 10,
      messageCount: 14,
      emittedAt: "2026-07-17T12:00:00.000Z",
      enrichedMessageCount: 14,
      enrichedAt: "2026-07-17T12:00:00.000Z",
    });
  });

  it("carries the previous enrichment forward on an embeddings-only refresh", () => {
    expect(
      buildEmissionAnchor({
        firstMessageId: 10,
        messageCount: 14,
        emittedAt: "2026-07-17T12:00:00.000Z",
        refreshTier: "embeddings_only",
        previous,
      }),
    ).toEqual({
      firstMessageId: 10,
      messageCount: 14,
      emittedAt: "2026-07-17T12:00:00.000Z",
      enrichedMessageCount: 10,
      enrichedAt: "2026-07-17T11:30:00.000Z",
    });
  });

  it("falls back to the current message count when no previous anchor exists", () => {
    expect(
      buildEmissionAnchor({
        firstMessageId: 10,
        messageCount: 14,
        emittedAt: "2026-07-17T12:00:00.000Z",
        refreshTier: "embeddings_only",
        previous: null,
      }),
    ).toEqual({
      firstMessageId: 10,
      messageCount: 14,
      emittedAt: "2026-07-17T12:00:00.000Z",
      enrichedMessageCount: 14,
      enrichedAt: "2026-07-17T12:00:00.000Z",
    });
  });
});
