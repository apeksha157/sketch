/**
 * Run/Play button + Previous Runs panel — adapted from Canvas's WorkflowRunButton
 * and WorkflowExecution history, themed with Sketch tokens. Prototype: the Run
 * button simulates an execution (no backend), the panel lists dummy run history.
 */
import {
  CaretRightIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  LightningIcon,
  PlayIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@sketch/ui/components/sheet";
import { cn } from "@sketch/ui/lib/utils";
import type { AutomationRun } from "./types";

export function formatRunTime(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString("en-US", { month: "short" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${d.getDate()} ${month} '${String(d.getFullYear()).slice(2)} · ${time}`;
}

function formatDuration(ms?: number): string {
  if (ms == null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function RunButton({
  running,
  onRun,
  size = "sm",
}: { running: boolean; onRun: () => void; size?: "sm" | "xs" }) {
  return (
    <Button
      size="sm"
      className={cn("gap-1.5", size === "xs" ? "h-6 px-2 text-xs" : "h-7")}
      disabled={running}
      onClick={onRun}
    >
      {running ? <SpinnerGapIcon size={13} className="animate-spin" /> : <PlayIcon size={13} weight="fill" />}
      {running ? "Running…" : "Run"}
    </Button>
  );
}

export function RunsButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={onClick}>
      <ClockCounterClockwiseIcon size={14} />
      Runs{count ? ` · ${count}` : ""}
    </Button>
  );
}

function RunStatusIcon({ status }: { status: AutomationRun["status"] }) {
  if (status === "running") return <SpinnerGapIcon size={15} className="animate-spin text-info" />;
  if (status === "failed") return <XCircleIcon size={15} weight="fill" className="text-destructive" />;
  return <CheckCircleIcon size={15} weight="fill" className="text-success" />;
}

function RunRow({
  run,
  latest,
  active,
  onClick,
}: {
  run: AutomationRun;
  latest: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors",
        active ? "border-primary bg-accent" : "border-border hover:bg-accent/50",
      )}
    >
      <RunStatusIcon status={run.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-foreground">{formatRunTime(run.startedAt)}</span>
          {latest && (
            <Badge variant="outline" className="h-4 px-1 text-[10px] leading-none">
              Latest
            </Badge>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="capitalize">{run.status}</span>
          {run.durationMs != null && <span>· {formatDuration(run.durationMs)}</span>}
          <span className="flex items-center gap-1">
            <LightningIcon size={11} weight="fill" /> {run.trigger}
          </span>
        </div>
      </div>
      <CaretRightIcon size={14} className="shrink-0 text-muted-foreground" />
    </button>
  );
}

export function RunsPanel({
  open,
  onOpenChange,
  runs,
  activeRunId,
  onSelectRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runs: AutomationRun[];
  activeRunId: string | null;
  onSelectRun: (id: string) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-[400px]">
        <SheetHeader className="border-b border-border">
          <SheetTitle className="text-left text-sm">Runs</SheetTitle>
          <SheetDescription className="sr-only">Execution history</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {runs.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">No runs yet. Hit Run to start one.</p>
          ) : (
            runs.map((run, i) => (
              <RunRow
                key={run.id}
                run={run}
                latest={i === 0}
                active={run.id === activeRunId}
                onClick={() => onSelectRun(run.id)}
              />
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
