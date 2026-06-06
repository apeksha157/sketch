/**
 * /scheduled-tasks/list — prototype scheduled-tasks list under the mock-auth
 * `sketch` tree, so it renders frontend-only (no backend) with seeded mock data,
 * mirroring how the other sketch design screens behave.
 *
 * The real `/scheduled-tasks` page and its dashboard auth gate are untouched —
 * this is a separate door, so nothing changes for users running a real backend.
 */
import { SketchShell } from "@/components/sketch/shell";
import { MockQueryProvider } from "@/routes/demo/mock-query-provider";
import { DEMO_DATA } from "@/routes/demo/scheduled-tasks-demo";
import { ScheduledTasksPage } from "@/routes/scheduled-tasks";
import { MOCK_CREDITS, MOCK_FILES } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute } from "@tanstack/react-router";

function ScheduledTasksPreviewScreen() {
  const auth = useSketchAuth();
  return (
    <SketchShell
      profile={{ name: auth.displayName, isAdmin: auth.role === "admin", identifier: auth.displayIdentifier }}
      orgName={auth.orgName}
      credits={MOCK_CREDITS}
      files={MOCK_FILES}
    >
      <MockQueryProvider mocks={[{ queryKey: ["scheduled-tasks"], data: DEMO_DATA }]}>
        <ScheduledTasksPage />
      </MockQueryProvider>
    </SketchShell>
  );
}

export const scheduledTasksSketchRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/scheduled-tasks/list",
  component: ScheduledTasksPreviewScreen,
});
