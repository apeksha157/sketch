/**
 * Files page — unified content library across all connected sources.
 *
 * Layout (top to bottom):
 * 1. Header — title + aggregate stats
 * 2. Source pills — thin horizontal chips (filter by click, "+" to connect, "Browse all" for full catalog)
 * 3. Toolbar — search + type/status filter dropdowns inline on one row
 * 4. File table — infinite list with multi-select, enrichment, detail sheet
 *
 * Source pills are pure filters — no management menus on individual pills.
 * Connector management (sync, details, connect new) lives in the "Browse all connectors" dialog.
 */
import {
  ConnectIntegrationDialog,
  FolderContents,
  FolderPicker,
  IntegrationIcon,
  SharedDrivePicker,
} from "@/components/connect-integration-dialog";
import { ConnectorLogo } from "@/components/connector-logos";
import type { ConnectorConfig, ConnectorFile, FileAccess, FileContent, SearchResult, UnifiedFile } from "@/lib/api";
import { api } from "@/lib/api";
import { INTEGRATIONS, type IntegrationDefinition, type IntegrationType, getIntegration } from "@/lib/integrations";
import {
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  EyeIcon,
  EyeSlashIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  GearIcon,
  GlobeIcon,
  GridFourIcon,
  LinkIcon,
  LockSimpleIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SparkleIcon,
  SpinnerGapIcon,
  TableIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sketch/ui/components/alert-dialog";
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { Input } from "@sketch/ui/components/input";
import { Label } from "@sketch/ui/components/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { Switch } from "@sketch/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { dashboardRoute } from "./dashboard";

export const filesRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/files",
  component: FilesPage,
});

const PAGE_SIZE = 50;

export function FilesPage() {
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilterRaw] = useState<string | null>(null);
  const setSourceFilter = useCallback((value: string | null) => {
    setSourceFilterRaw(value);
    setPageSize(PAGE_SIZE);
  }, []);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [accessFilter, setAccessFilter] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [connectingIntegration, setConnectingIntegration] = useState<IntegrationDefinition | null>(null);
  const [showBrowseAll, setShowBrowseAll] = useState(false);
  const [showSearchSettings, setShowSearchSettings] = useState(false);
  const [managingConnector, setManagingConnector] = useState<{
    definition: IntegrationDefinition;
    connector: ConnectorConfig;
  } | null>(null);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Debounce search input — wait 400ms after typing stops before querying server
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  /* ── Data fetching ─────────────────────────────────────── */

  const { data: connectorsData, isLoading: isLoadingConnectors } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => api.integrations.list(),
    refetchInterval: 30000,
  });

  const connectors = connectorsData?.connectors ?? [];

  /** Auto-open manage dialog after OAuth redirect (e.g. ?oauth=success&connectorId=...) */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get("oauth");
    const connectorId = params.get("connectorId");

    if (!oauthStatus || connectors.length === 0) return;

    // Clear query params to avoid re-triggering
    window.history.replaceState({}, "", window.location.pathname);

    if (oauthStatus === "success" && connectorId) {
      const connector = connectors.find((c) => c.id === connectorId);
      if (connector) {
        const def = getIntegration(connector.connectorType as IntegrationType);
        if (def) {
          toast.success("Google account connected — now select which drives or folders to sync.");
          setManagingConnector({ definition: def, connector });
          return;
        }
      }
      toast.success("Google Drive connected successfully.");
    } else if (oauthStatus === "error") {
      const reason = params.get("reason") ?? "unknown";
      const messages: Record<string, string> = {
        denied: "Google authorization was denied.",
        no_refresh_token:
          "No refresh token received — try revoking app access in Google Account settings and reconnecting.",
        token_exchange: "Failed to exchange authorization code for tokens.",
        not_configured: "Google OAuth is not configured.",
        internal: "An internal error occurred during authorization.",
      };
      toast.error(messages[reason] ?? `OAuth error: ${reason}`);
    }
  }, [connectors]);

  /** Server-side source filter: connector type or undefined for all. "local" is handled client-side. */
  const serverSource = sourceFilter && sourceFilter !== "local" ? sourceFilter : undefined;

  /** Paginated file listing across all connectors. */
  const {
    data: filesData,
    isLoading: isLoadingFiles,
    isFetching: isFetchingFiles,
  } = useQuery({
    queryKey: ["all-files", pageSize, serverSource],
    queryFn: () => api.integrations.allFiles({ limit: pageSize, offset: 0, source: serverSource }),
    enabled: !!connectorsData,
    refetchInterval: 30000,
  });

  const allFiles: UnifiedFile[] = filesData?.files ?? [];
  const totalFiles = filesData?.total ?? 0;
  const hasMore = filesData?.hasMore ?? false;

  /** Server-side hybrid search (FTS5 + vector). Only fires when debouncedSearch is non-empty. */
  const { data: searchData, isFetching: isSearching } = useQuery({
    queryKey: ["hybrid-search", debouncedSearch, serverSource],
    queryFn: () => api.integrations.search({ query: debouncedSearch, source: serverSource, limit: 20 }),
    enabled: debouncedSearch.length > 0,
    staleTime: 30000,
  });

  const searchResults: SearchResult[] = searchData?.results ?? [];
  const isInSearchMode = debouncedSearch.length > 0;

  const loadMore = useCallback(() => {
    setPageSize((prev) => prev + PAGE_SIZE);
  }, []);

  /* ── Filter logic ──────────────────────────────────────── */

  const filteredFiles = useMemo(() => {
    // When searching, server already returns ranked results — skip client-side filtering
    if (isInSearchMode) return allFiles;

    let result = allFiles;

    // "local" source filter is client-side only (connector source filters are server-side)
    if (sourceFilter === "local") {
      result = result.filter((f) => f.source === "local");
    }
    if (typeFilter) {
      result = result.filter((f) => f.contentCategory === typeFilter);
    }
    if (statusFilter === "enriched") {
      result = result.filter((f) => f.hasSummary);
    } else if (statusFilter === "raw") {
      result = result.filter((f) => !f.hasSummary);
    }
    if (accessFilter) {
      result = result.filter((f) => f.accessScope === accessFilter);
    }

    return result;
  }, [allFiles, isInSearchMode, sourceFilter, typeFilter, statusFilter, accessFilter]);

  /* ── Derived stats ─────────────────────────────────────── */

  const enrichedCount = allFiles.filter((f) => f.hasSummary).length;
  const localFileCount = allFiles.filter((f) => f.source === "local").length;
  const hasAnyFilter = !!(sourceFilter || typeFilter || statusFilter || accessFilter || search.trim());
  /** Client-side-only filters that make "Load more" unreliable (server doesn't know about these). */
  const hasClientOnlyFilter = !!(
    typeFilter ||
    statusFilter ||
    accessFilter ||
    search.trim() ||
    sourceFilter === "local"
  );

  const connectedByType = new Map<string, ConnectorConfig>();
  for (const c of connectors) {
    connectedByType.set(c.connectorType, c);
  }

  const handleConnected = () => {
    queryClient.invalidateQueries({ queryKey: ["integrations"] });
    queryClient.invalidateQueries({ queryKey: ["all-files"] });
  };

  const isLoading = isLoadingConnectors || isLoadingFiles;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Files</h1>
          <p className="mt-1 text-sm text-muted-foreground">Your team's indexed knowledge base</p>
        </div>
        <div className="flex items-center gap-3">
          {!isLoadingConnectors && totalFiles > 0 && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                {totalFiles.toLocaleString()} file{totalFiles !== 1 ? "s" : ""}
              </span>
              {enrichedCount > 0 && (
                <>
                  <span className="text-border">|</span>
                  <span className="flex items-center gap-1">
                    <SparkleIcon size={12} weight="fill" className="text-primary" />
                    {enrichedCount} enriched
                  </span>
                </>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowSearchSettings(true)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Search & enrichment settings"
          >
            <GearIcon size={16} />
          </button>
        </div>
      </div>

      {/* Source pills — thin horizontal chips */}
      <div className="mt-5 flex items-center gap-1.5 flex-wrap">
        {/* "All" pill */}
        <SourceChip
          active={!sourceFilter}
          onClick={() => setSourceFilter(null)}
          label="All"
          count={totalFiles}
          icon={<FileTextIcon size={12} />}
        />

        {/* Local files */}
        <SourceChip
          active={sourceFilter === "local"}
          onClick={() => setSourceFilter(sourceFilter === "local" ? null : "local")}
          onClear={() => setSourceFilter(null)}
          label="Local"
          count={localFileCount}
          icon={<FolderSimpleIcon size={12} />}
        />

        {/* Connected source chips */}
        {INTEGRATIONS.map((def) => {
          const connector = connectedByType.get(def.type);
          if (!connector) return null;
          return (
            <SourceChip
              key={def.type}
              active={sourceFilter === def.type}
              onClick={() => setSourceFilter(sourceFilter === def.type ? null : def.type)}
              onClear={() => setSourceFilter(null)}
              label={def.name}
              count={connector.fileCount ?? 0}
              color={def.color}
              connectorType={def.type}
              status={connector.syncStatus}
            />
          );
        })}

        {/* Unconnected source "+" chips */}
        {INTEGRATIONS.map((def) => {
          if (connectedByType.has(def.type)) return null;
          return (
            <button
              key={def.type}
              type="button"
              onClick={() => setConnectingIntegration(def)}
              className="flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-border/80 hover:bg-muted/30 hover:text-foreground"
            >
              <PlusIcon size={10} />
              <ConnectorLogo type={def.type} size={10} />
              {def.name}
            </button>
          );
        })}

        {/* Browse all connectors */}
        <button
          type="button"
          onClick={() => setShowBrowseAll(true)}
          className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
        >
          <GridFourIcon size={12} />
          Browse all
        </button>
      </div>

      {/* Toolbar: search + refinement filters on a single line */}
      <div className="mt-4 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlassIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            placeholder="Search files..."
            className="pl-9 text-sm"
          />
        </div>

        <FilterDropdown
          label="Type"
          value={typeFilter === "document" ? "Documents" : typeFilter === "structured" ? "Data" : null}
          options={[
            { value: "document", label: "Documents" },
            { value: "structured", label: "Data" },
          ]}
          onChange={setTypeFilter}
        />

        <FilterDropdown
          label="Access"
          value={accessFilter === "restricted" ? "Restricted" : accessFilter === "unrestricted" ? "Open" : null}
          options={[
            { value: "restricted", label: "Restricted" },
            { value: "unrestricted", label: "Open" },
          ]}
          onChange={setAccessFilter}
        />

        <FilterDropdown
          label="Status"
          value={statusFilter === "enriched" ? "Enriched" : statusFilter === "raw" ? "Raw" : null}
          options={[
            { value: "raw", label: "Raw" },
            { value: "enriched", label: "Enriched" },
          ]}
          onChange={setStatusFilter}
        />
      </div>

      {/* File List */}
      <div className="mt-4">
        {isLoading || isSearching ? (
          <div className="space-y-2">
            {["fskel-1", "fskel-2", "fskel-3", "fskel-4", "fskel-5"].map((key) => (
              <Skeleton key={key} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : isInSearchMode ? (
          /* ── Search results view ──────────────────────────── */
          searchResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
              <MagnifyingGlassIcon size={32} className="text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">No results for "{debouncedSearch}"</p>
              <p className="mt-1 text-xs text-muted-foreground">Try a different search term</p>
            </div>
          ) : (
            <>
              <div className="mb-2 text-xs text-muted-foreground">
                {searchResults.length} result{searchResults.length === 1 ? "" : "s"} for "{debouncedSearch}"
              </div>
              <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                <span className="flex-1">Name</span>
                <span className="w-24 text-center">Source</span>
                <span className="w-16 text-center">Type</span>
                <span className="w-20 text-center">Score</span>
                <span className="w-20 text-center">Similarity</span>
              </div>
              {searchResults.map((result) => (
                <SearchResultRow key={result.id} result={result} onView={() => setViewingFile(result.id)} />
              ))}
            </>
          )
        ) : filteredFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
            <FileTextIcon size={32} className="text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">
              {hasAnyFilter ? "No files match your filters" : "No files indexed yet"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {hasAnyFilter ? "Try adjusting your search or filters" : "Connect a source above to start syncing files"}
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <span className="flex-1">Name</span>
              <span className="w-24 text-center">Source</span>
              <span className="w-16 text-center">Type</span>
              <span className="w-20 text-center">Access</span>
              <span className="w-20 text-center">Status</span>
              <span className="w-24 text-right">Synced</span>
              <span className="w-5" />
            </div>
            {filteredFiles.map((file) => (
              <UnifiedFileRow key={file.id} file={file} onView={() => setViewingFile(file.id)} />
            ))}

            {/* Load more button — hidden when client-only filters are active since server pagination doesn't account for them */}
            {hasMore && !hasClientOnlyFilter && (
              <div className="flex items-center justify-center py-4">
                <Button variant="outline" size="sm" onClick={loadMore} disabled={isFetchingFiles}>
                  {isFetchingFiles ? (
                    <>
                      <SpinnerGapIcon size={14} className="animate-spin" />
                      Loading...
                    </>
                  ) : (
                    `Load more (${allFiles.length} of ${totalFiles})`
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Browse All Connectors Dialog */}
      <BrowseConnectorsDialog
        open={showBrowseAll}
        onOpenChange={setShowBrowseAll}
        connectors={connectors}
        onConnect={(def) => {
          setShowBrowseAll(false);
          setConnectingIntegration(def);
        }}
        onManage={(def, connector) => {
          setShowBrowseAll(false);
          setManagingConnector({ definition: def, connector });
        }}
      />

      {/* Manage Connector Dialog */}
      <ManageConnectorDialog
        definition={managingConnector?.definition ?? null}
        connector={managingConnector?.connector ?? null}
        open={!!managingConnector}
        onOpenChange={(open) => !open && setManagingConnector(null)}
        onDisconnected={handleConnected}
        onReconnect={(def) => {
          setManagingConnector(null);
          setConnectingIntegration(def);
        }}
      />

      {/* Connect Dialog */}
      <ConnectIntegrationDialog
        integration={connectingIntegration}
        open={!!connectingIntegration}
        onOpenChange={(open) => !open && setConnectingIntegration(null)}
        onConnected={handleConnected}
      />

      {/* File Detail Sheet */}
      <FileDetailSheet fileId={viewingFile} onClose={() => setViewingFile(null)} />

      {/* Search & Enrichment Settings Sheet */}
      <SearchSettingsSheet open={showSearchSettings} onOpenChange={setShowSearchSettings} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Source chip — thin horizontal pill that filters by source
 * ───────────────────────────────────────────────────────── */

function SourceChip({
  active,
  onClick,
  onClear,
  label,
  count,
  icon,
  color,
  connectorType,
  status,
}: {
  active: boolean;
  onClick: () => void;
  onClear?: () => void;
  label: string;
  count: number;
  icon?: React.ReactNode;
  color?: string;
  connectorType?: string;
  status?: string;
}) {
  const logo = connectorType ? <ConnectorLogo type={connectorType} size={12} style={{ color }} /> : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-primary/40 bg-primary/5 text-foreground ring-1 ring-primary/20"
          : "border-border bg-card text-foreground hover:bg-muted/30"
      }`}
    >
      {icon || logo || <span className="inline-block size-2 rounded-sm" style={{ backgroundColor: color }} />}
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{count.toLocaleString()}</span>
      {status && <SyncStatusDot status={status} />}
      {active && onClear && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <XIcon size={10} />
        </button>
      )}
    </button>
  );
}

function SyncStatusDot({ status }: { status: string }) {
  switch (status) {
    case "active":
      return <CheckCircleIcon size={10} className="text-success" weight="fill" />;
    case "syncing":
      return <CircleNotchIcon size={10} className="animate-spin text-primary" />;
    case "error":
      return <WarningCircleIcon size={10} className="text-destructive" weight="fill" />;
    default:
      return null;
  }
}

/* ─────────────────────────────────────────────────────────
 * Browse All Connectors Dialog — full catalog for adding/managing sources
 * ───────────────────────────────────────────────────────── */

function BrowseConnectorsDialog({
  open,
  onOpenChange,
  connectors,
  onConnect,
  onManage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectors: ConnectorConfig[];
  onConnect: (def: IntegrationDefinition) => void;
  onManage: (def: IntegrationDefinition, connector: ConnectorConfig) => void;
}) {
  const connectedByType = new Map<string, ConnectorConfig>();
  for (const c of connectors) {
    connectedByType.set(c.connectorType, c);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>All connectors</DialogTitle>
          <DialogDescription>Connect external sources to sync files into your knowledge base.</DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-2">
          {INTEGRATIONS.map((def) => {
            const connector = connectedByType.get(def.type);
            return (
              <ConnectorRow
                key={def.type}
                definition={def}
                connector={connector ?? null}
                onConnect={() => onConnect(def)}
                onManage={() => {
                  if (connector) onManage(def, connector);
                }}
              />
            );
          })}
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">More connectors coming soon</p>
      </DialogContent>
    </Dialog>
  );
}

function ConnectorRow({
  definition,
  connector,
  onConnect,
  onManage,
}: {
  definition: IntegrationDefinition;
  connector: ConnectorConfig | null;
  onConnect: () => void;
  onManage: () => void;
}) {
  const queryClient = useQueryClient();
  const isConnected = !!connector;

  const syncMutation = useMutation({
    mutationFn: () => api.integrations.sync(connector?.id ?? ""),
    onSuccess: () => {
      toast.success("Sync started.");
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3">
      <IntegrationIcon color={definition.color} name={definition.name} type={definition.type} size="sm" />

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{definition.name}</p>
        <p className="text-xs text-muted-foreground">
          {isConnected ? (
            <>
              {connector.fileCount != null && `${connector.fileCount.toLocaleString()} ${definition.itemNoun}`}
              {connector.lastSyncedAt && ` · Synced ${formatRelativeTime(connector.lastSyncedAt)}`}
            </>
          ) : (
            definition.description
          )}
        </p>
      </div>

      {isConnected ? (
        <div className="flex items-center gap-1.5">
          <SyncStatusDot status={connector.syncStatus} />
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => syncMutation.mutate()}
            disabled={connector.syncStatus === "syncing" || syncMutation.isPending}
          >
            <ArrowsClockwiseIcon size={14} className={connector.syncStatus === "syncing" ? "animate-spin" : ""} />
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onManage}>
            Manage
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onConnect}>
          <PlusIcon size={12} />
          Connect
        </Button>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Search & Enrichment Settings Sheet
 * ───────────────────────────────────────────────────────── */

function SearchSettingsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["settings", "search"],
    queryFn: () => api.settings.searchConfig(),
    enabled: open,
  });

  const [geminiKey, setGeminiKey] = useState("");
  const [enrichmentEnabled, setEnrichmentEnabled] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showRunPrompt, setShowRunPrompt] = useState(false);

  useEffect(() => {
    if (data) {
      setGeminiKey(data.geminiApiKeyConfigured ? "••••••••" : "");
      setEnrichmentEnabled(data.enrichmentEnabled === 1);
      setDirty(false);
      setShowRunPrompt(false);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: (updates: { geminiApiKey?: string | null; enrichmentEnabled?: boolean }) =>
      api.settings.updateSearchConfig(updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "search"] });
      setDirty(false);
      if (enrichmentEnabled) {
        setShowRunPrompt(true);
      } else {
        toast.success("Settings saved");
        onOpenChange(false);
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const enrichMutation = useMutation({
    mutationFn: () => api.settings.runEnrichment(),
    onSuccess: () => {
      toast.success("Enrichment started — files will be processed in the background.");
      onOpenChange(false);
      setShowRunPrompt(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function handleSave() {
    const updates: { geminiApiKey?: string | null; enrichmentEnabled?: boolean } = {};
    if (geminiKey !== "••••••••" && geminiKey !== "") updates.geminiApiKey = geminiKey || null;
    if (enrichmentEnabled !== (data?.enrichmentEnabled === 1)) updates.enrichmentEnabled = enrichmentEnabled;
    mutation.mutate(updates);
  }

  const needsKey = enrichmentEnabled && !geminiKey.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(v: boolean) => {
        if (!v) setShowRunPrompt(false);
        onOpenChange(v);
      }}
    >
      <DialogContent>
        {showRunPrompt ? (
          <>
            <DialogHeader>
              <DialogTitle>Run enrichment now?</DialogTitle>
              <DialogDescription>
                This will tag, summarize, and generate embeddings for all pending files. You can also run it later from
                individual files.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  toast.success("Settings saved");
                  onOpenChange(false);
                  setShowRunPrompt(false);
                }}
              >
                Not now
              </Button>
              <Button onClick={() => enrichMutation.mutate()} disabled={enrichMutation.isPending}>
                {enrichMutation.isPending && <SpinnerGapIcon size={16} className="mr-2 animate-spin" />}
                Run enrichment
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Search & Enrichment</DialogTitle>
              <DialogDescription>Configure how files are indexed and searched.</DialogDescription>
            </DialogHeader>

            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor="enrichment-toggle" className="text-sm font-medium">
                  AI Enrichment
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {enrichmentEnabled
                    ? "Files are tagged, summarized & embedded for semantic search"
                    : "Search uses keyword matching only (FTS5)"}
                </p>
              </div>
              <Switch
                id="enrichment-toggle"
                checked={enrichmentEnabled}
                onCheckedChange={(checked: boolean) => {
                  setEnrichmentEnabled(checked);
                  setDirty(true);
                }}
              />
            </div>

            {enrichmentEnabled && (
              <>
                <ol className="list-inside list-decimal space-y-1.5 text-xs text-muted-foreground">
                  <li>Go to Google AI Studio</li>
                  <li>Create or select a project</li>
                  <li>Generate an API key</li>
                  <li>Paste it below</li>
                </ol>

                <Button variant="ghost" size="sm" asChild className="w-fit">
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
                    Get API key
                    <ArrowSquareOutIcon className="size-3.5" />
                  </a>
                </Button>

                <div className="space-y-1.5">
                  <Label htmlFor="gemini-key" className="text-xs">
                    Gemini API Key
                  </Label>
                  <div className="relative">
                    <Input
                      id="gemini-key"
                      type={showKey ? "text" : "password"}
                      value={geminiKey}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setGeminiKey(e.target.value);
                        setDirty(true);
                      }}
                      placeholder="AIza..."
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showKey ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">Used for generating vector embeddings</p>
                </div>
              </>
            )}

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={!dirty || mutation.isPending || needsKey}>
                {mutation.isPending && <SpinnerGapIcon size={16} className="mr-2 animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────────────────────────────────────────
 * Manage Connector Dialog — status, sync scope, NL agent, actions
 *
 * Pattern B: status summary + natural language input for scope config.
 * The NL input will eventually be wired to an agent backend that
 * interprets instructions like "sync the Marketing folder" and
 * configures the connector's scope accordingly.
 * ───────────────────────────────────────────────────────── */

function ManageConnectorDialog({
  definition,
  connector,
  open,
  onOpenChange,
  onDisconnected,
  onReconnect,
}: {
  definition: IntegrationDefinition | null;
  connector: ConnectorConfig | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnected: () => void;
  onReconnect: (def: IntegrationDefinition) => void;
}) {
  const queryClient = useQueryClient();
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const syncMutation = useMutation({
    mutationFn: () => api.integrations.sync(connector?.id ?? ""),
    onSuccess: () => {
      toast.success("Sync started.");
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.integrations.disconnect(connector?.id ?? ""),
    onSuccess: () => {
      toast.success(`${definition?.name ?? "Connector"} disconnected.`);
      setShowDisconnectConfirm(false);
      onOpenChange(false);
      onDisconnected();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  /** Disconnect then re-open the connect dialog so the user can enter fresh credentials. */
  const reconnectMutation = useMutation({
    mutationFn: () => api.integrations.disconnect(connector?.id ?? ""),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      if (definition) onReconnect(definition);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (!definition || !connector) return null;

  const isError = connector.syncStatus === "error";
  const isGoogleDrive = definition.type === "google_drive";

  /** Extract readable scope info from scopeConfig. */
  const scopeEntries = Object.entries(connector.scopeConfig ?? {}).filter(
    ([, v]) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0),
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5">
              <IntegrationIcon color={definition.color} name={definition.name} type={definition.type} />
              Manage {definition.name}
            </DialogTitle>
            <DialogDescription>{definition.description}</DialogDescription>
          </DialogHeader>

          {/* Status summary */}
          <div className="flex items-center gap-4 rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-xs">
            <div className="flex items-center gap-1.5">
              <SyncStatusDot status={connector.syncStatus} />
              <span className="font-medium capitalize">{connector.syncStatus}</span>
            </div>
            {connector.fileCount != null && (
              <span className="text-muted-foreground">
                {connector.fileCount.toLocaleString()} {definition.itemNoun}
              </span>
            )}
            {connector.lastSyncedAt && (
              <span className="text-muted-foreground">Synced {formatRelativeTime(connector.lastSyncedAt)}</span>
            )}
          </div>

          {/* Error banner with update credentials action */}
          {isError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3">
              {connector.errorMessage && <p className="text-xs text-destructive">{connector.errorMessage}</p>}
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-7 gap-1.5 text-xs"
                onClick={() => reconnectMutation.mutate()}
                disabled={reconnectMutation.isPending}
              >
                {reconnectMutation.isPending ? (
                  <>
                    <SpinnerGapIcon size={12} className="animate-spin" />
                    Reconnecting...
                  </>
                ) : (
                  <>
                    <ArrowsClockwiseIcon size={12} />
                    Update credentials
                  </>
                )}
              </Button>
            </div>
          )}

          {/* Sync scope — Google Drive gets a drive picker, others get generic display */}
          {isGoogleDrive ? (
            <GoogleDriveScopeEditor connectorId={connector.id} scopeConfig={connector.scopeConfig} />
          ) : (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Sync scope — {definition.scopeLabel}
              </p>
              <div className="mt-1.5">
                {scopeEntries.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {scopeEntries.map(([key, value]) => (
                      <Badge key={key} variant="secondary" className="text-[10px]">
                        {Array.isArray(value) ? value.join(", ") : String(value)}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    All accessible {definition.scopeLabel} are being synced.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
              onClick={() => setShowDisconnectConfirm(true)}
            >
              <TrashIcon size={12} />
              Disconnect
            </Button>
            <div className="flex items-center gap-1.5">
              {!isError && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => reconnectMutation.mutate()}
                  disabled={reconnectMutation.isPending}
                >
                  {reconnectMutation.isPending ? (
                    <>
                      <SpinnerGapIcon size={12} className="animate-spin" />
                      Updating...
                    </>
                  ) : (
                    "Update credentials"
                  )}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => syncMutation.mutate()}
                disabled={connector.syncStatus === "syncing" || syncMutation.isPending}
              >
                <ArrowsClockwiseIcon size={12} className={connector.syncStatus === "syncing" ? "animate-spin" : ""} />
                {connector.syncStatus === "syncing" ? "Syncing..." : "Sync now"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Disconnect confirmation */}
      <AlertDialog open={showDisconnectConfirm} onOpenChange={setShowDisconnectConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {definition.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the connection and all indexed {definition.itemNoun} from {definition.name}. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnectMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {disconnectMutation.isPending ? "Disconnecting..." : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/* ─────────────────────────────────────────────────────────
 * Google Drive Scope Editor — fetches drives and lets admin toggle them
 * ───────────────────────────────────────────────────────── */

function GoogleDriveScopeEditor({
  connectorId,
  scopeConfig,
}: {
  connectorId: string;
  scopeConfig: Record<string, unknown>;
}) {
  const queryClient = useQueryClient();
  const currentDriveIds = (scopeConfig?.sharedDrives as string[] | undefined) ?? [];
  const currentFolderIds = (scopeConfig?.folders as string[] | undefined) ?? [];

  /** Fetch available drives/folders from the existing connector's credentials. */
  const { data: browseData, isLoading: isBrowsing } = useQuery({
    queryKey: ["google-drive-browse", connectorId],
    queryFn: () => api.integrations.browseGoogleDriveExisting(connectorId),
  });

  const drives = browseData?.sharedDrives ?? [];
  const folders = browseData?.rootFolders ?? [];

  const [selectedDriveIds, setSelectedDriveIds] = useState<Set<string> | null>(null);
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string> | null>(null);

  const effectiveDriveIds = selectedDriveIds ?? new Set(drives.filter((d) => d.selected).map((d) => d.id));
  const effectiveFolderIds = selectedFolderIds ?? new Set(folders.filter((f) => f.selected).map((f) => f.id));

  const toggleDrive = (driveId: string) => {
    setSelectedDriveIds((prev) => {
      const base = prev ?? new Set(drives.filter((d) => d.selected).map((d) => d.id));
      const next = new Set(base);
      if (next.has(driveId)) next.delete(driveId);
      else next.add(driveId);
      return next;
    });
  };

  const toggleFolder = (folderId: string) => {
    setSelectedFolderIds((prev) => {
      const base = prev ?? new Set(folders.filter((f) => f.selected).map((f) => f.id));
      const next = new Set(base);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  /** Check if selection has changed from current scope. */
  const currentDriveSet = new Set(currentDriveIds);
  const currentFolderSet = new Set(currentFolderIds);

  const hasDriveChanges =
    selectedDriveIds !== null &&
    (effectiveDriveIds.size !== currentDriveSet.size || [...effectiveDriveIds].some((id) => !currentDriveSet.has(id)));

  const hasFolderChanges =
    selectedFolderIds !== null &&
    (effectiveFolderIds.size !== currentFolderSet.size ||
      [...effectiveFolderIds].some((id) => !currentFolderSet.has(id)));

  const hasChanges = hasDriveChanges || hasFolderChanges;

  const saveMutation = useMutation({
    mutationFn: () => {
      const newScope: Record<string, string[]> = {};
      if (drives.length > 0) newScope.sharedDrives = Array.from(effectiveDriveIds);
      if (folders.length > 0) newScope.folders = Array.from(effectiveFolderIds);
      return api.integrations.updateScope(connectorId, newScope);
    },
    onSuccess: () => {
      toast.success("Scope updated. Re-sync started.");
      setSelectedDriveIds(null);
      setSelectedFolderIds(null);
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      queryClient.invalidateQueries({ queryKey: ["google-drive-browse", connectorId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const totalSelected = effectiveDriveIds.size + effectiveFolderIds.size;

  return (
    <div className="space-y-4">
      {isBrowsing ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <SpinnerGapIcon size={14} className="animate-spin" />
          Loading...
        </div>
      ) : (
        <>
          {(drives.length > 0 || folders.length > 0) && (
            <CombinedDrivePicker
              drives={drives}
              folders={folders}
              selectedDriveIds={effectiveDriveIds}
              selectedFolderIds={effectiveFolderIds}
              onToggleDrive={toggleDrive}
              onToggleFolder={toggleFolder}
              disabled={saveMutation.isPending}
              connectorId={connectorId}
            />
          )}
          {drives.length === 0 && folders.length === 0 && (
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-3">
              <p className="text-xs font-medium">No drives or folders found</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Check that the connected Google account has access to Drive content.
              </p>
            </div>
          )}
          {hasChanges && (
            <SaveScopeButton
              onClick={() => saveMutation.mutate()}
              isPending={saveMutation.isPending}
              count={totalSelected}
              label="item"
            />
          )}
        </>
      )}
    </div>
  );
}

/** Unified picker combining shared drives and My Drive folders in one list. */
function CombinedDrivePicker({
  drives,
  folders,
  selectedDriveIds,
  selectedFolderIds,
  onToggleDrive,
  onToggleFolder,
  disabled,
  connectorId,
}: {
  drives: Array<{ id: string; name: string }>;
  folders: Array<{ id: string; name: string }>;
  selectedDriveIds: Set<string>;
  selectedFolderIds: Set<string>;
  onToggleDrive: (id: string) => void;
  onToggleFolder: (id: string) => void;
  disabled?: boolean;
  connectorId: string;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalItems = drives.length + folders.length;
  const totalSelected = selectedDriveIds.size + selectedFolderIds.size;
  const allSelected = totalSelected === totalItems && totalItems > 0;

  const selectAll = () => {
    for (const d of drives) {
      if (!selectedDriveIds.has(d.id)) onToggleDrive(d.id);
    }
    for (const f of folders) {
      if (!selectedFolderIds.has(f.id)) onToggleFolder(f.id);
    }
  };

  const deselectAll = () => {
    for (const d of drives) {
      if (selectedDriveIds.has(d.id)) onToggleDrive(d.id);
    }
    for (const f of folders) {
      if (selectedFolderIds.has(f.id)) onToggleFolder(f.id);
    }
  };

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => (allSelected ? deselectAll() : selectAll())}
        disabled={disabled}
        className="flex w-full items-center gap-2 px-1 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <span className="inline-flex size-4 items-center justify-center rounded border border-border">
          {allSelected && <span className="size-2 rounded-sm bg-foreground" />}
        </span>
        {allSelected ? "Deselect all" : "Select all"} ({totalItems})
      </button>

      <div className="max-h-80 space-y-0.5 overflow-y-auto rounded-lg border border-border">
        {drives.map((drive) => {
          const isSelected = selectedDriveIds.has(drive.id);
          const isExpanded = expandedIds.has(drive.id);
          return (
            <div key={`drive-${drive.id}`}>
              <div
                className={`flex w-full items-center gap-1 px-1 py-2 text-left text-sm transition-colors hover:bg-muted/50 ${
                  isSelected ? "bg-muted/30" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(drive.id)}
                  className="flex shrink-0 items-center justify-center size-6 rounded hover:bg-muted/80 text-muted-foreground"
                  title="Preview drive contents"
                >
                  <CaretRightIcon size={12} className={`transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                </button>
                <button
                  type="button"
                  onClick={() => onToggleDrive(drive.id)}
                  disabled={disabled}
                  className="flex flex-1 items-center gap-2.5 disabled:opacity-50"
                >
                  <CheckboxIndicator checked={isSelected} />
                  {isExpanded ? (
                    <FolderOpenIcon size={16} className="shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderIcon size={16} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{drive.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">Shared</span>
                </button>
              </div>
              {isExpanded && <FolderContents connectorId={connectorId} folderId={drive.id} />}
            </div>
          );
        })}
        {folders.map((folder) => {
          const isSelected = selectedFolderIds.has(folder.id);
          const isExpanded = expandedIds.has(folder.id);
          return (
            <div key={`folder-${folder.id}`}>
              <div
                className={`flex w-full items-center gap-1 px-1 py-2 text-left text-sm transition-colors hover:bg-muted/50 ${
                  isSelected ? "bg-muted/30" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(folder.id)}
                  className="flex shrink-0 items-center justify-center size-6 rounded hover:bg-muted/80 text-muted-foreground"
                  title="Preview folder contents"
                >
                  <CaretRightIcon size={12} className={`transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                </button>
                <button
                  type="button"
                  onClick={() => onToggleFolder(folder.id)}
                  disabled={disabled}
                  className="flex flex-1 items-center gap-2.5 disabled:opacity-50"
                >
                  <CheckboxIndicator checked={isSelected} />
                  {isExpanded ? (
                    <FolderOpenIcon size={16} className="shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderIcon size={16} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{folder.name}</span>
                </button>
              </div>
              {isExpanded && <FolderContents connectorId={connectorId} folderId={folder.id} />}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {totalSelected} of {totalItems} item{totalItems === 1 ? "" : "s"} selected
      </p>
    </div>
  );
}

function CheckboxIndicator({ checked }: { checked: boolean }) {
  return (
    <span
      className={`inline-flex size-4 shrink-0 items-center justify-center rounded border ${
        checked ? "border-primary bg-primary" : "border-border"
      }`}
    >
      {checked && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3 text-primary-foreground"
          role="img"
          aria-label="Selected"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

function SaveScopeButton({
  onClick,
  isPending,
  count,
  label,
}: { onClick: () => void; isPending: boolean; count: number; label: string }) {
  return (
    <Button size="sm" className="mt-2 h-7 w-full gap-1.5 text-xs" onClick={onClick} disabled={isPending || count === 0}>
      {isPending ? (
        <>
          <SpinnerGapIcon size={12} className="animate-spin" />
          Saving...
        </>
      ) : (
        `Save & re-sync (${count} ${label}${count === 1 ? "" : "s"})`
      )}
    </Button>
  );
}

/* ─────────────────────────────────────────────────────────
 * Filter dropdown component
 * ───────────────────────────────────────────────────────── */

function FilterDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}) {
  if (value) {
    return (
      <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => onChange(null)}>
        {value}
        <XIcon size={10} className="text-muted-foreground" />
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
          {label}
          <CaretDownIcon size={12} className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((opt) => (
          <DropdownMenuItem key={opt.value} onClick={() => onChange(opt.value)}>
            {opt.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ─────────────────────────────────────────────────────────
 * Unified file row
 * ───────────────────────────────────────────────────────── */

function SearchResultRow({ result, onView }: { result: SearchResult; onView: () => void }) {
  const def = getIntegration(result.source as IntegrationType);
  const Icon =
    result.contentCategory === "document"
      ? FileTextIcon
      : result.contentCategory === "image"
        ? FileTextIcon
        : TableIcon;

  return (
    <div
      className="flex items-center gap-3 border-b border-border px-3 py-2.5 text-sm transition-colors hover:bg-muted/30 cursor-pointer"
      onClick={onView}
      onKeyDown={(e) => e.key === "Enter" && onView()}
    >
      <button type="button" onClick={onView} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon size={16} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{result.fileName}</p>
          {result.snippet ? (
            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{result.snippet}</p>
          ) : result.sourcePath ? (
            <p className="truncate text-[11px] text-muted-foreground">{result.sourcePath}</p>
          ) : result.summary ? (
            <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{result.summary}</p>
          ) : null}
          {result.tags && (
            <div className="mt-1 flex gap-1 flex-wrap">
              {JSON.parse(result.tags)
                .slice(0, 5)
                .map((tag: string) => (
                  <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {tag}
                  </span>
                ))}
            </div>
          )}
        </div>
      </button>

      <span className="w-24 text-center">
        {def ? (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <ConnectorLogo type={def.type} size={10} style={{ color: def.color }} />
            {def.name}
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px]">
            {result.source}
          </Badge>
        )}
      </span>

      <span className="w-16 text-center">
        <Badge variant="secondary" className="text-[10px]">
          {result.contentCategory === "document" ? "Doc" : result.contentCategory === "image" ? "Img" : "Data"}
        </Badge>
      </span>

      <span className="w-20 text-center">
        <span className="font-mono text-xs text-muted-foreground">{result.score.toFixed(4)}</span>
      </span>

      <span className="w-20 text-center">
        {result.similarity != null ? (
          <span className="font-mono text-xs text-muted-foreground">{(result.similarity * 100).toFixed(1)}%</span>
        ) : (
          <span className="text-[10px] text-muted-foreground/50">FTS only</span>
        )}
      </span>
    </div>
  );
}

function UnifiedFileRow({
  file,
  onView,
}: {
  file: UnifiedFile;
  onView: () => void;
}) {
  const def = getIntegration(file.source as IntegrationType);
  const Icon = file.contentCategory === "document" ? FileTextIcon : TableIcon;

  return (
    <div className="flex items-center gap-3 border-b border-border px-3 py-2.5 text-sm transition-colors hover:bg-muted/30">
      <button type="button" onClick={onView} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon size={16} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{file.fileName}</p>
          {file.sourcePath && <p className="truncate text-[11px] text-muted-foreground">{file.sourcePath}</p>}
        </div>
      </button>

      <span className="w-24 text-center">
        {def ? (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <ConnectorLogo type={def.type} size={10} style={{ color: def.color }} />
            {def.name}
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px]">
            {file.source}
          </Badge>
        )}
      </span>

      <span className="w-16 text-center">
        <Badge variant="secondary" className="text-[10px]">
          {file.contentCategory === "document" ? "Doc" : "Data"}
        </Badge>
      </span>

      <span className="w-20 text-center">
        {file.accessScope === "restricted" ? (
          <Badge variant="outline" className="gap-0.5 text-[10px] text-amber-500 border-amber-500/30">
            <LockSimpleIcon size={10} weight="fill" />
            {file.accessCount ?? 0}
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-0.5 text-[10px] text-muted-foreground">
            <GlobeIcon size={10} />
            Open
          </Badge>
        )}
      </span>

      <span className="w-20 text-center">
        {file.hasSummary ? (
          <Badge variant="outline" className="gap-0.5 text-[10px]">
            <SparkleIcon size={10} weight="fill" className="text-primary" />
            Enriched
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px]">
            Raw
          </Badge>
        )}
      </span>

      <span className="w-24 text-right text-xs text-muted-foreground">{formatRelativeTime(file.syncedAt)}</span>

      {file.providerUrl ? (
        <a
          href={file.providerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="w-5 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <ArrowSquareOutIcon size={14} />
        </a>
      ) : (
        <span className="w-5" />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * File detail sheet
 * ───────────────────────────────────────────────────────── */

function FileDetailSheet({ fileId, onClose }: { fileId: string | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["file-content", fileId],
    queryFn: () => api.integrations.fileContent(fileId as string),
    enabled: !!fileId,
  });

  const file = data?.file;
  const access = data?.access;

  return (
    <Sheet open={!!fileId} onOpenChange={(open: boolean) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-base">{isLoading ? "Loading..." : (file?.fileName ?? "File")}</SheetTitle>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-4 px-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-24 rounded-lg" />
              <Skeleton className="h-48 rounded-lg" />
            </div>
          ) : file ? (
            <FileDetailContent file={file} access={access ?? null} />
          ) : (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">File not found.</p>
            </div>
          )}
        </div>

        {file && <FileDetailFooter fileId={file.id} />}
      </SheetContent>
    </Sheet>
  );
}

function FileDetailContent({ file, access }: { file: FileContent; access: FileAccess | null }) {
  const def = getIntegration(file.source as IntegrationType);

  return (
    <div className="space-y-4 px-4 pb-6">
      <div className="flex flex-wrap gap-2">
        {def && (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <ConnectorLogo type={def.type} size={10} style={{ color: def.color }} />
            {def.name}
          </Badge>
        )}
        {file.fileType && (
          <Badge variant="secondary" className="text-[10px]">
            {file.fileType}
          </Badge>
        )}
        {file.enrichmentStatus === "enriched" && (
          <Badge variant="outline" className="gap-0.5 text-[10px]">
            <SparkleIcon size={10} weight="fill" className="text-primary" />
            Enriched
          </Badge>
        )}
        {access && (
          <Badge
            variant="outline"
            className={`gap-0.5 text-[10px] ${access.scope === "restricted" ? "text-amber-500 border-amber-500/30" : "text-muted-foreground"}`}
          >
            {access.scope === "restricted" ? (
              <>
                <LockSimpleIcon size={10} weight="fill" />
                {access.members.length} users
              </>
            ) : (
              <>
                <GlobeIcon size={10} />
                Open
              </>
            )}
          </Badge>
        )}
      </div>

      {file.sourcePath && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Path</p>
          <p className="mt-1 text-xs text-muted-foreground">{file.sourcePath}</p>
        </div>
      )}

      {file.providerUrl && (
        <a
          href={file.providerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          Open in source
          <ArrowSquareOutIcon size={12} />
        </a>
      )}

      {file.summary && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">AI Summary</p>
          <div className="mt-1 rounded-lg border border-primary/20 bg-primary/5 p-3">
            <p className="font-mono text-xs leading-relaxed">{file.summary}</p>
          </div>
        </div>
      )}

      {file.contextNote && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Context Note</p>
          <p className="mt-1 text-sm text-muted-foreground">{file.contextNote}</p>
        </div>
      )}

      {file.tags && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Tags</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {JSON.parse(file.tags).map((tag: string) => (
              <Badge key={tag} variant="secondary" className="text-[10px]">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {access && access.members.length > 0 && <AccessSection access={access} />}

      {file.content && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Content Preview</p>
          <pre className="mt-1 max-h-96 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {file.content.length > 2000 ? `${file.content.slice(0, 2000)}\u2026` : file.content}
          </pre>
        </div>
      )}
    </div>
  );
}

function FileDetailFooter({ fileId }: { fileId: string }) {
  const queryClient = useQueryClient();

  const enrichMutation = useMutation({
    mutationFn: () => api.integrations.enrichFile(fileId),
    onSuccess: () => {
      toast.success("Enrichment started — check server logs");
      queryClient.invalidateQueries({ queryKey: ["file-content", fileId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="border-t border-border px-4 py-3">
      <Button
        size="sm"
        variant="outline"
        className="w-full gap-1.5 text-xs"
        onClick={() => enrichMutation.mutate()}
        disabled={enrichMutation.isPending}
      >
        {enrichMutation.isPending ? (
          <>
            <SpinnerGapIcon size={12} className="animate-spin" />
            Enriching...
          </>
        ) : (
          <>
            <SparkleIcon size={12} />
            Generate Summary & Embeddings
          </>
        )}
      </Button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Access section — compact inline display with expand
 * ───────────────────────────────────────────────────────── */

const COLLAPSED_MEMBER_LIMIT = 3;

/** Display name for a member — prefers userName, then email. */
function memberDisplayName(member: { userName: string | null; email: string }) {
  return member.userName ?? member.email;
}

/** First letter for avatar — prefers name, then email, falls back to "#". */
function memberInitial(member: { userName: string | null; email: string }) {
  if (member.userName) return member.userName[0].toUpperCase();
  return member.email[0].toUpperCase();
}

function AccessSection({ access }: { access: FileAccess }) {
  const [expanded, setExpanded] = useState(false);
  const members = access.members;
  const mappedCount = members.filter((m) => m.mapped).length;
  const showExpand = members.length > COLLAPSED_MEMBER_LIMIT;
  const visibleMembers = expanded ? members : members.slice(0, COLLAPSED_MEMBER_LIMIT);
  const hiddenCount = members.length - COLLAPSED_MEMBER_LIMIT;

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Access ({members.length})
        </p>
        {mappedCount > 0 && (
          <Badge variant="outline" className="text-[9px] text-green-500 border-green-500/30">
            {mappedCount} mapped
          </Badge>
        )}
      </div>

      {/* Collapsed inline preview */}
      {!expanded && (
        <button
          type="button"
          onClick={() => showExpand && setExpanded(true)}
          className={`mt-1.5 flex items-center gap-1 ${showExpand ? "cursor-pointer" : "cursor-default"}`}
        >
          {/* Stacked avatars */}
          <div className="flex -space-x-1.5">
            {visibleMembers.map((member) => (
              <div
                key={member.email}
                className={`flex size-6 items-center justify-center rounded-full border-2 border-background text-[9px] font-medium ${
                  member.mapped ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}
                title={memberDisplayName(member)}
              >
                {memberInitial(member)}
              </div>
            ))}
          </div>
          <span className="ml-1 text-xs text-muted-foreground">
            {visibleMembers.map((m) => memberDisplayName(m)).join(", ")}
            {showExpand && <span className="ml-1 font-medium text-foreground">+{hiddenCount} more</span>}
          </span>
        </button>
      )}

      {/* Expanded full list */}
      {expanded && (
        <div className="mt-1.5 space-y-1">
          {members.map((member) => (
            <div key={member.email} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
              <div
                className={`flex size-6 items-center justify-center rounded-full text-[10px] font-medium ${
                  member.mapped ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}
              >
                {memberInitial(member)}
              </div>
              <div className="min-w-0 flex-1">
                {member.userName ? (
                  <p className="truncate text-xs font-medium">{member.userName}</p>
                ) : (
                  <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                )}
              </div>
              {member.mapped ? (
                <Badge variant="outline" className="text-[9px] text-green-500 border-green-500/30">
                  <LinkIcon size={8} className="mr-0.5" />
                  Mapped
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[9px]">
                  Unmapped
                </Badge>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="w-full rounded-md py-1 text-center text-[11px] text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors"
          >
            Show less
          </button>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Utilities
 * ───────────────────────────────────────────────────────── */

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
