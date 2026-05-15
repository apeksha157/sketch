/**
 * /home/setup — cycling demo route (§5.1).
 *
 * In production this path renders the appropriate step from workspace state.
 * For design review, clicking the banner advances through steps 1→2→3→4→5
 * and then loops back to 1, so the team can see every variant from a single URL.
 *
 * Dismissal behavior:
 *   - The top banner has an × affordance. Clicking it does NOT abandon setup —
 *     it collapses the banner and surfaces a persistent setup nudge in the
 *     sidebar so the user can still get back to the flow from any page.
 *
 * The sidebar deliberately has no credits card during setup (credits only
 * appear once setup is complete).
 *
 * NOTE on cross-page persistence:
 *   The banner currently lives on this route only. The sidebar nudge is the
 *   affordance that travels with the user once they navigate to /channels,
 *   /integrations, etc. Making the banner itself appear on every page would
 *   require lifting setup state into a context that SketchShell reads on
 *   every route — left as a follow-up since the nudge already covers that
 *   surface area.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { STEPS } from "@/components/sketch/setup-checklist";
import { SketchShell } from "@/components/sketch/shell";
import { SetupBanner, type SetupStep } from "@/components/sketch/top-banner";
import { MOCK_RECENTS, MOCK_SETUP_DIGEST } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

function HomeSetupPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<SetupStep>(1);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  function advance() {
    setStep((current) => (current === 5 ? 1 : ((current + 1) as SetupStep)));
  }

  function handleSubmit(_message: string) {
    void navigate({ to: "/chat/$conversationId", params: { conversationId: "active" } });
  }

  // Sidebar nudge label sourced from the canonical STEPS array (setup-
  // checklist.tsx) so banner + nudge can't drift on copy.
  const nudgeLabel = STEPS[step - 1].title;

  return (
    <SketchShell
      profile={{
        name: auth.displayName,
        isAdmin: auth.role === "admin",
        identifier: auth.displayIdentifier,
      }}
      orgName={auth.orgName}
      banner={
        bannerDismissed ? undefined : (
          <SetupBanner step={step} onAdvance={advance} onDismiss={() => setBannerDismissed(true)} />
        )
      }
      setupNudge={
        bannerDismissed
          ? {
              currentStep: step,
              nextLabel: nudgeLabel,
              href: "/home/setup",
            }
          : undefined
      }
    >
      {/* Setup state: recents likely empty for new workspaces, but seed with
          something so the layout reads correctly while still showing the
          "no conversations yet" empty state on step 1. */}
      <HomePane
        firstName={firstNameOf(auth)}
        recents={step >= 3 ? MOCK_RECENTS.slice(0, 2) : []}
        digest={MOCK_SETUP_DIGEST}
        // During setup the empty Recents header + "your conversations will
        // appear here" placeholder visually competes with the banner's
        // call-to-action. Suppress the whole section until the user has
        // any conversations; it reappears naturally from step 3 onward
        // when the demo seeds two MOCK_RECENTS.
        hideRecentsWhenEmpty
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
