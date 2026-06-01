import { STEP_LABELS } from "./types";

interface SectionDividerProps {
  label: string;
  step: number;
  /** True for the divider matching the user's active step. Only the current divider shows
   *  the "Up next" hint — past dividers keep the same layout but drop that one line, since
   *  forward-looking copy doesn't make sense at a historical anchor. */
  isCurrent?: boolean;
}

/**
 * Section anchor between chat steps. Two visual variants:
 * - Desktop: classic horizontal rule with section name centered between two dim lines.
 * - Mobile: 2-row progress block — label (and "Up next" if current) on the top row, full-width
 *   progress bar on the bottom row. Past dividers use the same layout; their progress bar
 *   shows the journey state at the moment they appeared (a footprint pattern).
 */
export function SectionDivider({ label, step, isCurrent = false }: SectionDividerProps) {
  const total = STEP_LABELS.length;
  const nextLabel = STEP_LABELS[step + 1];
  const progressPct = ((step + 1) / total) * 100;

  return (
    <div className="ob-divider ob-animate-in" data-step={step} data-current={isCurrent}>
      <div className="ob-divider-classic">
        <div className="ob-divider-line" />
        <span className="ob-divider-label">{label}</span>
        <div className="ob-divider-line" />
      </div>

      <div className="ob-divider-progress">
        <div className="ob-divider-progress-header">
          <span className="ob-divider-progress-label">{label}</span>
          {isCurrent && nextLabel ? (
            <span className="ob-divider-progress-next">
              Up next <span className="ob-divider-progress-next-strong">{nextLabel}</span>
            </span>
          ) : null}
        </div>
        <div className="ob-divider-progress-bar">
          <div className="ob-divider-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
    </div>
  );
}
