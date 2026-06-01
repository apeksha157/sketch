/**
 * Sketch v1 parent route — namespace for all new spec routes (/home/*, /chat/*,
 * /conversations). Runs the same auth check as the legacy dashboardRoute so
 * design/demo access works with a mock context when the backend is unreachable.
 *
 * Pages composed under this route render their own SketchShell rather than
 * inheriting a layout from here; that lets exception/paused/celebration routes
 * vary the banner without coupling.
 */
import { type AuthContext, checkAuth } from "@/lib/auth";
import { Outlet, createRoute, useRouteContext } from "@tanstack/react-router";
import { rootRoute } from "../root";

export const sketchRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "sketch",
  beforeLoad: async () => await checkAuth(),
  component: () => <Outlet />,
});

export function useSketchAuth(): AuthContext {
  const ctx = useRouteContext({ from: sketchRoute.id }) as { auth: AuthContext };
  return ctx.auth;
}

/** Extracts the first name from displayName for the §4.3 greeting. */
export function firstNameOf(auth: AuthContext): string {
  const parts = auth.displayName.trim().split(/\s+/);
  return parts[0] || auth.displayName || "there";
}
