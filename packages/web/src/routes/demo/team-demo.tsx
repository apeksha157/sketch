import { TeamPage } from "@/routes/team";
import { createRoute } from "@tanstack/react-router";
import { MockQueryProvider, hideTrialBanner, setMemberRole } from "./mock-query-provider";
import { previewRoute } from "./preview-route";

const now = new Date().toISOString();

const DEMO_DATA = {
  users: [
    {
      id: "u1",
      name: "Alex Chen",
      email: "alex@acme.com",
      email_verified_at: now,
      slack_user_id: "U01ABC",
      whatsapp_number: null,
      description: "CEO & Co-founder",
      type: "human",
      role: "admin",
      reports_to: null,
      created_at: now,
    },
    {
      id: "u2",
      name: "Sarah Kim",
      email: "sarah@acme.com",
      email_verified_at: now,
      slack_user_id: "U02DEF",
      whatsapp_number: "+1 (555) 234-5678",
      description: "Head of Product",
      type: "human",
      role: "admin",
      reports_to: "u1",
      created_at: now,
    },
    {
      id: "u3",
      name: "Jordan Lee",
      email: "jordan@acme.com",
      email_verified_at: now,
      slack_user_id: "U03GHI",
      whatsapp_number: null,
      description: "Senior Engineer",
      type: "human",
      role: "member",
      reports_to: "u1",
      created_at: now,
    },
    {
      id: "u4",
      name: "Priya Patel",
      email: "priya@acme.com",
      email_verified_at: now,
      slack_user_id: "U04JKL",
      whatsapp_number: null,
      description: "Marketing Lead",
      type: "human",
      role: "member",
      reports_to: "u2",
      created_at: now,
    },
    {
      id: "u5",
      name: "Research Agent",
      email: null,
      email_verified_at: null,
      slack_user_id: null,
      whatsapp_number: null,
      description: "Handles research queries and competitive analysis",
      type: "agent",
      role: null,
      reports_to: null,
      created_at: now,
    },
  ],
};

const EMPTY_DATA = { users: [] };

export const teamPreviewRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/team",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["users"], data: DEMO_DATA }]}>
      <TeamPage />
    </MockQueryProvider>
  ),
});

export const teamEmptyRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/team/empty",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["users"], data: EMPTY_DATA }]}>
      <TeamPage />
    </MockQueryProvider>
  ),
});

export const teamMemberRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/team/member",
  beforeLoad: setMemberRole,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["users"], data: DEMO_DATA }]}>
      <TeamPage />
    </MockQueryProvider>
  ),
});

export const teamMemberEmptyRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: "/team/member-empty",
  beforeLoad: setMemberRole,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["users"], data: EMPTY_DATA }]}>
      <TeamPage />
    </MockQueryProvider>
  ),
});
