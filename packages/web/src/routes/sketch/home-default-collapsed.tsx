/**
 * /home/default-collapsed — §5.12. Demo route showing the collapsed sidebar.
 * In production this is a user preference, not a route.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_CREDITS, MOCK_RECENTS } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

function HomeDefaultCollapsedPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();

  function handleSubmit(_message: string) {
    void navigate({ to: "/chat/$conversationId", params: { conversationId: "active" } });
  }

  return (
    <SketchShell
      profile={{
        name: auth.displayName,
        isAdmin: auth.role === "admin",
        identifier: auth.displayIdentifier,
      }}
      orgName={auth.orgName}
      credits={MOCK_CREDITS}
      forceCollapsed
    >
      <HomePane firstName={firstNameOf(auth)} recents={MOCK_RECENTS} onSubmit={handleSubmit} />
    </SketchShell>
  );
}

export const homeDefaultCollapsedRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/default-collapsed",
  component: HomeDefaultCollapsedPage,
});
