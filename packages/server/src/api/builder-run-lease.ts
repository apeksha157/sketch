import { LOCK_HEARTBEAT_INTERVAL_MS } from "../automation/lock-service";
import type { BuilderConversationAccessResult } from "../automation/task-conversations";

/** Transient failures may retry within the confirmed lease, never beyond its expiry. */
export function maintainBuilderRunLease(params: {
  expiresAt: string;
  generation: number;
  signal: AbortSignal;
  renew: () => Promise<BuilderConversationAccessResult>;
  onLost: (reason: "lease_lost" | "lease_expired") => void;
  onError: (error: unknown, expiresAt: number) => void;
}) {
  let expiresAt = Date.parse(params.expiresAt);
  let stopped = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const stop = () => {
    stopped = true;
    clearTimeout(renewalTimer);
    clearTimeout(expiryTimer);
    params.signal.removeEventListener("abort", stop);
  };
  const armExpiry = () => {
    clearTimeout(expiryTimer);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      params.onLost("lease_expired");
      stop();
      return;
    }
    expiryTimer = setTimeout(() => {
      params.onLost("lease_expired");
      stop();
    }, expiresAt - Date.now());
  };
  const refresh = (): Promise<void> => {
    if (stopped || params.signal.aborted) return Promise.resolve();
    if (inFlight) return inFlight;
    clearTimeout(renewalTimer);
    if (expiresAt <= Date.now()) {
      params.onLost("lease_expired");
      stop();
      return Promise.resolve();
    }
    inFlight = (async () => {
      try {
        const access = await params.renew();
        if (stopped) return;
        if (Date.now() >= expiresAt) {
          params.onLost("lease_expired");
          stop();
        } else if (access.kind !== "active" || access.lock.generation !== params.generation) {
          params.onLost("lease_lost");
          stop();
        } else {
          expiresAt = Date.parse(access.lock.expiresAt ?? "");
          armExpiry();
        }
      } catch (error) {
        if (!stopped) params.onError(error, expiresAt);
      } finally {
        inFlight = undefined;
        if (!stopped) renewalTimer = setTimeout(() => void refresh(), LOCK_HEARTBEAT_INTERVAL_MS);
      }
    })();
    return inFlight;
  };

  if (params.signal.aborted) stop();
  else {
    params.signal.addEventListener("abort", stop, { once: true });
    armExpiry();
    if (!stopped) renewalTimer = setTimeout(() => void refresh(), LOCK_HEARTBEAT_INTERVAL_MS);
  }
  return { refresh, stop };
}
