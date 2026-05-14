/**
 * /home/celebration — §5.10.
 *
 * Demo route for the once-ever celebration card. In production this state isn't
 * a separate route — it's a one-time overlay on /home/default that the celebration
 * card itself controls via user prefs. Here we render the card unconditionally
 * so the team can review it in isolation.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_CREDITS, MOCK_RECENTS } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

function HomeCelebrationPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);

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
      <HomePane
        firstName={firstNameOf(auth)}
        role={auth.role}
        recents={MOCK_RECENTS}
        onSubmit={handleSubmit}
        celebration={dismissed ? undefined : { onDismiss: () => setDismissed(true) }}
      />
    </SketchShell>
  );
}

export const homeCelebrationRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/celebration",
  component: HomeCelebrationPage,
});
