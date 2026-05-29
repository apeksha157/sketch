/**
 * /home/onboarding-concept-3-resume — re-entry surface for Concept 3
 * (Show + Do split-screen) after the user has skipped or backed out of the
 * setup flow.
 *
 * Same shape as Concept 2's resume — slim sticky banner at the top of the
 * normal dashboard with progress + "Continue setup" CTA that returns the
 * user to /home/onboarding-concept-3-mid (their saved position in the
 * split-screen flow).
 *
 * The framing is identical to Concept 2 because both are "direct setup"
 * concepts (not chat-led) — the affordance reads the same way regardless of
 * whether setup happens in tiles or a split-screen modal.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { OnboardingResumeBanner } from "@/components/sketch/onboarding-resume-banner";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_FILES_EMPTY, MOCK_SETUP_DIGEST } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

function HomeOnboardingConcept3ResumePage() {
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
      banner={<OnboardingResumeBanner variant="setup" doneCount={2} resumeHref="/home/onboarding-concept-3-mid" />}
    >
      <HomePane
        firstName={firstNameOf(auth)}
        recents={[]}
        digest={MOCK_SETUP_DIGEST}
        hideRecentsWhenEmpty
        subtitleOverride="Setup is paused, not lost — pick it back up whenever."
        onSubmit={handleSubmit}
      />
    </SketchShell>
  );
}

export const homeOnboardingConcept3ResumeRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/onboarding-concept-3-resume",
  component: HomeOnboardingConcept3ResumePage,
});
