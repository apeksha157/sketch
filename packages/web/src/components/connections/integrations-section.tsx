import { GithubAppIcon, LinearAppIcon } from "@/components/connections/app-icon";
import { GithubIntegrationRow } from "@/components/connections/github-integration-dialog";
import { LinearIntegrationRow } from "@/components/connections/linear-integration-dialog";
import { QuietAddButton } from "@/components/quiet-add-button";
import { type User, api } from "@/lib/api";
import { GearSixIcon, PlugIcon, SpinnerGapIcon, TrashIcon } from "@phosphor-icons/react";
import type { CliIntegrationConnection, IntegrationConnection } from "@sketch/shared";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { Switch } from "@sketch/ui/components/switch";
import { getAbbreviation } from "@sketch/ui/lib/utils";
import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";

export function IntegrationsSection({
  connections,
  isLoadingConnections,
  providerId,
  orgName,
  onAdd,
  onDisconnect,
  githubConnection,
  linearConnection,
  integrationUsers = [],
  integrationCurrentUserId = "",
  integrationIsAdmin = false,
}: {
  connections: IntegrationConnection[];
  isLoadingConnections: boolean;
  providerId?: string;
  orgName?: string;
  onAdd: () => void;
  onDisconnect: () => void;
  githubConnection?: CliIntegrationConnection | null;
  linearConnection?: CliIntegrationConnection | null;
  integrationUsers?: User[];
  integrationCurrentUserId?: string;
  integrationIsAdmin?: boolean;
}) {
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [settingsConnection, setSettingsConnection] = useState<IntegrationConnection | null>(null);

  const handleDisconnect = async (connectionId: string) => {
    if (!providerId) return;
    setDisconnectingId(connectionId);
    try {
      await api.mcpServers.removeConnection(providerId, connectionId);
      toast.success("Integration disconnected");
      onDisconnect();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setDisconnectingId(null);
    }
  };

  return (
    <div>
      {isLoadingConnections ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-4 border-b border-border last:border-b-0">
              <Skeleton className="size-9 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      ) : connections.length === 0 && !githubConnection && !linearConnection ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-brand-accent/[0.04] px-6 pt-8 pb-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full border border-brand-accent bg-white">
            <PlugIcon size={24} className="text-[#8B7A00]" />
          </div>
          <p className="mt-3 text-sm font-medium">No apps connected yet</p>
          <p className="mt-1.5 text-sm text-muted-foreground">Add an integration to connect your apps.</p>
          <QuietAddButton className="mt-4" onClick={onAdd}>
            Add integration
          </QuietAddButton>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {githubConnection && (
            <GithubIntegrationRow
              connection={githubConnection}
              isLast={connections.length === 0 && !linearConnection}
              users={integrationUsers}
              currentUserId={integrationCurrentUserId}
              isAdmin={integrationIsAdmin}
              onChanged={onDisconnect}
            />
          )}
          {linearConnection && (
            <LinearIntegrationRow
              connection={linearConnection}
              isLast={connections.length === 0}
              users={integrationUsers}
              currentUserId={integrationCurrentUserId}
              isAdmin={integrationIsAdmin}
              onChanged={onDisconnect}
            />
          )}
          {connections.map((connection, i) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              isLast={i === connections.length - 1}
              isDisconnecting={disconnectingId === connection.id}
              onDisconnect={() => handleDisconnect(connection.id)}
              onOpenSettings={() => setSettingsConnection(connection)}
            />
          ))}
        </div>
      )}
      {providerId && (
        <AccessSettingsDialog
          connection={settingsConnection}
          providerId={providerId}
          orgName={orgName}
          onOpenChange={(open) => !open && setSettingsConnection(null)}
          onSaved={onDisconnect}
        />
      )}
    </div>
  );
}

function ConnectionRow({
  connection,
  isLast,
  isDisconnecting,
  onDisconnect,
  onOpenSettings,
}: {
  connection: IntegrationConnection;
  isLast: boolean;
  isDisconnecting: boolean;
  onDisconnect: () => void;
  onOpenSettings: () => void;
}) {
  const isActive = connection.status === "active";
  const abbrev = getAbbreviation(connection.appName);
  const canOpenSettings = connection.source !== "pipedream";
  const accountLabel = getAccountDisplayName(connection);
  const ownerDisplayName = getOwnerDisplayName(connection);
  const connectedAt = connection.connectedAt ?? connection.createdAt;
  const isOrgShared = connection.accessLevel === "organization";
  const isSharedByAnotherUser = connection.isOwnedByViewer === false;
  const canDelete = connection.canDelete !== false && connection.isOwnedByViewer !== false;
  const metadata = [
    isSharedByAnotherUser ? `Owned by ${ownerDisplayName}` : accountLabel,
    `Connected ${formatDate(connectedAt)}`,
  ].filter(Boolean);

  return (
    <div className={`flex items-center gap-4 px-4 py-4 ${isLast ? "" : "border-b border-border"}`}>
      {connection.appId.trim().toLowerCase() === "github" ? (
        <GithubAppIcon className="size-9" />
      ) : connection.icon ? (
        <img
          src={connection.icon}
          alt={connection.appName}
          width={36}
          height={36}
          className="size-9 shrink-0 rounded-lg object-contain"
        />
      ) : (
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white"
          style={{ backgroundColor: "#6B7280", borderRadius: 8 }}
        >
          {abbrev}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-semibold">{connection.appName}</span>
          {(isOrgShared || isSharedByAnotherUser || (connection.memberUserIds?.length ?? 0) > 0) && (
            <Badge
              variant="outline"
              className="h-5 shrink-0 rounded-[4px] border-[#5A4F00] bg-brand-accent/15 px-2 py-0 text-[11px] font-semibold text-brand-accent"
            >
              {isOrgShared ? "Org shared" : isSharedByAnotherUser ? "Shared with you" : "Selected members"}
            </Badge>
          )}
        </div>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          {metadata.map((item, index) => (
            <Fragment key={item}>
              {index > 0 && <span aria-hidden="true">·</span>}
              <span className={index === 0 && item === accountLabel ? "max-w-[12rem] truncate" : undefined}>
                {item}
              </span>
            </Fragment>
          ))}
        </span>
        {connection.capabilityMessages?.map((message) => (
          <span key={message} className="mt-1 text-xs text-amber-600">
            {message}
          </span>
        ))}
      </div>

      <div className="ml-auto grid shrink-0 grid-cols-[5rem_1.75rem_1.75rem] items-center gap-2">
        <div className="flex items-center gap-1.5">
          {isActive ? (
            <>
              <span className="size-2 rounded-full bg-success" />
              <span className="text-xs text-muted-foreground">Active</span>
            </>
          ) : (
            <>
              <span className="size-2 rounded-full bg-destructive" />
              <span className="text-xs text-muted-foreground capitalize">{connection.status}</span>
            </>
          )}
        </div>

        <Button
          variant="ghost"
          size="icon"
          className={
            canOpenSettings
              ? "size-7 text-muted-foreground"
              : "size-7 cursor-not-allowed text-muted-foreground/40 hover:bg-transparent hover:text-muted-foreground/40"
          }
          aria-label={
            canOpenSettings
              ? `Open settings for ${connection.appName}`
              : `Settings unavailable for ${connection.appName}`
          }
          title={
            canOpenSettings ? `Open settings for ${connection.appName}` : "Settings are unavailable for Pipedream apps"
          }
          onClick={canOpenSettings ? onOpenSettings : undefined}
          disabled={!canOpenSettings}
        >
          <GearSixIcon size={14} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className={
            canDelete
              ? "size-7 text-muted-foreground hover:text-destructive"
              : "size-7 cursor-not-allowed text-muted-foreground/40 hover:bg-transparent hover:text-muted-foreground/40"
          }
          aria-label={`Disconnect ${connection.appName}`}
          title={canDelete ? `Disconnect ${connection.appName}` : "Only the owner can disconnect this app"}
          onClick={canDelete ? onDisconnect : undefined}
          disabled={!canDelete || isDisconnecting}
        >
          {isDisconnecting ? <SpinnerGapIcon size={14} className="animate-spin" /> : <TrashIcon size={14} />}
        </Button>
      </div>
    </div>
  );
}

function AccessSettingsDialog({
  connection,
  providerId,
  onOpenChange,
  onSaved,
}: {
  connection: IntegrationConnection | null;
  providerId: string;
  orgName?: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [members, setMembers] = useState<Array<{ id: string; name?: string; email?: string }>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelected(connection?.memberUserIds ?? []);
    if (connection?.canManageAccess) {
      void api.mcpServers
        .listConnectionMembers(providerId)
        .then(setMembers)
        .catch((error) => toast.error(error instanceof Error ? error.message : "Failed to load members"));
    }
  }, [connection, providerId]);

  if (!connection) return <Dialog open={false} onOpenChange={onOpenChange} />;
  const canManage = connection.canManageAccess === true;
  const visible = members.filter((member) => {
    const query = search.trim().toLowerCase();
    return (
      member.id !== connection.ownerUserId &&
      (!query || member.name?.toLowerCase().includes(query) || member.email?.toLowerCase().includes(query))
    );
  });
  const changed = JSON.stringify([...selected].sort()) !== JSON.stringify([...(connection.memberUserIds ?? [])].sort());
  const save = async () => {
    if (!canManage || !changed) return;
    setSaving(true);
    try {
      await api.mcpServers.updateConnectionMembers(providerId, connection.id, connection.accessRevision ?? 0, selected);
      toast.success("Selected members updated");
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update selected members");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!connection} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{connection.appName}</DialogTitle>
          <DialogDescription>
            {connection.isOwnedByViewer === false
              ? `${getOwnerDisplayName(connection)} shared this account with you. Only the owner can manage access.`
              : "Choose organization members who may run actions with this account. Empty is private."}
          </DialogDescription>
        </DialogHeader>
        {canManage ? (
          <div className="space-y-3">
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search members"
            />
            <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border border-border p-3">
              {visible.map((member) => (
                <label key={member.id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(member.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...new Set([...current, member.id])]
                          : current.filter((id) => id !== member.id),
                      )
                    }
                  />
                  <span>{member.name || member.email || member.id}</span>
                </label>
              ))}
              {visible.length === 0 && <p className="text-sm text-muted-foreground">No members found.</p>}
            </div>
            <p className="text-xs text-muted-foreground">{selected.length} selected</p>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canManage || !changed || saving}>
            {saving ? <SpinnerGapIcon size={14} className="animate-spin" /> : null} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionIcon({
  connection,
  size = "default",
}: {
  connection: IntegrationConnection;
  size?: "default" | "lg";
}) {
  const classes = size === "lg" ? "size-10 rounded-lg" : "size-9 rounded-lg";
  if (connection.appId.trim().toLowerCase() === "github") {
    return <GithubAppIcon className={classes} />;
  }
  if (connection.appId.trim().toLowerCase() === "linear") {
    return <LinearAppIcon className={classes} />;
  }
  if (connection.icon) {
    const dimensions = size === "lg" ? 40 : 36;
    return (
      <img
        src={connection.icon}
        alt={connection.appName}
        width={dimensions}
        height={dimensions}
        className={`${classes} shrink-0 object-contain`}
      />
    );
  }
  return (
    <div
      className={`${classes} flex shrink-0 items-center justify-center text-[11px] font-bold text-white`}
      style={{ backgroundColor: "#6B7280", borderRadius: 8 }}
    >
      {getAbbreviation(connection.appName)}
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getOwnerDisplayName(connection: IntegrationConnection): string {
  const ownerName = normalizeDisplayName(connection.ownerName);
  if (ownerName && !isEmailAddress(ownerName)) return ownerName;

  if (connection.isOwnedByViewer === true) return "You";

  return "teammate";
}

function getAccountDisplayName(connection: IntegrationConnection): string | null {
  if (isApiKeyIntegration(connection)) return null;

  const accountName = normalizeDisplayName(connection.accountName);
  if (!accountName) return null;
  if (isKeyLikeAccountName(accountName)) return null;

  const appName = normalizeDisplayName(connection.appName);
  if (appName && accountName.toLocaleLowerCase() === appName.toLocaleLowerCase()) return null;

  return accountName;
}

function isApiKeyIntegration(connection: IntegrationConnection): boolean {
  const authType = connection.authType?.toLocaleLowerCase().replaceAll(/[\s_-]/g, "");
  if (authType === "apikey" || authType === "key" || authType === "token") return true;

  return connection.appId === "app-store-connect";
}

function isKeyLikeAccountName(value: string): boolean {
  const normalized = value.trim();
  if (/^(api\s*)?key\b/i.test(normalized)) return true;
  if (/^(key|token|secret|issuer)\s*id\b/i.test(normalized)) return true;
  if (/^[A-Z0-9_-]{6,20}$/.test(normalized) && /[0-9]/.test(normalized)) return true;
  return false;
}

function normalizeDisplayName(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : null;
}

function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
