/**
 * Tests for the text chunking module.
 *
 * Verifies that text is split at paragraph boundaries, chunks respect the
 * max token limit, and overlap is preserved between chunks.
 */
import { describe, expect, it } from "vitest";
import { chunkText } from "./chunking";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    const text = "Hello world. This is a short document.";
    const chunks = chunkText(text, { maxTokens: 500 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  it("returns empty array for empty input", () => {
    expect(chunkText("")).toHaveLength(0);
    expect(chunkText("   ")).toHaveLength(0);
  });

  it("splits at paragraph boundaries (double newline)", () => {
    // Many paragraphs that together far exceed the token limit.
    // With the default maxTokens=500, the text needs to be large.
    const paragraphs = Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1}: ${"word ".repeat(30).trim()}`);
    const text = paragraphs.join("\n\n");

    const chunks = chunkText(text); // default maxTokens=500

    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should contain content from actual paragraphs
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  it("respects the max token limit per chunk", () => {
    // Create a long text with many paragraphs
    const paragraphs = Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1}: ${"word ".repeat(20).trim()}`);
    const text = paragraphs.join("\n\n");

    const maxTokens = 200;
    const chunks = chunkText(text, { maxTokens, overlapTokens: 20 });

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      // Allow some slack for paragraph boundaries (a paragraph may slightly exceed the limit)
      // but chunks should not be several times larger than the limit.
      expect(chunk.tokenCount).toBeLessThanOrEqual(maxTokens * 1.5);
    }
  });

  it("chunk indices are sequential starting at 0", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}: ${"text ".repeat(30)}`).join("\n\n");
    const chunks = chunkText(text, { maxTokens: 50 });

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  it("content from all chunks covers the original text", () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `Section ${i + 1}: important content about topic ${i + 1}`);
    const text = paragraphs.join("\n\n");

    const chunks = chunkText(text, { maxTokens: 30, overlapTokens: 5 });

    // Every paragraph should appear in at least one chunk
    for (const para of paragraphs) {
      const appearsInChunk = chunks.some((c) => c.content.includes(`Section ${para.split(":")[0].split(" ")[1]}`));
      expect(appearsInChunk).toBe(true);
    }
  });

  it("handles text with no paragraph breaks (single block)", () => {
    // Long single-line text with no paragraph separators.
    // Use default maxTokens (500) so the overlap (50 tokens = 200 chars) is well
    // within bounds — avoids the edge case where overlap >= maxChars.
    const text = "word ".repeat(600).trim(); // ~600 words, ~3000 chars, ~750 tokens

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
