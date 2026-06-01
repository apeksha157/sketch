/**
 * Usage page already uses inline mock data — no API calls.
 * These routes exist for consistency so the /demo and /empty pattern works everywhere.
 */
import { UsagePage } from "@/routes/usage";
import { createRoute } from "@tanstack/react-router";
import { hideTrialBanner, setMemberRole } from "./mock-query-provider";
import { previewRoute } from "./preview-route";

export const usagePreviewRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/usage",
  beforeLoad: hideTrialBanner,
  component: UsagePage,
});

export const usageEmptyRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/usage/empty",
  beforeLoad: hideTrialBanner,
  component: UsagePage,
});

export const usageMemberRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/usage/member",
  beforeLoad: setMemberRole,
  component: UsagePage,
});

export const usageMemberEmptyRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/usage/member-empty",
  beforeLoad: setMemberRole,
  component: UsagePage,
});
