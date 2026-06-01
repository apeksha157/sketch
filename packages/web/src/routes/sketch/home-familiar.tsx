/**
 * /home/familiar — the lifecycle stage 2 demo.
 *
 * User has been on Sketch a few weeks: one skill built, two automations
 * running, a handful of integrations wired up. Workspace tiles show real
 * metrics (smaller numbers than power-user, but real). Recents shows a
 * trimmed set so the section reads as "you're getting going" rather than
 * "you've been here forever."
 */
import { HomePane } from "@/components/sketch/home-pane";
import { SketchShell } from "@/components/sketch/shell";
import { FAMILIAR_USER_TILES } from "@/components/sketch/tile-grid";
import { MOCK_CREDITS, MOCK_FILES, MOCK_RECENTS } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

/** Digest for week-2 territory — early traction, not yet at autopilot. */
const FAMILIAR_USER_DIGEST = {
  daysActive: 12,
  tasksRanToday: 1,
  nextScheduledLabel: "4:00 PM",
  hoursSavedThisWeek: 1,
  runningNow: 1,
  scheduledToday: 1,
};

function HomeFamiliarPage() {
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
        recents={MOCK_RECENTS.slice(0, 3)}
        digest={FAMILIAR_USER_DIGEST}
        tiles={FAMILIAR_USER_TILES}
        onSubmit={handleSubmit}
      />
    </SketchShell>
  );
}

export const homeFamiliarRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/familiar",
  component: HomeFamiliarPage,
});
