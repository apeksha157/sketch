/**
 * Usage page already uses inline mock data — no API calls.
 * These routes exist for consistency so the /demo and /empty pattern works everywhere.
 */
import { UsagePage } from "@/routes/usage";
import { createRoute } from "@tanstack/react-router";
import { dashboardRoute } from "../dashboard";
import { hideTrialBanner, setMemberRole } from "./mock-query-provider";

export const usagePreviewRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/usage",
  beforeLoad: hideTrialBanner,
  component: UsagePage,
});

export const usageEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/usage/empty",
  beforeLoad: hideTrialBanner,
  component: UsagePage,
});

export const usageMemberRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/usage/member",
  beforeLoad: setMemberRole,
  component: UsagePage,
});

export const usageMemberEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/usage/member-empty",
  beforeLoad: setMemberRole,
  component: UsagePage,
});
