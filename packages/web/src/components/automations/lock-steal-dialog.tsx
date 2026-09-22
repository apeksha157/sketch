/**
 * AutomationLockStealDialog — requester side of the whole-automation edit lock.
 *
 * The viewer (read-only because another member holds the lock) requests a
 * takeover here. The backend returns the pending lock snapshot; whether the
 * request was approved, denied, or expired is then learned from the lock view that
 * the builder polls, so the dialog watches the live `lock` prop:
 *
 * - `lock.isHeldByMe` becomes true  -> approved: toast + close (heartbeat
 *   starts in the builder once the viewer is the holder)
 * - `stealPending` disappears       -> denied: toast + terminal state
 * - the request deadline passes     -> expired: timeout state + toast
 */
import {
  AUTOMATION_EDIT_LOCK_STEAL_REQUEST_TTL_MS,
  lockRemainingLabel,
  useLockNow,
} from "@/components/automations/lock-banner";
import type { AutomationEditLockView } from "@/lib/api";
import { api } from "@/lib/api";
import { HourglassMediumIcon, LockKeyIcon, SpinnerGapIcon, UserSwitchIcon, XCircleIcon } from "@phosphor-icons/react";
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
import { cn } from "@sketch/ui/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type StealPhase = "confirm" | "waiting" | "denied" | "expired";

export function AutomationLockStealDialog({
  taskId,
  open,
  onOpenChange,
  lock,
  clientSessionId,
  generation,
  onRequested,
}: {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lock: AutomationEditLockView | null;
  clientSessionId: string;
  generation?: number;
  onRequested?: (lock: AutomationEditLockView) => void;
}) {
  const [phase, setPhase] = useState<StealPhase>("confirm");
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const sawPendingRef = useRef(false);
  const resolvedRef = useRef(false);
  const holderName = lock?.heldByName ?? "the current editor";
  const heldByMyOtherSession = lock?.isHeldByMyOtherSession === true;
  const stealPending = lock?.stealPending ?? null;
  const now = useLockNow(phase === "waiting");

  const stealMutation = useMutation({
    mutationFn: () =>
      api.scheduledTasks.requestSteal(taskId, {
        clientSessionId,
        ...(generation === undefined ? {} : { generation }),
      }),
    onSuccess: ({ lock: nextLock }) => {
      if (nextLock) onRequested?.(nextLock);
      setRequestedAt(Date.now());
      setPhase("waiting");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Couldn't request control"),
  });

  useEffect(() => {
    if (!open) {
      setPhase("confirm");
      setRequestedAt(null);
      sawPendingRef.current = false;
      resolvedRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (phase === "waiting" && stealPending) sawPendingRef.current = true;
  }, [phase, stealPending]);

  const deadline = useMemo(() => {
    if (stealPending?.expiresAt) return new Date(stealPending.expiresAt).getTime();
    return requestedAt ? requestedAt + AUTOMATION_EDIT_LOCK_STEAL_REQUEST_TTL_MS : null;
  }, [requestedAt, stealPending?.expiresAt]);

  useEffect(() => {
    if (phase !== "waiting" || resolvedRef.current) return;
    if (lock?.isHeldByMe) {
      resolvedRef.current = true;
      toast.success("You now have control");
      onOpenChange(false);
      return;
    }
    if (sawPendingRef.current && !stealPending) {
      resolvedRef.current = true;
      toast.error("Your request was declined");
      setPhase("denied");
      return;
    }
    if (deadline !== null && now >= deadline) {
      resolvedRef.current = true;
      toast.error("Your request timed out");
      setPhase("expired");
    }
  }, [deadline, lock?.isHeldByMe, now, onOpenChange, phase, stealPending]);

  const waitingCountdown = useMemo(() => {
    if (deadline === null) return null;
    return lockRemainingLabel(new Date(deadline).toISOString(), now);
  }, [deadline, now]);

  const isBad = phase === "denied" || phase === "expired";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="automation-lock-steal-dialog">
        <DialogHeader>
          <div
            className={cn(
              "grid size-10 place-items-center rounded-[12px]",
              isBad ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground",
            )}
            aria-hidden="true"
          >
            {phase === "confirm" ? (
              <UserSwitchIcon size={20} />
            ) : phase === "waiting" ? (
              <SpinnerGapIcon size={20} className="animate-spin" />
            ) : phase === "expired" ? (
              <HourglassMediumIcon size={20} />
            ) : (
              <XCircleIcon size={20} weight="fill" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-[17px] font-semibold leading-6 tracking-[-0.01em]">
              {phase === "confirm"
                ? "Request control"
                : phase === "waiting"
                  ? "Waiting for approval"
                  : phase === "denied"
                    ? "Request declined"
                    : "Request timed out"}
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-5">
              {phase === "confirm" ? (
                heldByMyOtherSession ? (
                  "This automation is open in another of your sessions."
                ) : (
                  `${holderName} is editing this automation right now.`
                )
              ) : phase === "waiting" ? (
                <>Waiting for {holderName} to respond.</>
              ) : phase === "denied" ? (
                <>You can ask again, or wait for their editing to time out.</>
              ) : (
                <>{holderName} didn't respond in time. You can ask for control again.</>
              )}
            </DialogDescription>
          </div>
        </DialogHeader>

        {phase === "confirm" ? (
          <p className="rounded-[10px] border border-border/60 bg-muted/40 px-3 py-2.5 text-[13px] leading-5 text-muted-foreground">
            They'll be asked to hand over control, and the automation stays read-only until they do
            {heldByMyOtherSession ? "." : ` — only ${holderName} can approve.`}
          </p>
        ) : null}

        {phase === "waiting" ? (
          <div className="flex items-center justify-between gap-2 rounded-[10px] border border-border/60 bg-muted/40 px-3 py-2.5 text-[13px] text-foreground/85">
            <span className="min-w-0 flex-1">The automation is still read-only for now.</span>
            {waitingCountdown ? (
              <span
                data-testid="automation-lock-steal-countdown"
                className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground"
              >
                {waitingCountdown} LEFT
              </span>
            ) : null}
          </div>
        ) : null}

        {isBad ? (
          <div
            data-testid="automation-lock-steal-outcome"
            className="rounded-[10px] border border-destructive/25 bg-destructive/[0.06] px-3 py-2.5 text-[13px] text-destructive"
          >
            {phase === "expired" ? "Your request timed out." : "The holder declined your request."}
          </div>
        ) : null}

        <DialogFooter>
          {phase === "confirm" ? (
            <>
              <DialogClose asChild>
                <Button variant="ghost" className="h-9 rounded-[8px] px-4 text-[13px]">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                className="h-9 gap-1.5 rounded-[8px] bg-brand-accent px-4 text-[13px] font-semibold text-[#161300] shadow-none hover:bg-brand-accent/90"
                disabled={stealMutation.isPending}
                onClick={() => stealMutation.mutate()}
              >
                {stealMutation.isPending ? (
                  <SpinnerGapIcon size={15} className="animate-spin" />
                ) : (
                  <LockKeyIcon size={15} />
                )}
                Request control
              </Button>
            </>
          ) : (
            <DialogClose asChild>
              <Button variant="ghost" className="h-9 rounded-[8px] px-4 text-[13px]">
                Close
              </Button>
            </DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
