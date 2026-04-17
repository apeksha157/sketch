import { AppSidebar } from "@/components/app-sidebar";
import { TrialBanner, TrialTicker } from "@/components/trial-banner";
import { api } from "@/lib/api";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@sketch/ui/components/sidebar";
import { Outlet, createRoute, useLocation, useRouteContext } from "@tanstack/react-router";
import { rootRoute } from "./root";

export interface AuthContext {
  role: "admin" | "member";
  email?: string;
  userId?: string;
  name?: string;
  displayName: string;
  displayIdentifier: string;
}

const MOCK_ADMIN: AuthContext = {
  role: "admin",
  displayName: "Admin",
  displayIdentifier: "admin@sketch.dev",
};

const MOCK_MEMBER: AuthContext = {
  role: "member",
  displayName: "Sarah Kim",
  displayIdentifier: "sarah@acme.com",
};

/** Returns mock auth context based on ?role= query param (defaults to admin). */
function getMockAuth(): AuthContext {
  const role = new URLSearchParams(window.location.search).get("role");
  return role === "member" ? MOCK_MEMBER : MOCK_ADMIN;
}

/**
 * Auth guard: tries real auth, falls back to mock admin context.
 * Every route works without login — mock context enables design/demo access.
 */
async function checkAuth(): Promise<{ auth: AuthContext }> {
  try {
    const status = await api.setup.status();
    if (!status.completed) return { auth: getMockAuth() };

    const session = await api.auth.session();
    if (!session.authenticated) return { auth: getMockAuth() };

    const role = session.role ?? "admin";

    return {
      auth: {
        role,
        email: session.email,
        userId: session.userId,
        name: session.name,
        displayName: role === "admin" ? "Admin" : (session.name ?? "Member"),
        displayIdentifier: session.email ?? session.name ?? "User",
      },
    };
  } catch {
    // API unreachable — fall back to mock context
    return { auth: getMockAuth() };
  }
}

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

function DashboardLayout() {
  const auth = useDashboardAuth();
  const location = useLocation();
  const isPlansPage = location.pathname === "/plans" || location.pathname.startsWith("/plans/");

  return (
    <SidebarProvider>
      <AppSidebar displayName={auth.displayName} displayIdentifier={auth.displayIdentifier} role={auth.role} />
      <SidebarInset>
        {/* Sticky top bar — sidebar trigger + ticker (hidden on plans) */}
        <div className="sticky top-0 z-20 flex items-center gap-3 bg-background px-3 py-2">
          <SidebarTrigger />
          {!isPlansPage && <TrialTicker />}
        </div>
        <main className="flex-1 overflow-auto">
          {isPlansPage && <TrialBanner />}
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
