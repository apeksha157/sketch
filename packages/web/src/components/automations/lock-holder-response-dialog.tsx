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
        <DialogHeader>
          <div className="grid size-10 place-items-center rounded-[12px] bg-muted text-foreground" aria-hidden="true">
            <UserSwitchIcon size={20} />
          </div>
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-[17px] font-semibold leading-6 tracking-[-0.01em]">
              {requesterName} wants control
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-5">Waiting for you to respond.</DialogDescription>
          </div>
        </DialogHeader>

        <p className="rounded-[10px] border border-border/60 bg-muted/40 px-3 py-2.5 text-[13px] leading-5 text-muted-foreground">
          Give control and {requesterName} can edit right away — your view becomes read-only. Keep editing to stay in
          control.
        </p>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" className="h-9 rounded-[8px] px-4 text-[13px]">
              Keep editing
            </Button>
          </DialogClose>
          <Button
            variant="outline"
            className="h-9 rounded-[8px] border-border/70 bg-background px-4 text-[13px] shadow-none"
            disabled={respondMutation.isPending}
            onClick={() => respondMutation.mutate(false)}
          >
            {respondMutation.isPending && respondMutation.variables === false ? (
              <SpinnerGapIcon size={15} className="animate-spin" />
            ) : null}
            Deny
          </Button>
          <Button
            className="h-9 gap-1.5 rounded-[8px] bg-brand-accent px-4 text-[13px] font-semibold text-[#161300] shadow-none hover:bg-brand-accent/90"
            disabled={respondMutation.isPending}
            onClick={() => respondMutation.mutate(true)}
          >
            {respondMutation.isPending && respondMutation.variables === true ? (
              <SpinnerGapIcon size={15} className="animate-spin" />
            ) : (
              <UserSwitchIcon size={15} />
            )}
            Give control
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
