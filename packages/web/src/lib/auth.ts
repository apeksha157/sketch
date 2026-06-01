import { api } from "@/lib/api";

export interface AuthContext {
  role: "admin" | "member";
  email?: string;
  userId?: string;
  name?: string;
  displayName: string;
  displayIdentifier: string;
  /** Workspace / organisation name — surfaced in the sidebar brand row. */
  orgName: string;
}

const MOCK_ADMIN: AuthContext = {
  role: "admin",
  displayName: "Apeksha",
  displayIdentifier: "ops@canvasx.ai",
  orgName: "CanvasX",
};

const MOCK_MEMBER: AuthContext = {
  role: "member",
  displayName: "Sarah Kim",
  displayIdentifier: "sarah@acme.com",
  orgName: "Acme",
};

/**
 * Best-effort org name from an email's domain — drops the TLD and title-cases
 * the rest. "ops@canvasx.ai" → "Canvasx"; "sarah@acme.com" → "Acme".
 */
function orgFromEmail(email: string | undefined): string {
  if (!email) return "Workspace";
  const host = email.split("@")[1] ?? "";
  const root = host.split(".")[0] ?? "";
  if (!root) return "Workspace";
  return root[0].toUpperCase() + root.slice(1);
}

function getMockAuth(): AuthContext {
  const role = new URLSearchParams(window.location.search).get("role");
  return role === "member" ? MOCK_MEMBER : MOCK_ADMIN;
}

/**
 * Tries real auth, falls back to a mock context so design/demo routes work
 * without a live backend. Used by both the legacy dashboardRoute and the
 * new sketchRoute.
 */
export async function checkAuth(): Promise<{ auth: AuthContext }> {
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
        displayName: session.name ?? (role === "admin" ? "Admin" : "Member"),
        displayIdentifier: session.email ?? session.name ?? "User",
        orgName: orgFromEmail(session.email),
      },
    };
  } catch {
    return { auth: getMockAuth() };
  }
}
