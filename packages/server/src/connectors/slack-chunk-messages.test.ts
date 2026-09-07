import { describe, expect, it } from "vitest";
import { type SlackChunkerMessage, isIndexableSlackChunkMessage } from "./slack-chunk-messages";

const T0 = Date.parse("2026-07-17T08:00:00.000Z");

function msg(overrides: Partial<SlackChunkerMessage> & { id: number }): SlackChunkerMessage {
  return {
    effectiveAt: new Date(T0 + overrides.id * 1000).toISOString(),
    text: `message ${overrides.id}`,
    attachments: null,
    isBot: false,
    addressedToSketch: false,
    ...overrides,
  };
}

describe("isIndexableSlackChunkMessage", () => {
  it("drops bot rows, Sketch chatter, placeholders, join/leave, and emoji-only", () => {
    expect(isIndexableSlackChunkMessage(msg({ id: 1, isBot: true }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 2, addressedToSketch: true }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 3, text: "   " }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 4, text: "See attached files." }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 5, text: "<@U0123ABC> has joined the channel" }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 6, text: "<@U0123ABC> has left the channel." }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 7, text: "👍" }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 8, text: ":thumbsup: 🎉" }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 9, text: "👍🏽 🇮🇳" }))).toBe(false);
  });

  it("keeps ordinary user messages, including ones that mention joining", () => {
    expect(isIndexableSlackChunkMessage(msg({ id: 1, text: "ship it 🚀" }))).toBe(true);
    expect(isIndexableSlackChunkMessage(msg({ id: 2, text: "Priya has joined the channel team today" }))).toBe(true);
  });

  it("keeps numeric-only replies despite digits being Unicode emoji components", () => {
    expect(isIndexableSlackChunkMessage(msg({ id: 1, text: "42" }))).toBe(true);
    expect(isIndexableSlackChunkMessage(msg({ id: 2, text: "2026" }))).toBe(true);
    expect(isIndexableSlackChunkMessage(msg({ id: 3, text: "#3" }))).toBe(true);
  });
});
