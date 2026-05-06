import { useCallback, useEffect, useState } from "react";
import type { OnboardingState } from "./types";

const STORAGE_KEY = "sketch.walkthrough.v1";

const INITIAL: OnboardingState = {
  has_seen_greeting: false,
  has_completed_walkthrough: false,
  current_walkthrough_step: null,
  walkthrough_paused: false,
  walkthrough_dismissed_count: 0,
};

function read(): OnboardingState {
  if (typeof window === "undefined") return INITIAL;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return INITIAL;
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return { ...INITIAL, ...parsed };
  } catch {
    return INITIAL;
  }
}

function write(state: OnboardingState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be disabled (private mode, quota) — silently no-op.
  }
}

/**
 * Hook around the persistent onboarding state. Reads once on mount and
 * mirrors writes to localStorage so a refresh or navigate-away resumes
 * cleanly.
 */
export function useWalkthroughState() {
  const [state, setState] = useState<OnboardingState>(read);

  useEffect(() => {
    write(state);
  }, [state]);

  const update = useCallback((patch: Partial<OnboardingState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL);
  }, []);

  return { state, update, reset };
}
