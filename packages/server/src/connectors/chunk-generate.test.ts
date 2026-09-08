import { describe, expect, it, vi } from "vitest";
import { createChunkGenerate } from "./chunk-generate";

describe("createChunkGenerate", () => {
  it("routes a chunk call with its model, reasoning effort, and label unchanged", async () => {
    const generate = vi.fn().mockResolvedValue("result");
    const chunkGenerate = createChunkGenerate({ generate });

    await expect(
      chunkGenerate?.("prompt", {
        model: "openai/gpt-5.6-luna",
        reasoningEffort: "high",
        maxTokens: 800,
        label: "whatsappLlmBoundary",
      }),
    ).resolves.toBe("result");
    expect(generate).toHaveBeenCalledWith("prompt", {
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "high",
      maxTokens: 800,
      label: "whatsappLlmBoundary",
    });
  });
});
