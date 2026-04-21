/**
 * Connections page -- manage MCP servers and per-user integrations.
 *
 * Two sections:
 *  1. Integrations -- shown when an integration provider (MCP server with non-null type) exists.
 *     Members see their connected apps and can add/disconnect. Admins see the section header as read-only.
 *  2. MCP Servers -- always visible for admins. CRUD for workspace-level MCP servers.
 *
 * Component implementations live in @/components/connections/*.
 */
import { AddIntegrationDialog } from "@/components/connections/add-integration-dialog";
import { AddMcpDialog } from "@/components/connections/add-mcp-dialog";
import { AddProviderDialog, ProviderSelectorDialog } from "@/components/connections/add-provider-dialog";
import { EditMcpDialog } from "@/components/connections/edit-mcp-dialog";
import { EditProviderDialog } from "@/components/connections/edit-provider-dialog";
import { IntegrationsSection } from "@/components/connections/integrations-section";
import { McpServersSection } from "@/components/connections/mcp-servers-section";
import { RemoveMcpDialog } from "@/components/connections/remove-mcp-dialog";
import { LoadingSkeleton } from "@/components/connections/shared";
import { api } from "@/lib/api";
import { useDashboardAuth } from "@/routes/dashboard";
import { PlugIcon, PlusIcon } from "@phosphor-icons/react";
import type { IntegrationConnection, McpServerRecord } from "@sketch/shared";
import { cn } from "@sketch/ui";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { dashboardRoute } from "./dashboard";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const connectionsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/integrations",
  component: ConnectionsPage,
});

export const connectionsCallbackRoute = createRoute({
  getParentRoute: () => connectionsRoute,
  path: "/callback",
  component: ConnectionsCallback,
});

export const connectionsPreviewRoute = createRoute({
  getParentRoute: () => connectionsRoute,
  path: "/$role/$state",
  component: ConnectionsPage,
});

function ConnectionsCallback() {
  useEffect(() => {
    window.close();
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-10 py-8">
      <p className="text-sm text-muted-foreground">Connection complete. You can close this window.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview flags — append ?preview=admin|admin-empty|member|member-empty to URL
// ---------------------------------------------------------------------------

type PreviewMode = "admin" | "admin-empty" | "member" | "member-empty" | null;

const MOCK_PROVIDER: McpServerRecord = {
  id: "preview-provider",
  type: "canvas",
  slug: "canvas",
  displayName: "Canvas",
  url: "https://app.canvasx.ai/mcp",
  apiUrl: null,
  credentials: "",
  mode: "skill",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const MOCK_MCP_SERVERS: McpServerRecord[] = [
  MOCK_PROVIDER,
  {
    id: "mcp-1",
    type: null,
    slug: "internal-tools",
    displayName: "Internal Tools",
    url: "https://tools.company.com/mcp",
    apiUrl: null,
    credentials: "",
    mode: "mcp",
    createdAt: new Date(Date.now() - 14 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
  },
  {
    id: "mcp-2",
    type: null,
    slug: "analytics",
    displayName: "Analytics",
    url: "https://analytics.company.com/mcp",
    apiUrl: null,
    credentials: "",
    mode: "mcp",
    createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
  },
];

const MOCK_CONNECTIONS: IntegrationConnection[] = [
  {
    id: "conn-1",
    providerId: "preview-provider",
    appId: "hubspot",
    appName: "HubSpot",
    accountName: "team@company.com",
    status: "active",
    createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    icon: "/logos/hubspot.png",
  },
  {
    id: "conn-2",
    providerId: "preview-provider",
    appId: "slack",
    appName: "Slack",
    accountName: "Company Workspace",
    status: "active",
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    icon: "/logos/slack-logo-icon.png",
  },
  {
    id: "conn-3",
    providerId: "preview-provider",
    appId: "notion",
    appName: "Notion",
    accountName: "user@company.com",
    status: "active",
    createdAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    icon: "/logos/notion.png",
  },
];

function usePreviewMode(): PreviewMode {
  const path = window.location.pathname;
  const match = path.match(/\/integrations\/(admin|member)(?:\/(empty))?$/);
  if (!match) return null;
  const role = match[1] as "admin" | "member";
  const empty = !!match[2];
  if (empty) return `${role}-empty`;
  return role;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type ConnectionsTab = "applications" | "mcps";

export function ConnectionsPage() {
  const auth = useDashboardAuth();
  const queryClient = useQueryClient();
  const previewMode = usePreviewMode();

  const isAdmin = previewMode ? previewMode.startsWith("admin") : auth.role === "admin";
  const isMember = previewMode ? previewMode.startsWith("member") : auth.role === "member";

  const [activeTab, setActiveTab] = useState<ConnectionsTab>("applications");

  const serversQuery = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.mcpServers.list(),
  });

  const realServers = serversQuery.data ?? [];
  const servers = previewMode ? (previewMode.endsWith("-empty") ? [] : MOCK_MCP_SERVERS) : realServers;
  const realProvider = realServers.find((s) => s.type != null) ?? null;
  const provider = previewMode ? MOCK_PROVIDER : realProvider;

  const connectionsQuery = useQuery({
    queryKey: ["connections", realProvider?.id],
    queryFn: () => api.mcpServers.listConnections(realProvider?.id ?? ""),
    enabled: !!realProvider && !previewMode && auth.role === "member",
  });

  const realConnections = connectionsQuery.data ?? [];
  const connections: IntegrationConnection[] = previewMode
    ? previewMode.endsWith("-empty")
      ? []
      : MOCK_CONNECTIONS
    : realConnections;

  const [showAddMcpDialog, setShowAddMcpDialog] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerRecord | null>(null);
  const [editingProvider, setEditingProvider] = useState<McpServerRecord | null>(null);
  const [removingServer, setRemovingServer] = useState<McpServerRecord | null>(null);
  const [showAddIntegrationDialog, setShowAddIntegrationDialog] = useState(false);
  const [showProviderSelector, setShowProviderSelector] = useState(false);
  const [showAddProvider, setShowAddProvider] = useState(false);

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    queryClient.invalidateQueries({ queryKey: ["connections"] });
  }, [queryClient]);

  const isLoading = serversQuery.isLoading;

  return (
    <div className="mx-auto max-w-4xl px-10 py-8">
      <div>
        <h1 className="text-xl font-semibold">Integrations</h1>
        <p className="mt-2 text-sm text-muted-foreground">Connect apps and tools to extend your workspace.</p>
      </div>

      <div className="mt-6 flex items-center gap-6 border-b border-border">
        <TabButton
          label="Applications"
          isActive={activeTab === "applications"}
          onClick={() => setActiveTab("applications")}
        />
        <TabButton label="MCPs" isActive={activeTab === "mcps"} onClick={() => setActiveTab("mcps")} />
      </div>

      <div className="mt-5 space-y-8">
        {isLoading ? (
          <LoadingSkeleton />
        ) : activeTab === "applications" ? (
          <>
            {!provider ? (
              isAdmin ? (
                <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-[#FEED01]/[0.04] px-6 pt-8 pb-10 text-center">
                  <div className="flex size-12 items-center justify-center rounded-full bg-white border border-[#FEED01]">
                    <PlugIcon size={24} className="text-[#8B7A00]" />
                  </div>
                  <p className="mt-3 text-sm font-medium">No integration provider connected</p>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    Let your team connect their own apps. Each member authorizes
                    <br />
                    with their own credentials — no shared access.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-4 gap-1.5 hover:bg-[#FEED01]/8"
                    onClick={() => setShowProviderSelector(true)}
                  >
                    <PlusIcon size={14} weight="bold" />
                    Connect provider
                  </Button>
                </div>
              ) : null
            ) : (
              <>
                {connections.length > 0 && (
                  <div className="mb-5 flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FEED01]/10 px-2.5 py-1 text-xs text-muted-foreground">
                      <span className="inline-block size-1.5 rounded-full bg-[#FEED01]" />
                      via {provider.type === "canvas" ? "Canvas" : (provider.type ?? "Provider")}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAddIntegrationDialog(true)}
                      className="h-7 gap-1.5 rounded-md px-2.5 text-xs hover:bg-[#FEED01]/8"
                    >
                      <PlusIcon size={12} weight="bold" />
                      Add app
                    </Button>
                  </div>
                )}
                <IntegrationsSection
                  provider={provider}
                  connections={connections}
                  isLoadingConnections={connectionsQuery.isLoading}
                  isMember={isMember}
                  onAdd={() => setShowAddIntegrationDialog(true)}
                  providerId={provider.id}
                  onDisconnect={invalidateAll}
                />
              </>
            )}
          </>
        ) : (
          <McpServersSection
            servers={servers}
            isAdmin={isAdmin}
            onAdd={() => setShowAddMcpDialog(true)}
            onEdit={(server) => {
              if (server.type) {
                setEditingProvider(server);
              } else {
                setEditingServer(server);
              }
            }}
            onRemove={setRemovingServer}
            onTestConnection={async (server) => {
              try {
                const result = await api.mcpServers.testConnectionById(server.id);
                if (result.status === "ok") {
                  toast.success(`Connection OK. ${result.toolCount} tools available.`);
                } else {
                  toast.error(result.error ?? "Connection failed");
                }
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Connection test failed");
              }
            }}
          />
        )}
      </div>

      <AddMcpDialog open={showAddMcpDialog} onOpenChange={setShowAddMcpDialog} onSuccess={invalidateAll} />

      <ProviderSelectorDialog
        open={showProviderSelector}
        onOpenChange={setShowProviderSelector}
        onSelectCanvas={() => {
          setShowProviderSelector(false);
          setShowAddProvider(true);
        }}
      />

      <AddProviderDialog open={showAddProvider} onOpenChange={setShowAddProvider} onSuccess={invalidateAll} />

      <EditMcpDialog
        server={editingServer}
        onOpenChange={(open) => !open && setEditingServer(null)}
        onSuccess={invalidateAll}
      />

      <EditProviderDialog
        server={editingProvider}
        onOpenChange={(open) => !open && setEditingProvider(null)}
        onSuccess={invalidateAll}
      />

      <RemoveMcpDialog
        server={removingServer}
        onOpenChange={(open) => !open && setRemovingServer(null)}
        onSuccess={invalidateAll}
      />

      {provider && (
        <AddIntegrationDialog
          open={showAddIntegrationDialog}
          onOpenChange={setShowAddIntegrationDialog}
          providerId={provider.id}
          connectedAppIds={new Set(connections.map((c) => c.appId))}
          onSuccess={invalidateAll}
        />
      )}
    </div>
  );
}

function TabButton({ label, isActive, onClick }: { label: string; isActive: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative pb-3 font-mono text-[12px] uppercase tracking-[0.07em] transition-colors",
        isActive ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {isActive ? <span className="absolute inset-x-0 bottom-0 h-[3px] rounded-full bg-[#FEED01]" /> : null}
    </button>
  );
}
