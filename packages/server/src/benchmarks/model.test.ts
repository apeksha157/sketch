import { describe, expect, it, vi } from "vitest";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { DesignConversation } from "./cases";
import { createBenchmarkModel } from "./model";

const proposedCase = {
  title: "Find my open work",
  integration: "clickup" as const,
  operation: "list" as const,
  prompt:
    "In {target}, find the open tasks whose names start with {marker}. Tell me their names, and leave everything unchanged.",
  facts: [],
  tags: ["clickup", "read"],
  selection: "open" as const,
  openCount: 3,
  closedCount: 2,
  expectedText: "Ready for review",
};

const conversation: DesignConversation = {
  id: "design-1",
  revision: 1,
  integration: "clickup",
  purpose: "starter",
  snapshot: null,
  messages: [],
  cases: [],
  createdAt: "2026-09-08T00:00:00.000Z",
};

function settingsRepository(): ReturnType<typeof createSettingsRepository> {
  return {
    get: async () => ({
      llm_provider: "openrouter",
      anthropic_api_key: "test-key",
      model_id: "test/model",
      aws_access_key_id: null,
      aws_secret_access_key: null,
      aws_region: null,
    }),
  } as ReturnType<typeof createSettingsRepository>;
}

describe("benchmark case designer", () => {
  it("uses validated structured output even when the provider text is truncated", async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: '{"message":"I prepared',
      output: {
        message: "I prepared a focused ClickUp check.",
        cases: [proposedCase],
      },
    });
    const model = createBenchmarkModel(settingsRepository(), { generateText });

    await expect(model.design(conversation, "Suggest useful tests", new AbortController().signal)).resolves.toEqual({
      message: "I prepared a focused ClickUp check.",
      cases: [proposedCase],
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.anything(),
        include: { requestBody: false, requestMessages: false, responseBody: false },
      }),
    );
    expect(JSON.parse(generateText.mock.calls[0][0].prompt)).not.toHaveProperty("schema");
  });
});
