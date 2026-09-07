import { isCanvasBlockedCliAppId, isCanvasBlockedCliComponentKey, managedCliIntegrationAppId } from "@sketch/shared";

export function isCanvasBlockedAppId(value: string): boolean {
  return isCanvasBlockedCliAppId(value);
}

export function isCanvasBlockedComponentKey(value: string): boolean {
  return isCanvasBlockedCliComponentKey(value);
}

export { managedCliIntegrationAppId };

export function isCanvasBlockedConnectionId(value: string): boolean {
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .some((segment) => isCanvasBlockedAppId(segment));
}

function isClickUpComponentKey(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  return ["clickup", "click-up", "click_up"].some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`) || normalized.startsWith(`${prefix}_`),
  );
}

export function canvasBlockedIntegrationMessage(componentKey?: string): string {
  if (componentKey && isClickUpComponentKey(componentKey)) {
    return "ClickUp actions and triggers are no longer available through Canvas. Use Sketch's managed ClickUp API; existing Canvas OAuth accounts remain available, and the separate ClickUp Files connector is unchanged.";
  }
  return "GitHub and Linear are managed by Sketch integrations. Connect them from Integrations instead of Canvas.";
}
