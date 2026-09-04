import { type CliIntegrationAppId, managedCliIntegrationAppId } from "./cli-integrations";

export const managedIntegrationAppIds = ["github", "linear", "clickup"] as const;
export type ManagedIntegrationAppId = (typeof managedIntegrationAppIds)[number];

export function isClickUpApiKeyAppId(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return normalized === "clickup-api" || normalized === "clickup-api-key";
}

export function managedIntegrationAppId(value: string): ManagedIntegrationAppId | null {
  const managedCliAppId = managedCliIntegrationAppId(value);
  if (managedCliAppId) return managedCliAppId;

  const normalized = value.trim().toLowerCase();
  if (normalized === "clickup" || isClickUpApiKeyAppId(value)) {
    return "clickup";
  }
  return null;
}

export function managedIntegrationName(appId: ManagedIntegrationAppId | CliIntegrationAppId): string {
  if (appId === "github") return "GitHub";
  if (appId === "linear") return "Linear";
  return "ClickUp";
}
