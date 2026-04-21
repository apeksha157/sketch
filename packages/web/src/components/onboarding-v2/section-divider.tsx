interface SectionDividerProps {
  label: string;
  step: number;
}

/** Horizontal rule with IBM Plex Mono uppercase label. */
export function SectionDivider({ label, step }: SectionDividerProps) {
  return (
    <div className="ob-divider ob-animate-in" data-step={step}>
      <div className="ob-divider-line" />
      <span className="ob-divider-label">{label}</span>
      <div className="ob-divider-line" />
    </div>
  );
}
