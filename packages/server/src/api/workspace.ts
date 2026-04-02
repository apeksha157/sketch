/**
 * Workspace API adapter
 * Thin adapter that wires up workspace routes to the main API
 */
import type { Config } from "../config";
import { workspaceRoutes } from "../workspace/routes";

interface WorkspaceApiDeps {
  config: Config;
}

export function createWorkspaceApi(deps: WorkspaceApiDeps) {
  return workspaceRoutes({ config: deps.config });
}
