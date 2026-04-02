import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";

export function MetricCard({
  label,
  value,
  delta,
  deltaLabel,
}: {
  label: string;
  value: string;
  delta: number;
  deltaLabel?: string;
}) {
  const isNegative = delta < 0;
  const isPositive = delta > 0;

  return (
    <div className="rounded-lg bg-card p-4 dark:bg-[#111110]">
      <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-[26px] font-medium leading-tight">{value}</p>
      {delta !== 0 ? (
        <p
          className={cn(
            "mt-1 flex items-center gap-1 text-[11px]",
            isNegative ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {isPositive ? <ArrowUpIcon size={10} /> : <ArrowDownIcon size={10} />}
          {isNegative ? deltaLabel || `${Math.abs(delta)}%` : deltaLabel || `${delta}%`}
        </p>
      ) : null}
    </div>
  );
}

export function AmountSpentCard({ value, periodLabel }: { value: number; periodLabel: string }) {
  return (
    <div className="rounded-lg bg-card p-4 dark:bg-[#111110]">
      <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">Amount spent</p>
      <p className="mt-1 text-[26px] font-medium leading-tight">${value.toFixed(2)}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">this {periodLabel}</p>
    </div>
  );
}
