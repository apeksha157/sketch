/**
 * Persistent state for the Sketch onboarding widget. Stored under a single
 * localStorage key so future versions can bump the schema cleanly.
 */
export interface OnboardingState {
  has_seen_greeting: boolean;
  has_completed_walkthrough: boolean;
  current_walkthrough_step: number | null;
  /** True when the user clicked outside the tour but didn't dismiss it.
   *  A "Resume (n/4)" pill appears next to the bubble; clicking it picks up
   *  where they left off. Distinct from `current_walkthrough_step` in that
   *  paused implies "user wants to do something else for a moment". */
  walkthrough_paused: boolean;
  walkthrough_dismissed_count: number;
}

/**
 * Top-level UI state of the widget. Drives which surface is visible
 * (bubble, panel-with-greeting, walkthrough overlay, etc).
 */
export type WidgetState =
  | { kind: "collapsed" }
  | { kind: "greeting" }
  | { kind: "walkthrough"; step: 1 | 2 | 3 | 4 }
  /** User clicked outside mid-tour. Bubble + Resume pill visible. Step preserved. */
  | { kind: "paused"; step: 1 | 2 | 3 | 4 }
  | { kind: "closing" }
  | { kind: "post-tour" };

export interface WalkthroughStep {
  /** 1-based step number, used for progress dots */
  index: 1 | 2 | 3 | 4;
  /** CSS selector to query for the target element */
  selector: string;
  /** Where the tooltip sits relative to the target */
  placement: "bottom" | "right";
  /** Tooltip body — short paragraph */
  body: React.ReactNode;
  /** "Next" or "Done" — the final step says "Done" */
  cta: "Next" | "Done";
}
