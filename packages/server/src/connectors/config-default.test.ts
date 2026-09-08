import { describe, expect, it } from "vitest";
import { configDefault, resolveChunkEngineKnobs } from "./config-default";

describe("resolveChunkEngineKnobs", () => {
  it("falls back to the Slack schema defaults when no env config is loaded", () => {
    expect(resolveChunkEngineKnobs("SLACK_CHUNK", undefined)).toEqual({
      windowMessages: configDefault("SLACK_CHUNK_WINDOW_MESSAGES"),
      windowTokens: configDefault("SLACK_CHUNK_WINDOW_TOKENS"),
      minMessages: configDefault("SLACK_CHUNK_MIN_MESSAGES"),
      targetMessages: configDefault("SLACK_CHUNK_TARGET_MESSAGES"),
      maxMessages: configDefault("SLACK_CHUNK_MAX_MESSAGES"),
      maxTokens: configDefault("SLACK_CHUNK_MAX_TOKENS"),
      tickMinutes: configDefault("SLACK_CHUNK_TICK_MINUTES"),
      idleCloseHours: configDefault("SLACK_CHUNK_IDLE_CLOSE_HOURS"),
      provisionalRefreshMessages: configDefault("SLACK_CHUNK_PROVISIONAL_REFRESH_MESSAGES"),
      model: configDefault("SLACK_CHUNK_MODEL"),
      reasoningEffort: configDefault("SLACK_CHUNK_REASONING_EFFORT"),
      burstThresholdMessages: configDefault("SLACK_CHUNK_BURST_THRESHOLD_MESSAGES"),
      topicRegistryCap: configDefault("SLACK_CHUNK_TOPIC_REGISTRY_CAP"),
      groupWorkerPool: configDefault("SLACK_CHUNK_CHANNEL_WORKER_POOL"),
      maxWindowsPerRun: configDefault("SLACK_CHUNK_MAX_WINDOWS_PER_RUN"),
    });
  });

  it("falls back to the WhatsApp schema defaults when no env config is loaded", () => {
    expect(resolveChunkEngineKnobs("WHATSAPP_CHUNK", {})).toEqual({
      windowMessages: configDefault("WHATSAPP_CHUNK_WINDOW_MESSAGES"),
      windowTokens: configDefault("WHATSAPP_CHUNK_WINDOW_TOKENS"),
      minMessages: configDefault("WHATSAPP_CHUNK_MIN_MESSAGES"),
      targetMessages: configDefault("WHATSAPP_CHUNK_TARGET_MESSAGES"),
      maxMessages: configDefault("WHATSAPP_CHUNK_MAX_MESSAGES"),
      maxTokens: configDefault("WHATSAPP_CHUNK_MAX_TOKENS"),
      tickMinutes: configDefault("WHATSAPP_CHUNK_TICK_MINUTES"),
      idleCloseHours: configDefault("WHATSAPP_CHUNK_IDLE_CLOSE_HOURS"),
      provisionalRefreshMessages: configDefault("WHATSAPP_CHUNK_PROVISIONAL_REFRESH_MESSAGES"),
      model: configDefault("WHATSAPP_CHUNK_MODEL"),
      reasoningEffort: configDefault("WHATSAPP_CHUNK_REASONING_EFFORT"),
      burstThresholdMessages: configDefault("WHATSAPP_CHUNK_BURST_THRESHOLD_MESSAGES"),
      topicRegistryCap: configDefault("WHATSAPP_CHUNK_TOPIC_REGISTRY_CAP"),
      groupWorkerPool: configDefault("WHATSAPP_CHUNK_GROUP_WORKER_POOL"),
      maxWindowsPerRun: configDefault("WHATSAPP_CHUNK_MAX_WINDOWS_PER_RUN"),
    });
  });

  it("prefers a Slack env value over the schema default", () => {
    const resolved = resolveChunkEngineKnobs("SLACK_CHUNK", {
      SLACK_CHUNK_MAX_MESSAGES: 33,
      SLACK_CHUNK_CHANNEL_WORKER_POOL: 7,
    });
    expect(resolved.maxMessages).toBe(33);
    expect(resolved.groupWorkerPool).toBe(7);
    expect(resolved.minMessages).toBe(configDefault("SLACK_CHUNK_MIN_MESSAGES"));
  });

  it("prefers a WhatsApp env value over the schema default", () => {
    const resolved = resolveChunkEngineKnobs("WHATSAPP_CHUNK", {
      WHATSAPP_CHUNK_MAX_MESSAGES: 33,
      WHATSAPP_CHUNK_GROUP_WORKER_POOL: 7,
    });
    expect(resolved.maxMessages).toBe(33);
    expect(resolved.groupWorkerPool).toBe(7);
    expect(resolved.minMessages).toBe(configDefault("WHATSAPP_CHUNK_MIN_MESSAGES"));
  });

  it("prefers a caller override over the env value", () => {
    const resolved = resolveChunkEngineKnobs("SLACK_CHUNK", { SLACK_CHUNK_MAX_MESSAGES: 33 }, { maxMessages: 44 });
    expect(resolved.maxMessages).toBe(44);
  });
});
