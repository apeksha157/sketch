/**
 * Run/Play button + run-history dropdown — themed with Sketch tokens. Prototype:
 * the Run button simulates an execution (no backend); the history dropdown lists
 * dummy runs and, when you pick a past one, the trigger itself carries the
 * "viewing" state (so there's no separate floating banner to reconcile).
 */
import {
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  EyeIcon,
  LightningIcon,
  PlayIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { cn } from "@sketch/ui/lib/utils";
import type { AutomationRun } from "./types";

export function formatRunTime(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString("en-US", { month: "short" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${d.getDate()} ${month} '${String(d.getFullYear()).slice(2)} · ${time}`;
}

/** Compact variant for the dropdown trigger's "Viewing" label (drops the year). */
export function formatRunTimeShort(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString("en-US", { month: "short" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${d.getDate()} ${month} · ${time}`;
}

export function formatDuration(ms?: number): string {
  if (ms == null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function RunButton({
  running,
  onRun,
  size = "sm",
  variant = "default",
  label = "Run",
  runningLabel = "Running…",
  className,
}: {
  running: boolean;
  onRun: () => void;
  size?: "sm" | "xs";
  /** "default" = solid primary (Run); "secondary"/"outline" = subordinate (Test). */
  variant?: "default" | "outline" | "secondary";
  label?: string;
  runningLabel?: string;
  /** Extra classes merged last (e.g. brand tint + mono for the drawer's Test). */
  className?: string;
}) {
  return (
    <Button
      size="sm"
      variant={variant}
      className={cn(
        "gap-1.5",
        // The play glyph's mass sits left of centre, so a tighter left pad
        // optically balances it against the label on the right.
        size === "xs" ? "h-6 px-2 text-xs" : "h-7 text-[13px] shadow-sm has-[>svg]:pl-2",
        className,
      )}
      disabled={running}
      onClick={onRun}
    >
      {running ? <SpinnerGapIcon size={13} className="animate-spin" /> : <PlayIcon size={13} weight="fill" />}
      {running ? runningLabel : label}
    </Button>
  );
}

function RunStatusIcon({ status }: { status: AutomationRun["status"] }) {
  // Running stays neutral — the spin conveys activity; no stray blue (matches the
  // canvas, where running is a faint accent rather than a colour-coded state).
  // The explicit size-* class keeps the dropdown item's `size-4` rule from
  // resizing these to 16px.
  if (status === "running")
    return <SpinnerGapIcon size={15} className="size-[15px] animate-spin text-muted-foreground" />;
  if (status === "failed") return <XCircleIcon size={15} weight="fill" className="size-[15px] text-destructive" />;
  return <CheckCircleIcon size={15} weight="fill" className="size-[15px] text-success" />;
}

/**
 * Run-history control. At latest it reads "Runs · N"; pick a past run and the
 * trigger flips to an accent "Viewing · {time}" so the context lives on the
 * control itself. The list is a dropdown anchored to the trigger (not a modal
 * sheet), so the canvas behind it stays visible.
 */
export function RunsMenu({
  runs,
  activeRunId,
  isLatest,
  onSelectRun,
  disabled = false,
}: {
  runs: AutomationRun[];
  activeRunId: string | null;
  isLatest: boolean;
  onSelectRun: (id: string) => void;
  disabled?: boolean;
}) {
  const active = runs.find((r) => r.id === activeRunId) ?? runs[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          className={cn(
            "h-7 gap-1.5 text-[13px] shadow-sm",
            isLatest ? "text-muted-foreground" : "border-foreground text-foreground",
          )}
        >
          {isLatest ? <ClockCounterClockwiseIcon size={14} /> : <EyeIcon size={13} weight="fill" />}
          {isLatest
            ? `Runs${runs.length ? ` · ${runs.length}` : ""}`
            : `Viewing · ${active ? formatRunTimeShort(active.startedAt) : ""}`}
          <CaretDownIcon size={11} className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-[300px] p-1.5">
        <DropdownMenuLabel className="px-2 pt-0.5 pb-1 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          Run history
        </DropdownMenuLabel>
        {runs.map((run, i) => {
          const isActive = run.id === activeRunId;
          return (
            <DropdownMenuItem
              key={run.id}
              onSelect={() => onSelectRun(run.id)}
              className={cn("items-start gap-3 rounded-lg px-2.5 py-2", isActive && "bg-accent")}
            >
              <RunStatusIcon status={run.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-foreground">{formatRunTime(run.startedAt)}</span>
                  {i === 0 && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px] leading-none">
                      Latest
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="capitalize">{run.status}</span>
                  {run.durationMs != null && <span>· {formatDuration(run.durationMs)}</span>}
                  <span className="flex items-center gap-1">
                    <LightningIcon size={11} weight="fill" className="size-[11px]" /> {run.trigger}
                  </span>
                </div>
              </div>
              {isActive && <EyeIcon size={13} weight="fill" className="mt-0.5 size-[13px] shrink-0 text-foreground" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Clears the historical-run selection — co-located with the runs control. */
export function BackToLatestButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 gap-1.5 text-[13px] text-muted-foreground shadow-sm"
      onClick={onClick}
    >
      <ArrowCounterClockwiseIcon size={13} />
      Back to latest
    </Button>
  );
}
