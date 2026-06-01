import type { AuthMethod, DetectionResult } from "./types";

const MOCK_PERSONAS = {
  admin: {
    isCompanyEmail: true,
    workspaceExists: false,
    accountExists: false,
    workspaceReady: false,
    role: "admin" as const,
  },
  member: {
    isCompanyEmail: true,
    workspaceExists: true,
    accountExists: false,
    workspaceReady: true,
    role: "member" as const,
  },
  "generic-email": {
    isCompanyEmail: false,
    workspaceExists: false,
    accountExists: false,
    workspaceReady: false,
    role: null,
  },
  "already-registered": {
    isCompanyEmail: true,
    workspaceExists: true,
    accountExists: true,
    workspaceReady: true,
    role: "member" as const,
  },
  "workspace-not-ready": {
    isCompanyEmail: true,
    workspaceExists: true,
    accountExists: false,
    workspaceReady: false,
    role: "member" as const,
  },
} as const;

export const MOCK_WORKSPACE = {
  slack: {
    name: "Canvas AI",
    members: 4,
    channels: 12,
    email: "apeksha@canvas.ai",
    role: "Admin",
  },
  google: {
    name: "Canvas AI",
    members: 1,
    channels: 0,
    email: "apeksha@canvas.ai",
    role: "Admin",
  },
};

export const MOCK_USER = {
  name: "Apeksha",
  email: "apeksha@canvas.ai",
  adminEmail: "admin@canvas.ai",
};

type MockPersonaKey = keyof typeof MOCK_PERSONAS;

/** Returns mock persona from URL params, or null if not in mock mode. Only active in dev. */
export function getMockPersona(): MockPersonaKey | null {
  if (import.meta.env.PROD) return null;
  const params = new URLSearchParams(window.location.search);
  const mock = params.get("mock");
  return mock && mock in MOCK_PERSONAS ? (mock as MockPersonaKey) : null;
}

/** Simulate the post-auth detection checks using mock data. */
export function getMockDetectionResult(_authMethod: AuthMethod): DetectionResult | null {
  const persona = getMockPersona();
  if (!persona) return null;

  const data = MOCK_PERSONAS[persona];
  return {
    ...data,
    userName: MOCK_USER.name,
    adminEmail: MOCK_USER.adminEmail,
  };
}
