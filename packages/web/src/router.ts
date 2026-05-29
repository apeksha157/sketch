import { createRouter } from "@tanstack/react-router";
import { connectionsCallbackRoute, connectionsPreviewRoute } from "./routes/connections";
import { dashboardRoute } from "./routes/dashboard";
import {
  channelsEmptyRoute,
  channelsMemberEmptyRoute,
  channelsMemberRoute,
  channelsPreviewRoute,
} from "./routes/demo/channels-demo";
import { filesEmptyRoute, filesPreviewRoute } from "./routes/demo/files-demo";
import {
  homeAdminLegacyRoute,
  homeCompleteRoute,
  homeEmptyRoute,
  homeMemberEmptyRoute,
  homeMemberErrorRoute,
  homeMemberOldEmptyRoute,
  homeMemberOldEmptyV2Route,
  homeMemberOldErrorsRoute,
  homeMemberOldIterationARoute,
  homeMemberOldRoute,
  homeMemberOldWalkthroughRoute,
  homeMemberRoute,
  homeMemberSparseRoute,
  homePreviewRoute,
} from "./routes/demo/home-demo";
import {
  integrationsEmptyRoute,
  integrationsMemberEmptyRoute,
  integrationsMemberRoute,
  integrationsPreviewRoute,
} from "./routes/demo/integrations-demo";
import {
  scheduledTasksEmptyRoute,
  scheduledTasksMemberEmptyRoute,
  scheduledTasksMemberRoute,
  scheduledTasksPreviewRoute,
} from "./routes/demo/scheduled-tasks-demo";
import {
  skillsEmptyRoute,
  skillsMemberEmptyRoute,
  skillsMemberRoute,
  skillsPreviewRoute,
} from "./routes/demo/skills-demo";
import { teamEmptyRoute, teamMemberEmptyRoute, teamMemberRoute, teamPreviewRoute } from "./routes/demo/team-demo";
import { usageEmptyRoute, usageMemberEmptyRoute, usageMemberRoute, usagePreviewRoute } from "./routes/demo/usage-demo";
import { workspaceEmptyRoute, workspacePreviewRoute } from "./routes/demo/workspace-demo";
import { indexRoute } from "./routes/index";
import { loginRoute } from "./routes/login";
import { loginErrorRoute } from "./routes/login-error";
import { loginMockRoute } from "./routes/login-mock";
import { onboardingRoute } from "./routes/onboarding";
import { onboardingMemberRoute } from "./routes/onboarding-member";
import {
  plansAdminBizLowRoute,
  plansAdminBizRoute,
  plansAdminStartupsLowRoute,
  plansAdminStartupsRoute,
  plansMemberBizRoute,
  plansMemberStartupsRoute,
  plansNewRoute,
  plansPromoAdminBizRoute,
  plansPromoAdminRoute,
  plansPromoExpiringBizRoute,
  plansPromoExpiringRoute,
  plansPromoMemberRoute,
  plansPromoNewRoute,
  plansRoute,
  plansTrialCelebrationRoute,
  plansTrialUrgencyRoute,
} from "./routes/plans";
import { rootRoute } from "./routes/root";
import { builderSidecarRoute } from "./routes/sketch/builder-sidecar";
import { chatRoute } from "./routes/sketch/chat";
import { chatAutomationSidecarRoute } from "./routes/sketch/chat-automation-demo";
import { conversationsRoute } from "./routes/sketch/conversations";
import { homeAutomationFailedRoute } from "./routes/sketch/home-automation-failed";
import { homeCelebrationRoute } from "./routes/sketch/home-celebration";
import { homeChannelDisconnectedRoute } from "./routes/sketch/home-channel-disconnected";
import { homeCreditsLowRoute } from "./routes/sketch/home-credits-low";
import { homeDefaultRoute } from "./routes/sketch/home-default";
import { homeFamiliarRoute } from "./routes/sketch/home-familiar";
import { homeNewUserRoute } from "./routes/sketch/home-new-user";
import { homeOnboardingRoute } from "./routes/sketch/home-onboarding";
import { homeOnboardingConcept1MidRoute, homeOnboardingConcept1Route } from "./routes/sketch/home-onboarding-concept-1";
import { homeOnboardingConcept1ResumeRoute } from "./routes/sketch/home-onboarding-concept-1-resume";
import { homeOnboardingConcept2MidRoute, homeOnboardingConcept2Route } from "./routes/sketch/home-onboarding-concept-2";
import { homeOnboardingConcept2ResumeRoute } from "./routes/sketch/home-onboarding-concept-2-resume";
import { homeOnboardingConcept3MidRoute, homeOnboardingConcept3Route } from "./routes/sketch/home-onboarding-concept-3";
import { homeOnboardingConcept3ResumeRoute } from "./routes/sketch/home-onboarding-concept-3-resume";
import { homePaymentLapsedRoute } from "./routes/sketch/home-payment-lapsed";
import { homeSetupRoute } from "./routes/sketch/home-setup";
import { homeTrialExpiredRoute } from "./routes/sketch/home-trial-expired";
import { homeWorkspacePausedRoute } from "./routes/sketch/home-workspace-paused";
import { sketchRoute } from "./routes/sketch/route";

const routeTree = rootRoute.addChildren([
  loginRoute,
  loginErrorRoute,
  loginMockRoute,
  onboardingRoute,
  onboardingMemberRoute,
  indexRoute,
  dashboardRoute.addChildren([
    homePreviewRoute,
    homeEmptyRoute,
    homeMemberRoute,
    homeMemberEmptyRoute,
    homeMemberErrorRoute,
    homeMemberSparseRoute,
    homeMemberOldRoute,
    homeMemberOldEmptyRoute,
    homeMemberOldEmptyV2Route,
    homeMemberOldWalkthroughRoute,
    homeMemberOldErrorsRoute,
    homeMemberOldIterationARoute,
    homeAdminLegacyRoute,
    homeCompleteRoute,
    channelsPreviewRoute,
    channelsEmptyRoute,
    channelsMemberRoute,
    channelsMemberEmptyRoute,
    teamPreviewRoute,
    teamEmptyRoute,
    teamMemberRoute,
    teamMemberEmptyRoute,
    scheduledTasksPreviewRoute,
    scheduledTasksEmptyRoute,
    scheduledTasksMemberRoute,
    scheduledTasksMemberEmptyRoute,
    skillsPreviewRoute,
    skillsEmptyRoute,
    skillsMemberRoute,
    skillsMemberEmptyRoute,
    usagePreviewRoute,
    usageEmptyRoute,
    usageMemberRoute,
    usageMemberEmptyRoute,
    filesPreviewRoute,
    filesEmptyRoute,
    workspacePreviewRoute,
    workspaceEmptyRoute,
    integrationsPreviewRoute.addChildren([connectionsCallbackRoute, connectionsPreviewRoute]),
    integrationsEmptyRoute,
    integrationsMemberRoute,
    integrationsMemberEmptyRoute,
    plansRoute,
    plansNewRoute,
    plansMemberStartupsRoute,
    plansAdminStartupsRoute,
    plansAdminStartupsLowRoute,
    plansMemberBizRoute,
    plansAdminBizRoute,
    plansAdminBizLowRoute,
    plansPromoNewRoute,
    plansPromoMemberRoute,
    plansPromoAdminRoute,
    plansPromoAdminBizRoute,
    plansPromoExpiringRoute,
    plansPromoExpiringBizRoute,
    plansTrialCelebrationRoute,
    plansTrialUrgencyRoute,
  ]),
  // ── Sketch v1 spec routes (the new primary surface) ────────────────────────
  sketchRoute.addChildren([
    homeSetupRoute,
    homeDefaultRoute,
    homeNewUserRoute,
    homeFamiliarRoute,
    homeChannelDisconnectedRoute,
    homeAutomationFailedRoute,
    homeCreditsLowRoute,
    homeTrialExpiredRoute,
    homePaymentLapsedRoute,
    homeWorkspacePausedRoute,
    homeCelebrationRoute,
    homeOnboardingConcept1Route,
    homeOnboardingConcept1MidRoute,
    homeOnboardingConcept1ResumeRoute,
    homeOnboardingConcept2Route,
    homeOnboardingConcept2MidRoute,
    homeOnboardingConcept2ResumeRoute,
    homeOnboardingConcept3Route,
    homeOnboardingConcept3MidRoute,
    homeOnboardingConcept3ResumeRoute,
    homeOnboardingRoute,
    chatRoute,
    chatAutomationSidecarRoute,
    builderSidecarRoute,
    conversationsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
