/**
 * AutomationLockHolderResponseDialog — holder side of a pending takeover.
 *
 * Surfaces from the lock banner when `stealPending` is present while the
 * viewer holds the lock. Approving transfers the lock to the requester
 * (the polled lock view then flips the builder to read-only); denying leaves
 * the lock with the viewer.
 */
import type { AutomationEditLockView } from "@/lib/api";
import { api } from "@/lib/api";
import { SpinnerGapIcon, UserSwitchIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

export function AutomationLockHolderResponseDialog({
  taskId,
  open,
  onOpenChange,
  lock,
  lease,
  onResponded,
}: {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lock: AutomationEditLockView | null;
  lease: { clientSessionId: string; generation: number } | null;
  onResponded?: (lock: AutomationEditLockView) => void;
}) {
  const requesterName = lock?.stealPending?.requesterName ?? "Another member";
  const respondMutation = useMutation({
    mutationFn: (approve: boolean) => {
      if (!lease) throw new Error("The editing session is no longer active");
      return api.scheduledTasks.respondToStealRequest(taskId, approve, lease);
    },
    onSuccess: ({ lock: nextLock }, approve) => {
      if (nextLock) onResponded?.(nextLock);
      toast.success(approve ? `Control handed to ${requesterName}` : "Request declined");
      onOpenChange(false);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Couldn't respond to the request"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="automation-lock-holder-response-dialog">
        <div className="flex items-start gap-3">
          <div
            className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
            aria-hidden="true"
          >
            <UserSwitchIcon size={18} />
          </div>
          <DialogHeader className="min-w-0 flex-1 space-y-0 text-left">
            <DialogTitle className="text-[15px] leading-6">{requesterName} wants control</DialogTitle>
            <DialogDescription className="mt-0.5 text-[12px] leading-5">Waiting for you to respond.</DialogDescription>
          </DialogHeader>
        </div>

        <p className="rounded-[8px] bg-muted/40 px-3 py-2.5 text-[12px] leading-5 text-muted-foreground">
          Give control and {requesterName} can edit right away — your view becomes read-only. Deny to keep editing.
        </p>

        <DialogFooter className="sm:justify-between">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Keep editing
            </Button>
          </DialogClose>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-[7px] border-border/70 bg-background px-3 text-[12px] shadow-none"
              disabled={respondMutation.isPending}
              onClick={() => respondMutation.mutate(false)}
            >
              {respondMutation.isPending && respondMutation.variables === false ? (
                <SpinnerGapIcon size={14} className="animate-spin" />
              ) : null}
              Deny
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 rounded-[7px] bg-brand-accent px-3 text-[12px] text-[#161300] shadow-none hover:bg-brand-accent/90"
              disabled={respondMutation.isPending}
              onClick={() => respondMutation.mutate(true)}
            >
              {respondMutation.isPending && respondMutation.variables === true ? (
                <SpinnerGapIcon size={14} className="animate-spin" />
              ) : (
                <UserSwitchIcon size={14} />
              )}
              Give control
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
