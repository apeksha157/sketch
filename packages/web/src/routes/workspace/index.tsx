import { dashboardRoute } from "@/routes/dashboard";
import { createRoute } from "@tanstack/react-router";
import { WorkspacePage } from "./workspace-page";

export { WorkspacePage };

export const workspaceRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/workspace",
  component: WorkspacePage,
});
