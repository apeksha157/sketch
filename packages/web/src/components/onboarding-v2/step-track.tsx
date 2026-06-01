import { STEP_LABELS } from "./types";

interface StepTrackProps {
  currentStep: number;
  maxReached: number;
  onStepClick: (step: number) => void;
}

function CheckSvg() {
  return (
    <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path
        d="M2 5L4.5 7.5L8 2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Step indicator with two responsive variants:
 * - Wide (≥720px): full pill track with labels and connectors.
 * - Narrow (<720px): slim filling progress bar with "X of Y" counter — minimal vertical space,
 *   strong momentum signal, no redundancy with the section divider below.
 * CSS owns the swap; both variants render and one is hidden by media query.
 */
export function StepTrack({ currentStep, maxReached, onStepClick }: StepTrackProps) {
  const total = STEP_LABELS.length;
  const progressPct = ((currentStep + 1) / total) * 100;

  return (
    <div className="ob-track">
      <div className="ob-track-pills">
        {STEP_LABELS.map((label, i) => {
          const isDone = i < currentStep;
          const isActive = i === currentStep;
          const state = isDone ? "done" : isActive ? "active" : "inactive";
          const clickable = i <= maxReached && i !== currentStep;

          return (
            <div key={label} style={{ display: "flex", alignItems: "center" }}>
              <button
                type="button"
                className="ob-track-pill"
                data-state={state}
                data-clickable={clickable}
                onClick={clickable ? () => onStepClick(i) : undefined}
                disabled={!clickable}
              >
                {isDone ? <CheckSvg /> : <span className="ob-track-dot" data-state={state} />}
                <span className="ob-track-label">{label}</span>
              </button>
              {i < STEP_LABELS.length - 1 && <span className="ob-track-connector" data-done={i < currentStep} />}
            </div>
          );
        })}
      </div>
      <div className="ob-track-bar" aria-label={`Step ${currentStep + 1} of ${total}`}>
        <div className="ob-track-bar-rail">
          <div className="ob-track-bar-fill" style={{ width: `${progressPct}%` }} />
        </div>
        <span className="ob-track-bar-counter">
          {currentStep + 1} <span className="ob-track-bar-counter-of">of</span> {total}
        </span>
      </div>
    </div>
  );
}
