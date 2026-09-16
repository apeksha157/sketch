import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnrichmentGenerator } from "./enrichment-providers";
import { GeminiHttpError, resetGeminiControlsForTests, runGeminiRequest } from "./gemini-control";

const MONTHLY_SPENDING_CAP_BODY = JSON.stringify({
  error: {
    code: 429,
    message: "Your project has exceeded its monthly spending cap.",
    status: "RESOURCE_EXHAUSTED",
  },
});

describe("createEnrichmentGenerator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetGeminiControlsForTests();
  });

  it("routes a per-call model override directly to OpenRouter before Gemini", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const generator = createEnrichmentGenerator({
      geminiApiKey: "gemini-key",
      openRouterApiKey: "openrouter-key",
      logger: { warn: vi.fn() } as never,
    });

    await expect(
      generator?.generateJSON("Return JSON", {
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
        maxTokens: 1500,
      }),
    ).resolves.toEqual({ ok: true });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.max_tokens).toBe(1500);
  });
  it("warns when a model override is requested but no OpenRouter key is configured", async () => {
    const warn = vi.fn();
    const generator = createEnrichmentGenerator({
      geminiApiKey: "gemini-key",
      logger: { warn } as never,
    });

    await expect(generator?.generateJSON("Return JSON", { model: "gpt-5.6-luna" })).rejects.toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-luna" }),
      expect.stringContaining("OpenRouter API key"),
    );
  });

  it("does not warn when no model override was requested", async () => {
    const warn = vi.fn();
    const generator = createEnrichmentGenerator({
      geminiApiKey: "gemini-key",
      openRouterApiKey: "openrouter-key",
      logger: { warn } as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] } }] })),
    );

    await generator?.generateJSON("Return JSON", { model: null, reasoningEffort: "high" }).catch(() => undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to configured OpenRouter generation when Gemini is capped", async () => {
    resetGeminiControlsForTests();
    await expect(
      runGeminiRequest(
        "gemini-key",
        async () => {
          throw new GeminiHttpError(429, MONTHLY_SPENDING_CAP_BODY);
        },
        { maxRetries: 0, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(GeminiHttpError);

    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "fallback text" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const generator = createEnrichmentGenerator({
      geminiApiKey: "gemini-key",
      openRouterApiKey: "openrouter-key",
      logger: { warn: vi.fn() } as never,
    });

    await expect(generator?.generate("prompt")).resolves.toBe("fallback text");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("openrouter.ai");
  });
});
