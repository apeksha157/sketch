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

/** 5-step pill indicator: Account -> Workspace -> Platforms -> API Key -> Ready. */
export function StepTrack({ currentStep, maxReached, onStepClick }: StepTrackProps) {
  return (
    <div className="ob-track">
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
              {label}
            </button>
            {i < STEP_LABELS.length - 1 && <span className="ob-track-connector" data-done={i < currentStep} />}
          </div>
        );
      })}
    </div>
  );
}
