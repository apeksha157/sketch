/**
 * /home/onboarding-concept-1-resume — re-entry surface for Concept 1
 * (Sketch-led chat) after the user has skipped or navigated away from the
 * setup conversation.
 *
 * Renders the normal home dashboard with two changes from /home/default:
 *
 *   1. A slim sticky banner at the top — "Sketch is waiting on you · 2 of 5
 *      done — Resume chat →" — clicking it returns to /home/onboarding-
 *      concept-1-mid (where they left off).
 *
 *   2. An extra "Getting set up with Sketch" entry at the top of the
 *      Recents list, so users who don't notice the banner still have a path
 *      back via their conversation history.
 *
 * Used to demonstrate that the user is never stranded — even after skipping
 * out, the affordance to resume is always one click away.
 */
import { HomePane } from "@/components/sketch/home-pane";
import { OnboardingResumeBanner } from "@/components/sketch/onboarding-resume-banner";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_FILES_EMPTY, MOCK_SETUP_DIGEST } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";

function HomeOnboardingConcept1ResumePage() {
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
      banner={<OnboardingResumeBanner variant="chat" doneCount={2} resumeHref="/home/onboarding-concept-1-mid" />}
    >
      <HomePane
        firstName={firstNameOf(auth)}
        recents={[
          {
            id: "onboarding-thread",
            title: "Getting set up with Sketch",
            channel: "web",
            occurredAt: new Date(Date.now() - 8 * 60_000).toISOString(),
          },
        ]}
        digest={MOCK_SETUP_DIGEST}
        subtitleOverride="Pick up where we left off — your setup chat is in Recents below."
        onSubmit={handleSubmit}
      />
    </SketchShell>
  );
}

export const homeOnboardingConcept1ResumeRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/onboarding-concept-1-resume",
  component: HomeOnboardingConcept1ResumePage,
});
