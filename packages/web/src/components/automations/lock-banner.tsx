import type { AutomationEditLockView } from "@/lib/api";
/**
 * AutomationLockBanner — toolbar strip for the whole-automation edit lock.
 *
 * The backend contract carries no "acquired at" timestamp, only the lease
 * `expiresAt` plus a fixed 15-minute TTL, so the "editing since" label is
 * derived as `expiresAt - TTL`. The banner renders three states:
 *
 * - held by another member: read-only hint + "Take over editing" entry point
 * - held by the viewer: "You're editing"
 * - held by the viewer with a pending steal request: prompt that opens the
 *   holder response dialog (approve/deny)
 *
 * The viewer's lock state is driven by polling the definition endpoint (see
 * the builder), so this component is purely presentational.
 */
import { LockIcon, UserFocusIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { useEffect, useState } from "react";

export const AUTOMATION_EDIT_LOCK_TTL_MS = 90 * 1000;
export const AUTOMATION_EDIT_LOCK_HEARTBEAT_INTERVAL_MS = 20 * 1000;
export const AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS = 10 * 1000;
export const AUTOMATION_EDIT_LOCK_STEAL_REQUEST_TTL_MS = 60 * 1000;

/**
 * Live clock that only ticks while `active`, so closed dialogs and unlocked
 * builders never re-render on a timer.
 */
export function useLockNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

function formatLockClock(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

/**
 * "Editing since" label: the lock contract exposes only the lease expiry, so
 * the acquisition time is reconstructed as `expiresAt - TTL`.
 */
export function lockSinceLabel(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const acquiredAt = new Date(expiresAt).getTime() - AUTOMATION_EDIT_LOCK_TTL_MS;
  if (Number.isNaN(acquiredAt)) return null;
  return formatLockClock(new Date(acquiredAt).toISOString());
}

/** mm:ss remaining until the given ISO deadline, floored at zero. */
export function lockRemainingLabel(expiresAt: string | null, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const remainingMs = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(remainingMs)) return null;
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The banner is one of the toolbar's cards, so it borrows the identity pill's
 * exact shell — same 36px height, 13px radius, neutral card surface and border.
 * Lock status is carried by a single quiet neutral icon, never a loud tint or
 * off-brand colour, matching the builder's toast + pill language.
 */
const lockBannerCardClass =
  "flex min-w-0 items-center gap-2 rounded-[13px] border border-border/70 bg-card/95 py-1 pr-1.5 pl-2.5 shadow-md backdrop-blur";
const lockBannerLabelClass = "min-w-0 truncate text-[13px] text-foreground/70";
const lockBannerDividerClass = "h-4 w-px shrink-0 bg-border/70";
const lockBannerActionClass =
  "h-7 shrink-0 rounded-[8px] px-2 text-[13px] font-medium text-foreground shadow-none transition-colors hover:bg-muted";

export function AutomationLockBanner({
  lock,
  canEdit,
  onRequestTakeover,
  onReviewStealRequest,
}: {
  lock: AutomationEditLockView | null;
  canEdit: boolean;
  onRequestTakeover: () => void;
  onReviewStealRequest: () => void;
}) {
  if (!lock?.heldByUserId) return null;

  if (lock.isHeldByMe) {
    const stealPending = lock.stealPending;
    if (!stealPending) return null;
    return (
      <div data-testid="automation-lock-banner" data-lock-state="held-by-me" className={lockBannerCardClass}>
        <UserFocusIcon size={13} className="shrink-0 text-muted-foreground" />
        <span className={lockBannerLabelClass}>
          <span className="font-medium text-foreground/80">{stealPending.requesterName}</span> wants control
        </span>
        <span className={lockBannerDividerClass} aria-hidden />
        <Button size="sm" variant="ghost" className={lockBannerActionClass} onClick={onReviewStealRequest}>
          Review
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="automation-lock-banner" data-lock-state="held-by-other" className={lockBannerCardClass}>
      <LockIcon size={13} className="shrink-0 text-muted-foreground" />
      <span className={lockBannerLabelClass}>
        {lock.isHeldByMyOtherSession ? "Open in another session" : `${lock.heldByName ?? "Someone"} is editing`}
      </span>
      {canEdit ? (
        <>
          <span className={lockBannerDividerClass} aria-hidden />
          <Button size="sm" variant="ghost" className={lockBannerActionClass} onClick={onRequestTakeover}>
            Request control
          </Button>
        </>
      ) : null}
    </div>
  );
}
