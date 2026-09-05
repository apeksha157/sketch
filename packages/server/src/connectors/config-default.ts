import { type Config, configSchema } from "../config";

export function configDefault<Key extends keyof Config>(key: Key): Config[Key] {
  return configSchema.shape[key].parse(undefined) as Config[Key];
}
