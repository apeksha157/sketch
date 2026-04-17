/**
 * Integrations/Connections page preview routes.
 * Seeds both the MCP servers list (includes a provider with type != null)
 * and the connections list so both the Applications and MCPs tabs populate.
 */
import { ConnectionsPage } from "@/routes/connections";
import { createRoute } from "@tanstack/react-router";
import { dashboardRoute } from "../dashboard";
import { MockQueryProvider, hideTrialBanner, setMemberRole } from "./mock-query-provider";

const now = new Date().toISOString();

const PROVIDER = {
  id: "provider-1",
  type: "canvas",
  slug: "canvas",
  displayName: "Canvas",
  url: "https://app.canvasx.ai/mcp",
  apiUrl: null,
  credentials: "",
  mode: "skill",
  createdAt: now,
  updatedAt: now,
};

const DEMO_SERVERS = [
  PROVIDER,
  {
    id: "mcp-1",
    type: null,
    slug: "notion-workspace",
    displayName: "Notion",
    url: "https://mcp.notion.com/sse",
    apiUrl: null,
    credentials: "",
    mode: "mcp",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "mcp-2",
    type: null,
    slug: "github-repos",
    displayName: "GitHub",
    url: "https://mcp.github.com/sse",
    apiUrl: null,
    credentials: "",
    mode: "mcp",
    createdAt: now,
    updatedAt: now,
  },
];

const DEMO_CONNECTIONS = [
  {
    id: "conn-1",
    providerId: "provider-1",
    appId: "hubspot",
    appName: "HubSpot",
    accountName: "team@acme.com",
    status: "active",
    createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    icon: "/logos/hubspot.png",
  },
  {
    id: "conn-2",
    providerId: "provider-1",
    appId: "slack",
    appName: "Slack",
    accountName: "Acme Workspace",
    status: "active",
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    icon: "/logos/slack-logo-icon.png",
  },
];

export const integrationsPreviewRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/integrations",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider
      mocks={[
        { queryKey: ["mcp-servers"], data: DEMO_SERVERS },
        { queryKey: ["connections", "provider-1"], data: DEMO_CONNECTIONS },
      ]}
    >
      <ConnectionsPage />
    </MockQueryProvider>
  ),
});

export const integrationsEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/integrations/empty",
  beforeLoad: hideTrialBanner,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["mcp-servers"], data: [] }]}>
      <ConnectionsPage />
    </MockQueryProvider>
  ),
});

export const integrationsMemberRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/integrations/member",
  beforeLoad: setMemberRole,
  component: () => (
    <MockQueryProvider
      mocks={[
        { queryKey: ["mcp-servers"], data: DEMO_SERVERS },
        { queryKey: ["connections", "provider-1"], data: DEMO_CONNECTIONS },
      ]}
    >
      <ConnectionsPage />
    </MockQueryProvider>
  ),
});

export const integrationsMemberEmptyRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/integrations/member-empty",
  beforeLoad: setMemberRole,
  component: () => (
    <MockQueryProvider mocks={[{ queryKey: ["mcp-servers"], data: [] }]}>
      <ConnectionsPage />
    </MockQueryProvider>
  ),
});
