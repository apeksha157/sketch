import { type ManagedIntegrationAppId, managedIntegrationName } from "@sketch/shared";

export function isManagedIntegrationDisconnectedError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  return error.status === 403 || error.status === 404;
}

export function managedIntegrationReconnectMessage(integration: ManagedIntegrationAppId): string {
  return `${managedIntegrationName(integration)} isn't connected (or was disconnected). Reconnect it in Sketch Integrations.`;
}
