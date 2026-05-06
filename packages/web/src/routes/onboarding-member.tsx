import { OnboardingMemberChat } from "@/components/onboarding-v2/onboarding-member-chat";
import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";

/** Member onboarding entry point. Used when the org is already on Sketch and the user is joining as a teammate. */
export const onboardingMemberRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding/member",
  component: OnboardingMemberRoutePage,
});

function OnboardingMemberRoutePage() {
  return <OnboardingMemberChat />;
}
