import type { CliIntegrationAppId } from "@sketch/shared";

export function isManagedIntegrationDisconnectedError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  return error.status === 403 || error.status === 404;
}

export function managedIntegrationReconnectMessage(integration: CliIntegrationAppId): string {
  const name = integration === "github" ? "GitHub" : "Linear";
  return `${name} isn't connected (or was disconnected). Reconnect it in Sketch Integrations.`;
}
