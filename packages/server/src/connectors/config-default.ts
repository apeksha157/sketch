import { type Config, configSchema } from "../config";
import type { ChunkEngineKnobs } from "./chunk-engine";

export function configDefault<Key extends keyof Config>(key: Key): Config[Key] {
  return configSchema.shape[key].parse(undefined) as Config[Key];
}

export type ChunkEngineKnobPrefix = "SLACK_CHUNK" | "WHATSAPP_CHUNK";

/**
 * Knob field to env key suffix. Both connectors expose the same engine knobs
 * under their own prefix, so one map keeps the two ladders from drifting.
 * `groupWorkerPool` is the single asymmetry: Slack's stream unit is a channel,
 * so its key says CHANNEL.
 */
const CHUNK_ENGINE_KNOB_KEY_SUFFIXES: Record<keyof ChunkEngineKnobs, string | Record<ChunkEngineKnobPrefix, string>> = {
  windowMessages: "WINDOW_MESSAGES",
  windowTokens: "WINDOW_TOKENS",
  minMessages: "MIN_MESSAGES",
  targetMessages: "TARGET_MESSAGES",
  maxMessages: "MAX_MESSAGES",
  maxTokens: "MAX_TOKENS",
  tickMinutes: "TICK_MINUTES",
  idleCloseHours: "IDLE_CLOSE_HOURS",
  provisionalRefreshMessages: "PROVISIONAL_REFRESH_MESSAGES",
  model: "MODEL",
  reasoningEffort: "REASONING_EFFORT",
  burstThresholdMessages: "BURST_THRESHOLD_MESSAGES",
  topicRegistryCap: "TOPIC_REGISTRY_CAP",
  groupWorkerPool: { SLACK_CHUNK: "CHANNEL_WORKER_POOL", WHATSAPP_CHUNK: "GROUP_WORKER_POOL" },
  maxWindowsPerRun: "MAX_WINDOWS_PER_RUN",
};

function chunkEngineKnobConfigKey(prefix: ChunkEngineKnobPrefix, field: keyof ChunkEngineKnobs): keyof Config {
  const suffix = CHUNK_ENGINE_KNOB_KEY_SUFFIXES[field];
  return `${prefix}_${typeof suffix === "string" ? suffix : suffix[prefix]}` as keyof Config;
}

/**
 * Resolves one connector's chunk engine knobs: caller override, then the
 * loaded env config, then the schema default. Knobs outside ChunkEngineKnobs
 * (thread floors, discovery paging, emission drain caps) stay on
 * `configDefault` directly rather than widening the shared shape.
 */
export function resolveChunkEngineKnobs(
  prefix: ChunkEngineKnobPrefix,
  appConfig: Partial<Config> | undefined,
  overrides: Partial<ChunkEngineKnobs> = {},
): ChunkEngineKnobs {
  const fields = Object.keys(CHUNK_ENGINE_KNOB_KEY_SUFFIXES) as (keyof ChunkEngineKnobs)[];
  const resolved = {} as Record<keyof ChunkEngineKnobs, unknown>;
  for (const field of fields) {
    const key = chunkEngineKnobConfigKey(prefix, field);
    resolved[field] = overrides[field] ?? appConfig?.[key] ?? configDefault(key);
  }
  return resolved as ChunkEngineKnobs;
}
