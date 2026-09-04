import { api } from "@/lib/api";
import { SpinnerGapIcon } from "@phosphor-icons/react";
import type { CliIntegrationAppId, CliIntegrationConnection, CliIntegrationShareTarget } from "@sketch/shared";
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { Label } from "@sketch/ui/components/label";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GithubAppIcon, LinearAppIcon } from "./app-icon";
import { IntegrationSharingFields, type SharingMode } from "./integration-sharing-fields";

const apps = {
  github: {
    name: "GitHub",
    credential: "token",
    label: "Personal access token",
    credentialUrl: "https://github.com/settings/personal-access-tokens",
    icon: GithubAppIcon,
  },
  linear: {
    name: "Linear",
    credential: "API key",
    label: "Personal API key",
    credentialUrl: "https://linear.app/settings/account/security",
    icon: LinearAppIcon,
  },
} as const;

export type CliIntegrationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  onSuccess: (connection: CliIntegrationConnection) => void;
};

export function CliIntegrationDialog({
  appId,
  open,
  onOpenChange,
  isAdmin,
  onSuccess,
}: CliIntegrationDialogProps & { appId: CliIntegrationAppId }) {
  const app = apps[appId];
  const [credential, setCredential] = useState("");
  const [connection, setConnection] = useState<CliIntegrationConnection | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setCredential("");
    setConnection(null);
    setError(null);
  }, [open]);

  const connect = async () => {
    if (!credential.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.cliIntegrations.connect(appId, credential.trim(), []);
      setCredential("");
      setConnection(result.connection);
      onSuccess(result.connection);
    } catch (error) {
      setError(error instanceof Error ? error.message : `${app.name} could not be connected. Try again.`);
    } finally {
      setSaving(false);
    }
  };

  if (connection) {
    return (
      <CliConnectionSharingDialog
        connection={connection}
        open={open}
        onOpenChange={onOpenChange}
        isAdmin={isAdmin}
        justConnected
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 shadow-none sm:max-w-[28rem] [&>[data-slot=dialog-close]]:top-4 [&>[data-slot=dialog-close]]:right-4 [&>[data-slot=dialog-close]]:grid [&>[data-slot=dialog-close]]:size-8 [&>[data-slot=dialog-close]]:place-items-center [&>[data-slot=dialog-close]]:rounded-md [&>[data-slot=dialog-close]]:hover:bg-muted [&>[data-slot=dialog-close]]:focus:ring-foreground/50"
        showCloseButton={!saving}
      >
        <DialogHeader className="px-4 pt-5 pb-5 text-left sm:px-6 sm:pt-6">
          <div className="flex items-center gap-3 pr-6">
            <app.icon className="size-9 shrink-0" />
            <div>
              <DialogTitle>Connect {app.name}</DialogTitle>
              <DialogDescription className="mt-1">Connect your account to use {app.name} in Sketch.</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <div className="min-h-0 space-y-4 overflow-y-auto px-4 pb-5 sm:px-6 [scrollbar-width:thin] [scrollbar-color:var(--muted-foreground)_transparent]">
            <p className="text-sm text-muted-foreground">
              Your {app.credential} is encrypted in Sketch. Actions run with this account’s permissions in {app.name}.
            </p>
            <a
              className="inline-block text-sm underline underline-offset-4"
              href={app.credentialUrl}
              target="_blank"
              rel="noreferrer"
            >
              Create a {app.name} {app.label.toLowerCase()}
            </a>
            <div className="space-y-2">
              <Label htmlFor={`${appId}-credential`}>{app.label}</Label>
              <Input
                id={`${appId}-credential`}
                className="h-10 rounded-lg shadow-none focus-visible:border-muted-foreground focus-visible:ring-foreground/20 focus-visible:ring-2"
                type="password"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                autoComplete="new-password"
                placeholder={`Paste your ${app.name} ${app.credential}`}
                disabled={saving}
                aria-describedby={`${appId}-credential-help`}
              />
              <p id={`${appId}-credential-help`} className="text-sm text-muted-foreground">
                Your account starts private. You can choose who has access after connecting.
              </p>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter className="flex-row justify-end border-t border-border px-4 py-4 sm:px-6">
            <Button
              type="button"
              variant="ghost"
              className="h-10 min-w-20 rounded-lg text-muted-foreground hover:text-foreground focus-visible:ring-foreground/50 focus-visible:ring-2"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="h-10 min-w-28 rounded-lg shadow-none focus-visible:ring-foreground/50 focus-visible:ring-2 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
              disabled={!credential.trim() || saving}
            >
              {saving && <SpinnerGapIcon size={14} className="animate-spin motion-reduce:animate-none" />}
              {saving ? "Connecting…" : `Connect ${app.name}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type SharingDialogProps = {
  connection: CliIntegrationConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  onChanged?: () => void;
  justConnected?: boolean;
};

export function CliConnectionSharingDialog(props: SharingDialogProps) {
  return props.open ? <ConnectionSharingContent key={props.connection.id} {...props} /> : null;
}

function sharingMode(targets: CliIntegrationShareTarget[]): SharingMode {
  if (targets.some((target) => target.type === "org")) return "organization";
  return targets.length ? "members" : "personal";
}

function ConnectionSharingContent({ connection, onOpenChange, isAdmin, onChanged, justConnected }: SharingDialogProps) {
  const app = apps[connection.appId];
  const queryClient = useQueryClient();
  const [savedConnection, setSavedConnection] = useState(connection);
  const [mode, setMode] = useState<SharingMode>(() => sharingMode(connection.shares));
  const [accessEdited, setAccessEdited] = useState(false);
  const [selected, setSelected] = useState(() =>
    connection.shares.filter((target) => target.type === "user").map((target) => target.id),
  );
  const [credential, setCredential] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canManage = connection.canManage === true;
  const membersQuery = useQuery({
    queryKey: ["users"],
    queryFn: () => api.users.list(),
    enabled: canManage && mode === "members",
    retry: false,
  });
  const members = (membersQuery.data?.users ?? []).filter(
    (member) => member.id !== connection.ownerUserId && member.type !== "external",
  );
  const targets: CliIntegrationShareTarget[] =
    mode === "organization"
      ? [{ type: "org", id: "default" }]
      : mode === "members"
        ? selected.map((id) => ({ type: "user", id }))
        : [];
  const changed =
    accessEdited &&
    (mode !== sharingMode(savedConnection.shares) ||
      JSON.stringify(targets.map((target) => `${target.type}:${target.id}`).sort()) !==
        JSON.stringify(savedConnection.shares.map((target) => `${target.type}:${target.id}`).sort()));
  const valid =
    (mode !== "organization" || isAdmin) &&
    (mode !== "members" || (selected.length > 0 && !membersQuery.isPending && !membersQuery.isError));

  const run = async (operation: () => Promise<void>) => {
    if (!canManage || saving) return;
    setSaving(true);
    setError(null);
    try {
      await operation();
      for (const queryKey of [
        ["cli-integration-connections"],
        ["cli-integration-apps"],
        ["agent-environment-variables"],
        ["workspace", "summary"],
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
      onChanged?.();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Changes could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 shadow-none sm:max-w-[28rem] [&>[data-slot=dialog-close]]:top-4 [&>[data-slot=dialog-close]]:right-4 [&>[data-slot=dialog-close]]:grid [&>[data-slot=dialog-close]]:size-8 [&>[data-slot=dialog-close]]:place-items-center [&>[data-slot=dialog-close]]:rounded-md [&>[data-slot=dialog-close]]:hover:bg-muted [&>[data-slot=dialog-close]]:focus:ring-foreground/50"
        showCloseButton={!saving}
      >
        <DialogHeader className="px-4 pt-5 pb-5 text-left sm:px-6 sm:pt-6">
          <DialogTitle>Share integration</DialogTitle>
          <DialogDescription>
            {!canManage
              ? "Only the owner can manage this account’s access."
              : justConnected
                ? `${app.name} is connected. Choose who can run actions with this account.`
                : "Choose who can run actions with this account."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto px-4 pb-5 sm:px-6 [scrollbar-width:thin] [scrollbar-color:var(--muted-foreground)_transparent]">
          <div className="flex min-w-0 items-center gap-3 pb-1">
            <app.icon className="size-9 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{app.name}</p>
              <p className="break-all text-sm text-muted-foreground">
                {connection.appId === "github" ? "@" : ""}
                {savedConnection.accountLogin}
              </p>
            </div>
          </div>
          {canManage && (
            <>
              <IntegrationSharingFields
                mode={mode}
                onModeChange={(next) => {
                  setMode(next);
                  setAccessEdited(true);
                }}
                selected={selected}
                onSelectedChange={(next) => {
                  setSelected(next);
                  setAccessEdited(true);
                }}
                members={members}
                saving={saving}
                isLoading={membersQuery.isPending}
                isError={membersQuery.isError}
                onRetry={() => void membersQuery.refetch()}
                canShareOrganization={isAdmin}
              />
              {!justConnected && (
                <details className="border-t border-border pt-4">
                  <summary className="cursor-pointer rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Connection settings
                  </summary>
                  <div className="mt-4 space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Replace or verify the {app.credential} used by Sketch. Permissions are managed in {app.name}.
                    </p>
                    <Input
                      aria-label={`Replacement ${app.name} ${app.credential}`}
                      className="h-10 rounded-lg shadow-none focus-visible:border-muted-foreground focus-visible:ring-foreground/20 focus-visible:ring-2"
                      type="password"
                      value={credential}
                      onChange={(event) => setCredential(event.target.value)}
                      placeholder={`Paste a replacement ${app.credential}`}
                      autoComplete="new-password"
                      disabled={saving}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        className="h-10 rounded-lg shadow-none focus-visible:ring-foreground/50 focus-visible:ring-2"
                        disabled={!credential.trim() || saving}
                        onClick={() =>
                          void run(async () => {
                            const result = await api.cliIntegrations.updateCredential(
                              connection.appId,
                              connection.id,
                              credential.trim(),
                            );
                            setSavedConnection(result.connection);
                            setCredential("");
                            toast.success(`${app.name} ${app.credential} replaced`);
                          })
                        }
                      >
                        Replace {app.credential}
                      </Button>
                      <Button
                        variant="outline"
                        className="h-10 rounded-lg shadow-none focus-visible:ring-foreground/50 focus-visible:ring-2"
                        disabled={saving}
                        onClick={() =>
                          void run(async () => {
                            const result = await api.cliIntegrations.reverify(connection.appId, connection.id);
                            setSavedConnection(result.connection);
                            if (result.connection.status === "active") toast.success(`${app.name} connection verified`);
                            else setError(result.connection.lastVerificationError ?? `${app.name} verification failed`);
                          })
                        }
                      >
                        Verify connection
                      </Button>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Disconnecting removes access in Sketch. It does not revoke your {app.credential} in {app.name}.
                    </p>
                    <Button
                      variant="ghost"
                      className="h-10 rounded-lg text-destructive hover:text-destructive focus-visible:ring-foreground/50 focus-visible:ring-2"
                      disabled={saving}
                      onClick={() => {
                        if (!window.confirm(`Disconnect ${app.name} from Sketch?`)) return;
                        void run(async () => {
                          await api.cliIntegrations.disconnect(connection.appId, connection.id);
                          toast.success(`${app.name} disconnected`);
                          onOpenChange(false);
                        });
                      }}
                    >
                      Disconnect
                    </Button>
                  </div>
                </details>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="border-t border-border px-4 py-4 sm:px-6">
          <div className="flex w-full justify-end gap-2">
            <Button
              variant="ghost"
              className="h-10 min-w-20 rounded-lg text-muted-foreground hover:text-foreground focus-visible:ring-foreground/50 focus-visible:ring-2"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {(justConnected && !changed) || !canManage ? "Done" : "Cancel"}
            </Button>
            {canManage && (
              <Button
                className="h-10 min-w-28 rounded-lg shadow-none focus-visible:ring-foreground/50 focus-visible:ring-2 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
                disabled={!changed || !valid || saving}
                onClick={() =>
                  void run(async () => {
                    await api.cliIntegrations.replaceShares(connection.appId, connection.id, targets);
                    toast.success(mode === "personal" ? "This account is now private" : "Sharing updated");
                    onOpenChange(false);
                  })
                }
              >
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
