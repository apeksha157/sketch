import type { IntegrationApp } from "@sketch/shared";

export interface ToolProgressIntegrationContext {
  apps: readonly IntegrationApp[];
  providerId?: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

function appMatches(value: string, app: IntegrationApp): boolean {
  const candidate = normalize(value);
  const id = normalize(app.id);
  const name = normalize(app.name);
  return candidate === id || candidate === name;
}

/** Resolve only against catalog identities already supplied by the run. */
export function resolveProgressIntegration(
  candidate: string | undefined,
  context: ToolProgressIntegrationContext | undefined,
): WebProgressIntegration | undefined {
  if (!candidate || !context) return undefined;
  const app = context.apps.find((entry) => appMatches(candidate, entry));
  if (!app) return undefined;
  return {
    providerId: context.providerId,
    appId: app.id,
    name: app.name,
    ...(app.icon ? { icon: app.icon } : {}),
  };
}

export interface WebProgressIntegration {
  providerId?: string;
  appId: string;
  name: string;
  icon?: string;
}

export function findProgressAppByComponentKey(
  componentKey: string | undefined,
  context: ToolProgressIntegrationContext | undefined,
): WebProgressIntegration | undefined {
  if (!componentKey || !context) return undefined;
  const normalizedKey = normalize(componentKey);
  /** Canvas component keys use the same longest exact app-slug convention as integration cards. */
  const candidates = normalizedKey.split("-");
  let app: IntegrationApp | undefined;
  for (let length = candidates.length; length > 0 && !app; length -= 1) {
    const candidate = candidates.slice(0, length).join("-");
    app = context.apps.find((entry) => normalize(entry.id) === candidate);
  }
  return app
    ? {
        providerId: context.providerId,
        appId: app.id,
        name: app.name,
        ...(app.icon ? { icon: app.icon } : {}),
      }
    : undefined;
}
