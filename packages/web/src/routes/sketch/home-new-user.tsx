/**
 * /home/new-user — the empty-state demo of /home/default.
 *
 * Represents stage 1 of the user lifecycle: just signed up, nothing
 * configured, no recents. The Workspace tiles surface encouragement copy
 * ("Set one up →") instead of metrics ("5 running"), and Recents is hidden
 * so the empty state doesn't show a placeholder where nothing belongs.
 *
 * No setup banner (that's `/home/setup`'s job — guided checklist). This
 * route shows what /home/default looks like *after* setup is dismissed but
 * before the user has built anything yet.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { SketchShell } from "@/components/sketch/shell";
import { NEW_USER_TILES } from "@/components/sketch/tile-grid";
import { MOCK_CREDITS, MOCK_FILES } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

/** Digest for a fresh workspace — no history, encouraging tone. */
const NEW_USER_DIGEST = {
  daysActive: 0,
  tasksRanToday: 0,
  hoursSavedThisWeek: 0,
  runningNow: 0,
  scheduledToday: 0,
};

function HomeNewUserPage() {
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
      files={MOCK_FILES}
    >
      <HomePane
        firstName={firstNameOf(auth)}
        recents={[]}
        digest={NEW_USER_DIGEST}
        tiles={NEW_USER_TILES}
        workspaceHeading="Get started"
        hideRecentsWhenEmpty
        onSubmit={handleSubmit}
      />
    </SketchShell>
  );
}

export const homeNewUserRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/new-user",
  component: HomeNewUserPage,
});
