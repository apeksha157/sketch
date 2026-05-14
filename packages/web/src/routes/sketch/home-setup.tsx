/**
 * /home/setup — cycling demo route (§5.1).
 *
 * In production this path renders the appropriate step from workspace state.
 * For design review, clicking the banner advances through steps 1→2→3→4→5
 * and then loops back to 1, so the team can see every variant from a single URL.
 *
 * The sidebar deliberately has no credits card during setup (credits only
 * appear once setup is complete).
 */
import { HomePane } from "@/components/sketch/home-pane";
import { SketchShell } from "@/components/sketch/shell";
import { SetupBanner, type SetupStep } from "@/components/sketch/top-banner";
import { MOCK_RECENTS } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

function HomeSetupPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<SetupStep>(1);

  function advance() {
    setStep((current) => (current === 5 ? 1 : ((current + 1) as SetupStep)));
  }

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
      banner={<SetupBanner step={step} onAdvance={advance} />}
    >
      {/* Setup state: recents likely empty for new workspaces, but seed with
          something so the layout reads correctly while still showing the
          "no conversations yet" empty state on step 1. */}
      <HomePane
        firstName={firstNameOf(auth)}
        recents={step >= 3 ? MOCK_RECENTS.slice(0, 2) : []}
        onSubmit={handleSubmit}
      />
    </SketchShell>
  );
}

export const homeSetupRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/setup",
  component: HomeSetupPage,
});
