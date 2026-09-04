import { GithubAppIcon, LinearAppIcon } from "@/components/connections/app-icon";
import { GithubIntegrationRow } from "@/components/connections/github-integration-dialog";
import { LinearIntegrationRow } from "@/components/connections/linear-integration-dialog";
import { QuietAddButton } from "@/components/quiet-add-button";
import { api } from "@/lib/api";
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
import { getAbbreviation } from "@sketch/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";
import { IntegrationSharingFields, type SharingMode } from "./integration-sharing-fields";

export function IntegrationsSection({
  connections,
  isLoadingConnections,
  providerId,
  orgName,
  onAdd,
  onDisconnect,
  githubConnection,
  linearConnection,
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
              isAdmin={integrationIsAdmin}
              onChanged={onDisconnect}
            />
          )}
          {linearConnection && (
            <LinearIntegrationRow
              connection={linearConnection}
              isLast={connections.length === 0}
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

export function AccessSettingsDialog({
  connection,
  providerId,
  orgName,
  onOpenChange,
  onSaved,
}: {
  connection: IntegrationConnection | null;
  providerId: string;
  orgName?: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<SharingMode>("personal");
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const canManage = connection?.canManageAccess === true;
  const membersQuery = useQuery({
    queryKey: ["connection-members", providerId],
    queryFn: () => api.mcpServers.listConnectionMembers(providerId),
    enabled: canManage && mode === "members",
    retry: false,
  });

  useEffect(() => {
    setMode(
      connection?.accessLevel === "organization"
        ? "organization"
        : connection?.memberUserIds?.length
          ? "members"
          : "personal",
    );
    setSelected(connection?.memberUserIds ?? []);
    setSaveError(null);
  }, [connection]);

  if (!connection) return null;
  const members = (membersQuery.data ?? []).filter((member) => member.id !== connection.ownerUserId);
  const accessLevel = mode === "organization" ? "organization" : "personal";
  const memberUserIds = mode === "members" ? selected : [];
  const changed =
    accessLevel !== (connection.accessLevel ?? "personal") ||
    JSON.stringify([...memberUserIds].sort()) !== JSON.stringify([...(connection.memberUserIds ?? [])].sort());
  const valid = mode !== "members" || (selected.length > 0 && !membersQuery.isPending && !membersQuery.isError);
  const save = async () => {
    if (!canManage || !changed || !valid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.mcpServers.updateConnectionAccess(
        providerId,
        connection.id,
        accessLevel,
        connection.accessRevision ?? 0,
        memberUserIds,
      );
      toast.success(mode === "personal" ? "This account is now private" : "Sharing updated");
      onSaved();
      onOpenChange(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Sharing could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !saving && onOpenChange(open)}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 shadow-none sm:max-w-[28rem]"
        showCloseButton={!saving}
      >
        <DialogHeader className="px-4 pt-5 pb-5 text-left sm:px-6 sm:pt-6">
          <DialogTitle>Share integration</DialogTitle>
          <DialogDescription>
            {connection.isOwnedByViewer === false
              ? `${getOwnerDisplayName(connection)} shared this account with you. Only the owner can manage access.`
              : "Choose who can run actions with this account."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto px-4 pb-5 sm:px-6 [scrollbar-width:thin] [scrollbar-color:var(--muted-foreground)_transparent]">
          <div className="flex min-w-0 items-center gap-3 pb-1">
            <ConnectionIcon connection={connection} />
            <div className="min-w-0">
              <p className="text-sm font-medium">{connection.appName}</p>
              <p className="break-all text-sm text-muted-foreground">
                {connection.isOwnedByViewer === false
                  ? `Owned by ${getOwnerDisplayName(connection)}`
                  : getAccountDisplayName(connection) || "Your connected account"}
              </p>
            </div>
          </div>
          {canManage ? (
            <>
              <IntegrationSharingFields
                key={connection.id}
                mode={mode}
                onModeChange={setMode}
                selected={selected}
                onSelectedChange={setSelected}
                members={members}
                orgName={orgName}
                saving={saving}
                isLoading={membersQuery.isPending}
                isError={membersQuery.isError}
                onRetry={() => void membersQuery.refetch()}
                memberLimit={500}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">You can use this account in chats and automations.</p>
          )}
          {saveError && (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          )}
        </div>
        <DialogFooter className="border-t border-border px-4 py-4 sm:px-6">
          <div className="flex w-full justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {canManage ? "Cancel" : "Done"}
            </Button>
            {canManage && (
              <Button onClick={save} disabled={!changed || !valid || saving}>
                {saving && <SpinnerGapIcon size={14} className="animate-spin motion-reduce:animate-none" />}
                {saving ? "Saving…" : "Save access"}
              </Button>
            )}
          </div>
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
