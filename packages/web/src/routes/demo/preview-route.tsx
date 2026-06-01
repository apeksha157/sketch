import { Outlet, createRoute } from "@tanstack/react-router";
import { dashboardRoute } from "../dashboard";

/**
 * Namespacing parent for Apeksha's mock-data preview screens. Sits under the
 * dashboard layout so the wrapped real page components still receive dashboard
 * auth/context, but mounts at `/preview/*` so it never collides with the live
 * production routes (`/channels`, `/team`, …).
 */
export const previewRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/preview",
  component: Outlet,
});
