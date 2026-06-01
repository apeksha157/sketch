/**
 * /home/workspace-paused — §5.9. Admin paused the workspace; the action is
 * informational (contact admin) rather than something the current user can fix,
 * so the banner uses a text link instead of a button.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { SketchShell } from "@/components/sketch/shell";
import { DangerBanner } from "@/components/sketch/top-banner";
import { MOCK_FILES, MOCK_RECENTS } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute } from "@tanstack/react-router";

function HomeWorkspacePausedPage() {
  const auth = useSketchAuth();

  function contactAdmin() {
    // Open admin contact — production may resolve to mailto or an in-app modal.
    window.location.href = "mailto:admin@example.com";
  }

  return (
    <SketchShell
      profile={{
        name: auth.displayName,
        isAdmin: auth.role === "admin",
        identifier: auth.displayIdentifier,
      }}
      orgName={auth.orgName}
      files={MOCK_FILES}
      paused
      banner={
        <DangerBanner
          message="Workspace paused by your admin — contact them to restore access."
          action={{ label: "Contact admin", onClick: contactAdmin }}
        />
      }
    >
      <HomePane firstName={firstNameOf(auth)} recents={MOCK_RECENTS} disabled />
    </SketchShell>
  );
}

export const homeWorkspacePausedRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/workspace-paused",
  component: HomeWorkspacePausedPage,
});
