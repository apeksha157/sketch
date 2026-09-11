import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiHttpError, resetGeminiControlsForTests } from "../gemini-control";
import { createGeminiEmbeddingProvider, createGeminiQueryEmbedder } from "./gemini";

const MONTHLY_SPENDING_CAP_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap. Learn more at https://ai.google.dev/gemini-api/docs/billing#project-spend-caps. ",
    status: "RESOURCE_EXHAUSTED",
  },
});

const FAST_OPTIONS = { maxRpm: 60_000, maxRetries: 4, sleep: async () => {} };

describe("Gemini embedding provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetGeminiControlsForTests();
  });

  it("makes one embedding network attempt for the monthly spending cap response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(MONTHLY_SPENDING_CAP_BODY, { status: 429 }));
    const provider = createGeminiEmbeddingProvider("key-a", FAST_OPTIONS);

    await expect(provider.embedTexts(["hello"])).rejects.toBeInstanceOf(GeminiHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("embedContent");
  });

  it("does not retry the cap response through the query embedder wrapper", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(MONTHLY_SPENDING_CAP_BODY, { status: 429 }));
    const embedQuery = createGeminiQueryEmbedder("key-a", FAST_OPTIONS);

    await expect(embedQuery("query")).rejects.toBeInstanceOf(GeminiHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
