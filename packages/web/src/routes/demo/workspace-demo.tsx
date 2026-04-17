import { WorkspacePage } from "@/routes/workspace";
import { createRoute } from "@tanstack/react-router";
import { dashboardRoute } from "../dashboard";
import { MockQueryProvider, hideTrialBanner } from "./mock-query-provider";

const DEMO_FILES = {
  files: [
    { path: "CLAUDE.md", name: "CLAUDE.md", isDirectory: false },
    { path: "notes", name: "notes", isDirectory: true },
    { path: "templates", name: "templates", isDirectory: true },
    { path: "weekly-report.md", name: "weekly-report.md", isDirectory: false },
    { path: "meeting-notes.md", name: "meeting-notes.md", isDirectory: false },
    { path: "leads.csv", name: "leads.csv", isDirectory: false },
  ],
};

const EMPTY_FILES = { files: [] };

export const workspacePreviewRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/workspace",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["workspace", "workspace-files", "personal", "."], data: DEMO_FILES }]}>
      <WorkspacePage />
    </MockQueryProvider>
  ),
});

export const workspaceEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/workspace/empty",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["workspace", "workspace-files", "personal", "."], data: EMPTY_FILES }]}>
      <WorkspacePage />
    </MockQueryProvider>
  ),
});
