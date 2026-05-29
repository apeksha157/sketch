/**
 * /home/onboarding-concept-2-resume — re-entry surface for Concept 2
 * (Tile dashboard) after the user has hit "Skip setup and explore the
 * dashboard."
 *
 * Renders the normal home dashboard with a slim sticky banner at the top —
 * "Finish setting up Sketch · 2 of 5 done — Continue setup →" — that returns
 * the user to /home/onboarding-concept-2-mid (the tile hub at their saved
 * progress).
 *
 * Used to show that skipping is non-destructive — the tile dashboard is one
 * banner click away whenever the user wants to come back to it.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { OnboardingResumeBanner } from "@/components/sketch/onboarding-resume-banner";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_FILES_EMPTY, MOCK_SETUP_DIGEST } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

function HomeOnboardingConcept2ResumePage() {
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
      files={MOCK_FILES_EMPTY}
      banner={<OnboardingResumeBanner variant="setup" doneCount={2} resumeHref="/home/onboarding-concept-2-mid" />}
    >
      <HomePane
        firstName={firstNameOf(auth)}
        recents={[]}
        digest={MOCK_SETUP_DIGEST}
        hideRecentsWhenEmpty
        subtitleOverride="Picking up where you left off — your tiles are saved."
        onSubmit={handleSubmit}
      />
    </SketchShell>
  );
}

export const homeOnboardingConcept2ResumeRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/onboarding-concept-2-resume",
  component: HomeOnboardingConcept2ResumePage,
});
