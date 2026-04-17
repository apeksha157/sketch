/**
 * Trial banner state hook.
 *
 * Computes which banner state to show (celebration / urgency / none)
 * based on trial start date. Dismiss is session-scoped (resets on page reload).
 *
 * TODO: Replace mock trial data with real API response once the backend
 * exposes trial status on the session endpoint.
 */
import { useCallback, useState } from "react";

export type TrialBannerState = "celebration" | "urgency" | "none";

export interface TrialInfo {
  state: TrialBannerState;
  daysElapsed: number;
  daysLeft: number;
  dismissed: boolean;
  dismiss: () => void;
}

/**
 * Mock trial start date — 1 day ago by default.
 * Change this to test different states:
 *   - 0–9 days ago → State A (celebration)
 *   - 10–14 days ago → State B (urgency)
 *   - 15+ days ago → no banner
 */
const MOCK_TRIAL_START = new Date();
MOCK_TRIAL_START.setDate(MOCK_TRIAL_START.getDate() - 1);

/** Default to true so the banner is hidden unless a route explicitly shows it via ?trial=<day>. */
const MOCK_HAS_PLAN = true;

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function useTrialBanner(): TrialInfo {
  const [dismissed, setDismissed] = useState(false);

  const dismiss = useCallback(() => setDismissed(true), []);

  // TODO: pull trialStartDate and hasPlan from API/session context
  const trialStartDate = MOCK_TRIAL_START;
  const hasPlan = MOCK_HAS_PLAN;

  const daysElapsed = daysBetween(trialStartDate, new Date());
  const daysLeft = Math.max(0, 15 - daysElapsed);

  let state: TrialBannerState;
  if (hasPlan || daysLeft <= 0) {
    state = "none";
  } else if (daysElapsed < 11) {
    state = "celebration";
  } else {
    state = "urgency";
  }

  return { state, daysElapsed, daysLeft, dismissed, dismiss };
}
