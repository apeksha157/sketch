import { SketchSidebar } from "@/components/sketch/sidebar";
import { SidebarStateProvider } from "@/components/sketch/sidebar-context";
import { TrialBanner, TrialTicker } from "@/components/trial-banner";
import { type AuthContext, checkAuth } from "@/lib/auth";
import { MOCK_CREDITS } from "@/routes/sketch/mock-data";
import { Outlet, createRoute, useLocation, useRouteContext } from "@tanstack/react-router";
import { rootRoute } from "./root";

export type { AuthContext };

export function useDashboardAuth(): AuthContext {
  const { auth } = useRouteContext({ from: dashboardRoute.id }) as { auth: AuthContext };
  return auth;
}

export const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "dashboard",
  beforeLoad: async () => {
    return await checkAuth();
  },
  component: DashboardLayout,
});

/**
 * Dashboard layout — wraps every legacy route (/old/* and the surviving non-spec
 * routes like /channels, /skills, /team) in the same SketchSidebar that the new
 * spec routes use. Single sidebar across the whole product.
 *
 * The plans page keeps its trial banner; everything else just gets the ticker
 * inline at the top of the main pane.
 */
function DashboardLayout() {
  const auth = useDashboardAuth();
  const location = useLocation();
  const isPlansPage = location.pathname === "/plans" || location.pathname.startsWith("/plans/");

  return (
    <SidebarStateProvider>
      <div className="flex h-screen w-full bg-background text-foreground">
        <SketchSidebar
          profile={{
            name: auth.displayName,
            isAdmin: auth.role === "admin",
            identifier: auth.displayIdentifier,
          }}
          orgName={auth.orgName}
          credits={MOCK_CREDITS}
        />
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {!isPlansPage && (
            <div className="sticky top-0 z-20 bg-background px-3 py-2">
              <TrialTicker />
            </div>
          )}
          {/* Block-mode scroll container — using `flex flex-col` here makes
           * children with `mx-auto` shrink to content width. Routing back to a
           * normal block lets the existing page wrappers (max-w-4xl mx-auto)
           * fill the available column. */}
          <div className="relative min-h-0 flex-1 overflow-y-auto">
            {isPlansPage && <TrialBanner />}
            <Outlet />
          </div>
        </main>
      </div>
    </SidebarStateProvider>
  );
}
