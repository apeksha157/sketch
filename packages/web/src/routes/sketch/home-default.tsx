/**
 * /home/default — the clean steady state (§5.2). Setup complete, credits card
 * visible in the sidebar, recents populated.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_CREDITS, MOCK_RECENTS } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

function HomeDefaultPage() {
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
    >
      <HomePane firstName={firstNameOf(auth)} role={auth.role} recents={MOCK_RECENTS} onSubmit={handleSubmit} />
    </SketchShell>
  );
}

export const homeDefaultRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/default",
  component: HomeDefaultPage,
});
