/**
 * The row primitives the dev-tools panels share: a filter chip and the two
 * table cells. Extracted from {@link RankingTable} so the loop-compare panel
 * reads the same rather than hand-rolling a second set that drifts.
 */
import type { ReactNode } from "react";

export function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[11px] ${
        active ? "border-foreground/30 bg-muted font-medium" : "border-border text-muted-foreground"
      }`}
    >
      {label}
    </button>
  );
}

export function Th({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <th className={`px-2.5 py-1.5 font-medium text-[10px] uppercase tracking-wide ${className}`}>{children}</th>;
}

export function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`max-w-0 px-2.5 py-1.5 align-top ${className}`}>{children}</td>;
}
