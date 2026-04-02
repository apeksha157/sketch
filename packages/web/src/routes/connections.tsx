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
import { ConnectionsBanner } from "@/components/connections-banner";
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
import type { McpServerRecord } from "@sketch/shared";
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
  path: "/connections",
  component: ConnectionsPage,
});

export const connectionsCallbackRoute = createRoute({
  getParentRoute: () => connectionsRoute,
  path: "/callback",
  component: ConnectionsCallback,
});

function ConnectionsCallback() {
  useEffect(() => {
    window.close();
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <p className="text-sm text-muted-foreground">Connection complete. You can close this window.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ConnectionsPage() {
  const auth = useDashboardAuth();
  const queryClient = useQueryClient();
  const isAdmin = auth.role === "admin";
  const isMember = auth.role === "member";

  const serversQuery = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.mcpServers.list(),
  });

  const servers = serversQuery.data ?? [];
  const provider = servers.find((s) => s.type != null) ?? null;

  const connectionsQuery = useQuery({
    queryKey: ["connections", provider?.id],
    queryFn: () => api.mcpServers.listConnections(provider?.id ?? ""),
    enabled: !!provider && isMember,
  });

  const connections = connectionsQuery.data ?? [];

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
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div>
        <h1 className="text-xl font-bold">Connections</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage MCP servers and per-user integrations.</p>
      </div>

      <div className="mt-6 space-y-8">
        {isLoading ? (
          <LoadingSkeleton />
        ) : (
          <>
            {!provider ? (
              isAdmin ? (
                <ConnectionsBanner onConnect={() => setShowProviderSelector(true)} />
              ) : null
            ) : (
              <IntegrationsSection
                provider={provider}
                connections={connections}
                isLoadingConnections={connectionsQuery.isLoading}
                isMember={isMember}
                onAdd={() => setShowAddIntegrationDialog(true)}
                providerId={provider.id}
                onDisconnect={invalidateAll}
              />
            )}

            {isAdmin && (
              <McpServersSection
                servers={servers}
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
          </>
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
