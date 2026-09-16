import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiHttpError, GeminiUnavailableError, resetGeminiControlsForTests } from "../gemini-control";
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

  it("reaches the network once as the recovery probe after the cooldown", async () => {
    let now = 0;
    const options = { maxRpm: 60_000, maxRetries: 0, quotaIdentity: "q-embed", now: () => now, sleep: async () => {} };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(MONTHLY_SPENDING_CAP_BODY, { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embedding: { values: [0.1, 0.2] } }), { status: 200 }));
    const provider = createGeminiEmbeddingProvider("key-a", options);

    await expect(provider.embedTexts(["first"])).rejects.toBeInstanceOf(GeminiHttpError);

    now += 5 * 60 * 1000;
    fetchMock.mockClear();
    await expect(provider.embedTexts(["second"])).resolves.toEqual([[0.1, 0.2]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes no additional network attempt while the cap cooldown is active", async () => {
    let now = 0;
    const options = {
      maxRpm: 60_000,
      maxRetries: 4,
      quotaIdentity: "q-embed-cooling",
      now: () => now,
      sleep: async () => {},
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(MONTHLY_SPENDING_CAP_BODY, { status: 429 }));
    const embedQuery = createGeminiQueryEmbedder("key-a", options);

    await expect(embedQuery("first")).rejects.toBeInstanceOf(GeminiHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 60 * 1000;
    await expect(embedQuery("second")).rejects.toBeInstanceOf(GeminiUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
