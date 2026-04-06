import { createRouter } from "@tanstack/react-router";
import { channelsRoute } from "./routes/channels";
import { connectionsCallbackRoute, connectionsRoute } from "./routes/connections";
import { dashboardRoute } from "./routes/dashboard";
import { filesRoute } from "./routes/files";
import { indexRoute } from "./routes/index";
import { loginRoute } from "./routes/login";
import { loginErrorRoute } from "./routes/login-error";
import { loginMockRoute } from "./routes/login-mock";
import { onboardingRoute } from "./routes/onboarding";
import {
  plansAdminBizLowRoute,
  plansAdminBizRoute,
  plansAdminTeamLowRoute,
  plansAdminTeamRoute,
  plansMemberBizLowRoute,
  plansMemberBizRoute,
  plansMemberTeamLowRoute,
  plansMemberTeamRoute,
  plansNewRoute,
  plansRoute,
} from "./routes/plans";
import { rootRoute } from "./routes/root";
import { scheduledTasksRoute } from "./routes/scheduled-tasks";
import { skillsRoute } from "./routes/skills";
import { teamRoute } from "./routes/team";
import { usageRoute } from "./routes/usage";
import { workspaceRoute } from "./routes/workspace";

const routeTree = rootRoute.addChildren([
  loginRoute,
  loginErrorRoute,
  loginMockRoute,
  onboardingRoute,
  plansNewRoute,
  plansMemberTeamRoute,
  plansMemberTeamLowRoute,
  plansAdminTeamRoute,
  plansAdminTeamLowRoute,
  plansMemberBizRoute,
  plansMemberBizLowRoute,
  plansAdminBizRoute,
  plansAdminBizLowRoute,
  indexRoute,
  dashboardRoute.addChildren([
    channelsRoute,
    teamRoute,
    scheduledTasksRoute,
    skillsRoute,
    usageRoute,
    filesRoute,
    workspaceRoute,
    plansRoute,
    connectionsRoute.addChildren([connectionsCallbackRoute]),
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
