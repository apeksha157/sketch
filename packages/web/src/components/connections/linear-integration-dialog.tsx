import { LinearAppIcon } from "@/components/connections/app-icon";
import { api } from "@/lib/api";
import { GearSixIcon, SpinnerGapIcon, TrashIcon } from "@phosphor-icons/react";
import type { CliIntegrationConnection } from "@sketch/shared";
import { Button } from "@sketch/ui/components/button";
import { useState } from "react";
import { toast } from "sonner";
import {
  CliConnectionSharingDialog,
  CliIntegrationDialog,
  type CliIntegrationDialogProps,
} from "./cli-integration-dialog";

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function LinearIntegrationRow({
  connection,
  isLast,
  onChanged,
  isAdmin,
}: {
  isAdmin: boolean;
  connection: CliIntegrationConnection;
  isLast: boolean;
  onChanged: () => void;
}) {
  const [manageOpen, setManageOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const canManage = connection.canManage === true;

  const disconnect = async () => {
    if (!canManage || disconnecting || !window.confirm("Disconnect Linear from Sketch?")) return;
    setDisconnecting(true);
    try {
      await api.cliIntegrations.disconnect("linear", connection.id);
      toast.success("Linear disconnected");
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Linear could not be disconnected");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <>
      <div className={`flex items-center gap-4 px-4 py-4 ${isLast ? "" : "border-b border-border"}`}>
        <LinearAppIcon className="size-9" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold">Linear</span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            <span className="max-w-[16rem] truncate">{connection.accountLogin}</span>
            <span aria-hidden="true">·</span>
            <span>Connected {formatDate(connection.createdAt)}</span>
          </span>
        </div>
        <div className="ml-auto grid shrink-0 grid-cols-[5rem_1.75rem_1.75rem] items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span
              className={`size-2 rounded-full ${connection.status === "active" ? "bg-success" : "bg-destructive"}`}
            />
            <span className="text-xs text-muted-foreground">
              {connection.status === "active" ? "Active" : connection.status}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className={canManage ? "size-7 text-muted-foreground" : "size-7 text-muted-foreground/40"}
            aria-label="Open settings for Linear"
            title={canManage ? "Open settings for Linear" : "Only the owner can manage Linear"}
            onClick={() => setManageOpen(true)}
            disabled={!canManage}
          >
            <GearSixIcon size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={
              canManage ? "size-7 text-muted-foreground hover:text-destructive" : "size-7 text-muted-foreground/40"
            }
            aria-label="Disconnect Linear"
            title={canManage ? "Disconnect Linear" : "Only the owner can disconnect Linear"}
            onClick={() => void disconnect()}
            disabled={!canManage || disconnecting}
          >
            {disconnecting ? <SpinnerGapIcon size={14} className="animate-spin" /> : <TrashIcon size={14} />}
          </Button>
        </div>
      </div>
      <CliConnectionSharingDialog
        connection={connection}
        open={manageOpen}
        onOpenChange={setManageOpen}
        onChanged={onChanged}
        isAdmin={isAdmin}
      />
    </>
  );
}

export function LinearIntegrationDialog(props: CliIntegrationDialogProps) {
  return <CliIntegrationDialog appId="linear" {...props} />;
}
