import { type CliIntegrationAppId, managedCliIntegrationAppId } from "@sketch/shared";
import type { Logger } from "../logger";
import type { IntegrationProvider } from "./types";

const AVAILABILITY_TIMEOUT_MS = 3_000;

class ManagedIntegrationAvailabilityTimeoutError extends Error {
  constructor() {
    super("Managed integration availability lookup timed out");
    this.name = "ManagedIntegrationAvailabilityTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ManagedIntegrationAvailabilityTimeoutError()), AVAILABILITY_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Which managed Canvas OAuth integrations this user can use in this run. */
export async function listAvailableManagedIntegrations(params: {
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  userEmail: string;
  currentUserId: string;
  logger?: Pick<Logger, "warn">;
}): Promise<Set<CliIntegrationAppId>> {
  try {
    return await withTimeout(resolveAvailableManagedIntegrations(params));
  } catch (error) {
    params.logger?.warn(
      {
        event: "managed_integration_availability_failed",
        reason: error instanceof ManagedIntegrationAvailabilityTimeoutError ? "timeout" : "provider_error",
      },
      "Managed integration availability lookup failed closed",
    );
    return new Set();
  }
}

async function resolveAvailableManagedIntegrations(params: {
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  userEmail: string;
  currentUserId: string;
}): Promise<Set<CliIntegrationAppId>> {
  const provider = await params.loadIntegrationProvider();
  if (provider?.type !== "canvas" || !provider.providerId) return new Set();

  const connections = await provider.listConnections(params.userEmail, undefined, {
    workspaceId: provider.providerId,
    userId: params.currentUserId,
  });
  const available = new Set<CliIntegrationAppId>();
  for (const connection of connections) {
    const appId = managedCliIntegrationAppId(connection.appId);
    if (appId && connection.status === "active" && connection.canUse !== false && connection.healthy !== false) {
      available.add(appId);
    }
  }
  return available;
}
