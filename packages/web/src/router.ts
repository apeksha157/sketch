import { createRouter } from "@tanstack/react-router";
import { channelsRoute } from "./routes/channels";
import { connectionsCallbackRoute, connectionsRoute } from "./routes/connections";
import { dashboardRoute } from "./routes/dashboard";
import {
  channelsEmptyRoute,
  channelsMemberEmptyRoute,
  channelsMemberRoute,
  channelsPreviewRoute,
} from "./routes/demo/channels-demo";
import { filesEmptyRoute, filesPreviewRoute } from "./routes/demo/files-demo";
import {
  integrationsEmptyRoute,
  integrationsMemberEmptyRoute,
  integrationsMemberRoute,
  integrationsPreviewRoute,
} from "./routes/demo/integrations-demo";
import { previewRoute } from "./routes/demo/preview-route";
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
import { filesRoute } from "./routes/files";
import { indexRoute } from "./routes/index";
import { loginRoute } from "./routes/login";
import { onboardingRoute } from "./routes/onboarding";
import { onboardingMemberRoute } from "./routes/onboarding-member";
import { plansRoute } from "./routes/plans";
import { reviewEntitiesRoute } from "./routes/review-entities";
import { rootRoute } from "./routes/root";
import { scheduledTasksRoute } from "./routes/scheduled-tasks";
import { settingsRoute } from "./routes/settings";
import { builderSidecarRoute } from "./routes/sketch/builder-sidecar";
import { chatRoute } from "./routes/sketch/chat";
import { chatAutomationSidecarRoute } from "./routes/sketch/chat-automation-demo";
import { conversationsRoute } from "./routes/sketch/conversations";
import { homeAutomationFailedRoute } from "./routes/sketch/home-automation-failed";
import { homeChannelDisconnectedRoute } from "./routes/sketch/home-channel-disconnected";
import { homeCreditsLowRoute } from "./routes/sketch/home-credits-low";
import { homeDefaultRoute } from "./routes/sketch/home-default";
import { homeFamiliarRoute } from "./routes/sketch/home-familiar";
import { homeNewUserRoute } from "./routes/sketch/home-new-user";
import { homeOnboardingRoute } from "./routes/sketch/home-onboarding";
import { homeOnboardingV2Route } from "./routes/sketch/home-onboarding-v2";
import { homePaymentLapsedRoute } from "./routes/sketch/home-payment-lapsed";
import { homeTrialExpiredRoute } from "./routes/sketch/home-trial-expired";
import { homeWorkspacePausedRoute } from "./routes/sketch/home-workspace-paused";
import { sketchRoute } from "./routes/sketch/route";
import { scheduledTasksSketchRoute } from "./routes/sketch/scheduled-tasks-preview";
import { taskRedesignARoute } from "./routes/sketch/task-redesign/direction-a-unified";
import { taskRedesignBRoute } from "./routes/sketch/task-redesign/direction-b-split";
import { taskRedesignCRoute } from "./routes/sketch/task-redesign/direction-c-console";
import { skillsRoute } from "./routes/skills";
import { teamRoute } from "./routes/team";
import { usageRoute } from "./routes/usage";

const routeTree = rootRoute.addChildren([
  loginRoute,
  onboardingRoute,
  onboardingMemberRoute,
  indexRoute,
  dashboardRoute.addChildren([
    channelsRoute,
    teamRoute,
    scheduledTasksRoute,
    skillsRoute,
    filesRoute,
    reviewEntitiesRoute,
    connectionsRoute.addChildren([connectionsCallbackRoute]),
    usageRoute,
    settingsRoute,
    // Base pricing page — upgrade-CTA target for the kept lifecycle screens
    // (trial-expired, payment-lapsed, credits-low). The 15 /plans/* design
    // variants were dropped per the audit; only the canonical page is kept.
    plansRoute,
    // Design preview screens (mock data) — namespaced under /preview/* so they
    // never collide with the live production routes above.
    previewRoute.addChildren([
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
      filesPreviewRoute,
      filesEmptyRoute,
      usagePreviewRoute,
      usageEmptyRoute,
      usageMemberRoute,
      usageMemberEmptyRoute,
      integrationsPreviewRoute,
      integrationsEmptyRoute,
      integrationsMemberRoute,
      integrationsMemberEmptyRoute,
      workspacePreviewRoute,
      workspaceEmptyRoute,
    ]),
  ]),
  // ── Sketch v1 spec screens (design explorations, mock data) ────────────────
  sketchRoute.addChildren([
    homeOnboardingRoute,
    homeOnboardingV2Route,
    homeDefaultRoute,
    homeNewUserRoute,
    homeFamiliarRoute,
    homeCreditsLowRoute,
    homePaymentLapsedRoute,
    homeTrialExpiredRoute,
    homeWorkspacePausedRoute,
    homeAutomationFailedRoute,
    homeChannelDisconnectedRoute,
    chatRoute,
    chatAutomationSidecarRoute,
    builderSidecarRoute,
    conversationsRoute,
    scheduledTasksSketchRoute,
    taskRedesignARoute,
    taskRedesignBRoute,
    taskRedesignCRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
