import type { IntegrationConnection } from "@sketch/shared";

export function isNativeCanvasAppConnection(connection: IntegrationConnection): boolean {
  return connection.source === "canvas_user_secrets";
}

export function isOwnedOrPersonalAppConnection(connection: IntegrationConnection): boolean {
  return connection.source !== "canvas_user_secrets" || connection.isOwnedByViewer !== false;
}

export function isActiveOwnedAppConnection(connection: IntegrationConnection): boolean {
  return (
    isOwnedOrPersonalAppConnection(connection) &&
    connection.status === "active" &&
    connection.healthy !== false &&
    connection.canUse !== false
  );
}
