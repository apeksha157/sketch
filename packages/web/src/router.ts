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
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
