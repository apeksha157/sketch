import { OnboardingChat } from "@/components/onboarding-v2";
import { type SetupStatus, api } from "@/lib/api";
import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  beforeLoad: async () => {
    // TODO: restore guard after onboarding dev
    // const status = await api.setup.status();
    // if (status.completed) {
    //   throw redirect({ to: "/channels" });
    // }
    return { setupStatus: { completed: false } as SetupStatus };
  },
  component: OnboardingRoutePage,
});

  return <OnboardingChat />;
}
