import { describe, expect, it, vi } from "vitest";
import { createGeminiGenerator } from "./gemini-generate";

const { constructorCalls } = vi.hoisted(() => ({ constructorCalls: [] as Array<Record<string, unknown>> }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    readonly models = {
      generateContent: vi.fn(async () => ({
        text: "ok",
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {},
      })),
    };
    constructor(options: Record<string, unknown>) {
      constructorCalls.push(options);
    }
  },
}));

describe("Gemini generation transport bound", () => {
  it("constructs the SDK client with a request timeout", async () => {
    const generator = createGeminiGenerator("key-a", { maxRpm: 60_000, maxRetries: 0, sleep: async () => {} });

    await expect(generator.generate("prompt")).resolves.toBe("ok");
    expect(constructorCalls).toEqual([expect.objectContaining({ apiKey: "key-a", httpOptions: { timeout: 60_000 } })]);
  });
});
