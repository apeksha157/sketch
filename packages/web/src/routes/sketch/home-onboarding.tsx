/**
 * /home/onboarding — the unified onboarding prototype.
 *
 * One interactive page that walks through every state of the new onboarding
 * design. All state lives in component state so the prototype is fully
 * clickable end-to-end — no URL hopping between sub-routes.
 *
 * The flow:
 *
 *   1. Welcome video overlay (~70% of viewport, dim back). Skippable via
 *      ×, the "Skip to walkthrough" text link, or clicking the dim.
 *      No "Want a tour?" modal afterwards — a second consecutive overlay
 *      would be consent fatigue. The video either funnels motivated users
 *      directly to the tour (via the text link) or lands everyone else
 *      on the dashboard with the tray + help panel as the discovery
 *      surface for the walkthrough.
 *      ↓
 *   2. Coach-mark tour walking the 5 setup steps in spec order:
 *      Channels → Team → Integrations → Skills → Scheduled tasks. The
 *      tour is *explanation only* — it tells the user what each step
 *      is for. It does NOT mark anything done in the tray. The tray
 *      only ticks when the user actually does the underlying action
 *      (in this prototype, clicking the tray chip is the shortcut for
 *      "the user did the real thing").
 *
 *      Mid-flow, steps the user has already completed are skipped —
 *      no point lecturing them about channels they've already wired up.
 *      Step counter recalibrates ("Step 1 of 3" when 2 are already done).
 *      A replay from the helper bubble after 5/5 plays the *full* tour
 *      as a refresher, not zero steps. Reached via the video's "Skip
 *      to walkthrough" link, or later from the tray's help panel
 *      ("Re-take walkthrough").
 *      ↓
 *   3. Setup tray. Chips are clickable — tapping toggles done state.
 *      In the real product the chip ticks when the user finishes the
 *      underlying setup task (connects the integration, invites the
 *      teammate); in this prototype the chip click stands in for that
 *      action. Help button opens a panel with three actions wired to
 *      Continue setup (closes the panel), Re-take walkthrough (replays
 *      the coach mark), Watch intro (replays the video).
 *      ↓
 *   4. When chip clicks drive doneCount to 5/5 the tray swells with a
 *      brief celebration animation and switches to the yellow "Nice
 *      work — Sketch is set up" bar with a "Got it" CTA.
 *      ↓
 *   5. Got it slides the tray down and the helper bubble pops in
 *      bottom-right. Panel is open by default with the post-setup
 *      contents: Re-take walkthrough · Re-watch intro · Contact our team.
 *      Both replays kick back to the relevant overlay and return to the
 *      bubble on dismiss (since setup is still complete).
 *
 * Setup steps follow logical setup order: channels (where Sketch lives) →
 * team (who's in the room) → integrations (tools it can touch) → skills
 * (what it knows how to do) → schedule (when it runs on its own). The
 * coach-mark therefore hops around the sidebar a little — Team sits at
 * the bottom — but the tray chip numbering matches the tour step number,
 * which is the more important consistency.
 */
import { CoachMark } from "@/components/sketch/coach-mark";
import { HomePane } from "@/components/sketch/home-pane";
import { type BubbleStep, OnboardingBubbleHelper } from "@/components/sketch/onboarding-bubble-helper";
import { OnboardingSetupTray, type OnboardingStep } from "@/components/sketch/onboarding-setup-tray";
import { OnboardingVideoOverlay } from "@/components/sketch/onboarding-video-overlay";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_FILES, MOCK_FILES_EMPTY, MOCK_SETUP_DIGEST } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

type Stage = "video" | "tour" | "tray" | "helper";
type StepId = "channel" | "integration" | "teammate" | "skill" | "schedule";

const STEP_ORDER: StepId[] = ["channel", "teammate", "integration", "skill", "schedule"];
/** Chip labels — single nouns. The walkthrough already taught the user
 *  what each step is for, so the tray just needs scannable tags. */
const STEP_LABELS: Record<StepId, string> = {
  channel: "Channel",
  integration: "Integrations",
  teammate: "Team",
  skill: "Skill",
  schedule: "Task",
};

/**
 * Multi-step coach-mark sequence. Each entry anchors to a sidebar nav item
 * and provides the body copy for the tooltip. Order matches STEP_ORDER so
 * each Next click marks the corresponding tray chip done.
 *
 * Bodies follow a consistent shape so the cards read as a series:
 *   • Bold WHAT — the action, imperative form ("Connect a Slack channel.")
 *   • HOW — the concrete user mechanic ("Pick a workspace and the channels…")
 *   • WHY — the payoff so the action feels worth doing
 * WHERE is conveyed visually by the coach mark's anchor on the matching
 * sidebar item — saying "click here" or "open Channels" in copy would be
 * redundant with the highlight + caret.
 */
const TOUR_SEQUENCE: Array<{ id: StepId; selector: string; body: ReactNode }> = [
  {
    id: "channel",
    selector: "a[href='/channels']",
    body: (
      <>
        <strong className="font-semibold">Connect a Slack channel.</strong> Pick a workspace and the channels Sketch
        should join — it'll reply in threads, post summaries, and jump in when @mentioned.
      </>
    ),
  },
  {
    id: "teammate",
    selector: "a[href='/team']",
    body: (
      <>
        <strong className="font-semibold">Invite your teammates.</strong> Drop in their emails or share an invite link.
        Anyone you bring in shares the same skills, integrations, and history.
      </>
    ),
  },
  {
    id: "integration",
    selector: "a[href='/integrations']",
    body: (
      <>
        <strong className="font-semibold">Plug in your tools.</strong> Connect Notion, Linear, Drive — anywhere your
        team works — in one click. Sketch then pulls context from them and acts on your behalf.
      </>
    ),
  },
  {
    id: "skill",
    selector: "a[href='/skills']",
    body: (
      <>
        <strong className="font-semibold">Teach Sketch a new skill.</strong> Describe what you want done in the builder
        — write it once, anyone on your team can run it on demand or on a schedule.
      </>
    ),
  },
  {
    id: "schedule",
    selector: "a[href='/scheduled-tasks']",
    body: (
      <>
        <strong className="font-semibold">Schedule a task.</strong> Pick a skill, set a cadence — Sketch runs it on its
        own. Standups, digests, anything recurring.
      </>
    ),
  },
];

/** ms the tray takes to play its exit animation before the bubble takes
 *  over. Matches the sketch-tray-out keyframe duration in theme.css. */
const TRAY_EXIT_MS = 360;

function OnboardingPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();

  const [stage, setStage] = useState<Stage>("video");
  const [doneIds, setDoneIds] = useState<Set<StepId>>(() => new Set());
  const [helpOpen, setHelpOpen] = useState(false);
  const [bubbleOpen, setBubbleOpen] = useState(true);
  const [trayLeaving, setTrayLeaving] = useState(false);
  /** Which step of the active tour the user is on (0-indexed into activeTour). */
  const [tourStepIndex, setTourStepIndex] = useState(0);
  /**
   * Snapshot of the tour sequence taken at startTour(). Captures the filter
   * (mid-flow: only undone steps; post-completion replay: full refresher) so
   * the sequence stays stable for the duration of the tour even if doneIds
   * changes underneath.
   */
  const [activeTour, setActiveTour] = useState<typeof TOUR_SEQUENCE>([]);

  const steps: OnboardingStep[] = STEP_ORDER.map((id) => ({
    id,
    label: STEP_LABELS[id],
    done: doneIds.has(id),
  }));
  const allDone = doneIds.size === STEP_ORDER.length;

  function handleSubmit(_message: string) {
    void navigate({ to: "/chat/$conversationId", params: { conversationId: "active" } });
  }

  function toggleStep(id: string) {
    setDoneIds((prev) => {
      const next = new Set(prev);
      const stepId = id as StepId;
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  }

  /**
   * Pick the right stage to land on after dismissing an overlay (video or
   * coach mark). If setup is already complete we go back to the helper
   * bubble; otherwise the tray takes over.
   */
  function dismissOverlayStage(): Stage {
    return allDone ? "helper" : "tray";
  }

  /** Enter the tour. Used by both initial flow and replays. Filter rules:
   *   - During initial setup (mid-flow): skip steps that are already done.
   *     The tour only talks about what's actually left for the user to do.
   *   - After setup is complete (replay from the bubble): show the *full*
   *     refresher tour — "Re-take walkthrough" means show it all again.
   *   - If filtering leaves zero steps (mid-flow but somehow everything is
   *     done), drop straight back to the dashboard. */
  function startTour() {
    setHelpOpen(false);
    const sequence = allDone ? TOUR_SEQUENCE.slice() : TOUR_SEQUENCE.filter((s) => !doneIds.has(s.id));
    if (sequence.length === 0) {
      setStage(dismissOverlayStage());
      return;
    }
    setActiveTour(sequence);
    setTourStepIndex(0);
    setStage("tour");
  }

  function acknowledgeComplete() {
    setHelpOpen(false);
    setTrayLeaving(true);
    // Hold the tray on screen long enough for its exit animation to play,
    // then swap to the helper bubble.
    setTimeout(() => {
      setStage("helper");
      setBubbleOpen(true);
      setTrayLeaving(false);
    }, TRAY_EXIT_MS);
  }

  // During the initial flow the tray sits underneath the tour. But when the
  // user is replaying the walkthrough from the helper bubble (i.e. setup is
  // already complete), the bottom celebration tray distracts from the
  // coach mark — keep the canvas clean and just show the tour itself.
  const showTray = stage === "tray" || (stage === "tour" && !allDone);
  const showBubble = stage === "helper";

  // Subtitle adapts to the current stage of the flow so the page header
  // never reads "Connect Notion" copy from the digest mock. After setup
  // completes the subtitle locks to the "all set" line — replaying the
  // video or tour from the bubble shouldn't roll the page back to the
  // welcome copy.
  let subtitle: string | undefined;
  if (allDone) {
    subtitle = "You're all set — Sketch is ready to work.";
  } else if (stage === "video") {
    subtitle = "Welcome to Sketch — let's get you set up.";
  } else if (stage === "tour") {
    subtitle = "Welcome to Sketch — follow the tour to get going.";
  } else if (stage === "tray" && doneIds.size > 0) {
    subtitle = "Pick up your setup from the tray below.";
  } else if (stage === "tray") {
    subtitle = "Welcome to Sketch — kick things off from the tray below.";
  }

  // Once all 5 are done the dashboard has "real" content to show — swap to
  // the populated mock so the page doesn't read empty after celebration.
  const filesForStage = allDone ? MOCK_FILES : MOCK_FILES_EMPTY;

  return (
    <SketchShell
      profile={{
        name: auth.displayName,
        isAdmin: auth.role === "admin",
        identifier: auth.displayIdentifier,
      }}
      orgName={auth.orgName}
      files={filesForStage}
    >
      <div className="flex min-h-full flex-col">
        <div className="flex-1">
          <HomePane
            firstName={firstNameOf(auth)}
            recents={[]}
            digest={MOCK_SETUP_DIGEST}
            hideRecentsWhenEmpty
            subtitleOverride={subtitle}
            onSubmit={handleSubmit}
          />
        </div>

        {(showTray || trayLeaving) && (
          <OnboardingSetupTray
            steps={steps}
            helpOpen={helpOpen}
            leaving={trayLeaving}
            onHelpToggle={() => setHelpOpen((v) => !v)}
            onStepClick={toggleStep}
            onReplayTour={startTour}
            onWatchVideo={() => {
              setHelpOpen(false);
              setStage("video");
            }}
            onAcknowledgeComplete={acknowledgeComplete}
          />
        )}
      </div>

      {/* Stage-specific overlays. */}
      {stage === "video" && (
        <OnboardingVideoOverlay
          onDismiss={() => {
            // Tertiary close — lands on the dashboard with the tray
            // (or helper bubble if setup is already complete). The tour
            // is still reachable via the tray's help panel; no extra
            // modal stands between the user and the product.
            if (allDone) setStage("helper");
            else setStage("tray");
          }}
          onSkipToWalkthrough={() => {
            // Secondary CTA — opt straight into the guided walkthrough.
            startTour();
          }}
        />
      )}

      {stage === "tour" &&
        activeTour.length > 0 &&
        (() => {
          const current = activeTour[tourStepIndex];
          const isLast = tourStepIndex === activeTour.length - 1;
          return (
            <CoachMark
              key={current.id}
              selector={current.selector}
              placement="right"
              stepIndex={tourStepIndex + 1}
              totalSteps={activeTour.length}
              body={current.body}
              cta={isLast ? "Finish" : "Next"}
              onSkip={() => {
                // Skip the rest of the tour — drop the user back on the
                // dashboard (tray if mid-flow, helper if they're replaying
                // post-completion). Nothing to undo: the tour never marks
                // anything done.
                setStage(dismissOverlayStage());
              }}
              onNext={() => {
                // Tour is explanation only — Next does NOT mark the step
                // done. Real completion happens when the user actually
                // does the underlying action (which, in this prototype,
                // is clicking the matching tray chip).
                if (isLast) {
                  setStage(dismissOverlayStage());
                } else {
                  setTourStepIndex((i) => i + 1);
                }
              }}
            />
          );
        })()}

      {showBubble && (
        <OnboardingBubbleHelper
          steps={steps as BubbleStep[]}
          open={bubbleOpen}
          setupComplete
          onToggle={() => setBubbleOpen((v) => !v)}
          onReplayTour={startTour}
          onWatchVideo={() => setStage("video")}
          onContact={() => {}}
        />
      )}
    </SketchShell>
  );
}

export const homeOnboardingRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/onboarding",
  component: () => <OnboardingPage />,
});
