import { describe, expect, it } from "vitest";
import { type WhatsAppLlmChunkerKnobs, resolveWhatsAppLlmChunkerKnobs } from "./whatsapp-chunker";

describe("resolveWhatsAppLlmChunkerKnobs", () => {
  const group = {
    jid: "group@g.us",
    name: "Group",
    description: null,
    indexEnabled: true,
    sliceGapMinutes: null,
    sliceMaxAgeMinutes: null,
    sliceMaxMessages: null,
  };

  it("resolves group overrides before global defaults before built-in defaults", () => {
    const overrides = {
      chunkWindowMessages: 200,
      chunkWindowTokens: 6000,
      chunkMinMessages: 12,
      chunkTargetMessages: 35,
      chunkMaxMessages: 75,
      chunkMaxTokens: 1400,
      chunkTickMinutes: 45,
      chunkIdleCloseHours: 72,
      chunkProvisionalRefreshMessages: 20,
      chunkModel: "gpt-5.6-luna",
      chunkReasoningEffort: "medium" as const,
      chunkBurstThresholdMessages: 50,
      chunkTopicRegistryCap: 25,
      chunkGroupWorkerPool: 3,
    };
    const defaults: Partial<WhatsAppLlmChunkerKnobs> = {
      windowMessages: 210,
      windowTokens: 6500,
      minMessages: 11,
      targetMessages: 36,
      maxMessages: 76,
      maxTokens: 1450,
      tickMinutes: 40,
      idleCloseHours: 80,
      provisionalRefreshMessages: 18,
      model: "fallback-model",
      reasoningEffort: "low",
      burstThresholdMessages: 60,
      topicRegistryCap: 26,
      groupWorkerPool: 2,
    };

    expect(resolveWhatsAppLlmChunkerKnobs({ ...group, ...overrides }, defaults)).toEqual({
      windowMessages: 200,
      windowTokens: 6000,
      minMessages: 12,
      targetMessages: 35,
      maxMessages: 75,
      maxTokens: 1400,
      tickMinutes: 45,
      idleCloseHours: 72,
      provisionalRefreshMessages: 20,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      burstThresholdMessages: 50,
      topicRegistryCap: 25,
      groupWorkerPool: 3,
      maxWindowsPerRun: 4,
    });
    expect(resolveWhatsAppLlmChunkerKnobs(group, defaults)).toEqual({
      windowMessages: 210,
      windowTokens: 6500,
      minMessages: 11,
      targetMessages: 36,
      maxMessages: 76,
      maxTokens: 1450,
      tickMinutes: 40,
      idleCloseHours: 80,
      provisionalRefreshMessages: 18,
      model: "fallback-model",
      reasoningEffort: "low",
      burstThresholdMessages: 60,
      topicRegistryCap: 26,
      groupWorkerPool: 2,
      maxWindowsPerRun: 4,
    });
    expect(resolveWhatsAppLlmChunkerKnobs(group)).toEqual({
      windowMessages: 250,
      windowTokens: 7500,
      minMessages: 5,
      targetMessages: 40,
      maxMessages: 80,
      maxTokens: 1500,
      tickMinutes: 30,
      idleCloseHours: 96,
      provisionalRefreshMessages: 15,
      model: null,
      reasoningEffort: "high",
      burstThresholdMessages: null,
      topicRegistryCap: 30,
      groupWorkerPool: 4,
      maxWindowsPerRun: 4,
    });
  });
});
