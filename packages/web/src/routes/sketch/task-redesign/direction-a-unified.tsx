/**
 * Direction A — "One list, smarter rows".
 *
 * Thesis: don't split the page. Keep a single list, but let each row's *density*
 * encode its complexity. Reminders collapse to a quiet one-liner; workflows
 * expand into a richer card with an app/step chain, run-health dots, and a path
 * into the builder. A filter bar (All / Reminders / Workflows) lets you narrow
 * when you want to, without forcing a structural split. Lowest-risk evolution of
 * today's page.
 */
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_CREDITS, MOCK_FILES } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { ArrowSquareOutIcon, CaretRightIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ALL_TASKS, type MockTask, type TaskKind } from "./mock";
import { AppChain, KindIcon, LastRunPill, RunHealth, StatusBadge, relativeTime, stepSummary } from "./shared";

type Filter = "all" | TaskKind;

function DirectionA() {
  const auth = useSketchAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const tasks = ALL_TASKS.filter((t) => filter === "all" || t.kind === filter);
  const counts = {
    all: ALL_TASKS.length,
    reminder: ALL_TASKS.filter((t) => t.kind === "reminder").length,
    workflow: ALL_TASKS.filter((t) => t.kind === "workflow").length,
  };

  return (
    <SketchShell
      profile={{ name: auth.displayName, isAdmin: auth.role === "admin", identifier: auth.displayIdentifier }}
      orgName={auth.orgName}
      credits={MOCK_CREDITS}
      files={MOCK_FILES}
    >
      <div className="mx-auto box-content max-w-4xl px-10 py-8">
        <h1 className="text-xl font-semibold text-foreground">Automations</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Created or modified by talking to Sketch in chat. {counts.workflow} workflows · {counts.reminder} reminders.
        </p>

        <div className="mt-5 flex items-center gap-2">
          {(["all", "workflow", "reminder"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                filter === f ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/70",
              )}
            >
              {f === "all" ? "All" : f === "workflow" ? "Workflows" : "Reminders"}
              <span className={cn("text-[10px]", filter === f ? "opacity-70" : "opacity-50")}>{counts[f]}</span>
            </button>
          ))}
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
          {tasks.map((task, i) => (
            <Row
              key={task.id}
              task={task}
              isLast={i === tasks.length - 1}
              isExpanded={expanded === task.id}
              onToggle={() => setExpanded((c) => (c === task.id ? null : task.id))}
            />
          ))}
        </div>
      </div>
    </SketchShell>
  );
}

function Row({
  task,
  isLast,
  isExpanded,
  onToggle,
}: {
  task: MockTask;
  isLast: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const isWorkflow = task.kind === "workflow";
  return (
    <div className={cn(!isLast && "border-b border-border")}>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex w-full items-start gap-3 px-4 text-left transition-colors hover:bg-muted/40",
          isWorkflow ? "py-3.5" : "py-2.5",
        )}
      >
        <div
          className={cn(
            "mt-0.5 flex shrink-0 items-center justify-center rounded-lg",
            isWorkflow ? "size-8 bg-amber-500/10" : "size-7 bg-muted",
          )}
        >
          <KindIcon task={task} className={isWorkflow ? "size-4" : "size-3.5"} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{task.title}</p>
            {task.scope === "system" ? (
              <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">System</span>
            ) : null}
          </div>

          {/* Reminder: one quiet caption. Workflow: chain + health + summary. */}
          {isWorkflow ? (
            <div className="mt-1.5 space-y-1.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {task.appChain ? <AppChain apps={task.appChain} /> : null}
                <span className="text-[11px] text-muted-foreground">{task.stepCount} steps</span>
                <RunHealth health={task.runHealth} />
                <LastRunPill task={task} />
              </div>
              <p className="truncate text-xs text-muted-foreground">{task.scheduleLabel}</p>
            </div>
          ) : (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {task.scheduleLabel}
              {task.lastRunAt ? <span> · last run {relativeTime(task.lastRunAt)}</span> : null}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <StatusBadge task={task} />
          <CaretRightIcon
            className={cn("size-3.5 text-muted-foreground transition-transform", isExpanded && "rotate-90")}
          />
          <span className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted">
            <DotsThreeIcon className="size-4" />
          </span>
        </div>
      </button>

      {isExpanded ? <Detail task={task} /> : null}
    </div>
  );
}

function Detail({ task }: { task: MockTask }) {
  const summary = stepSummary(task);
  return (
    <div className="border-t border-border bg-muted/20 px-4 py-4">
      {task.kind === "workflow" ? (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Flow</p>
            <p className="mt-0.5 truncate text-xs text-foreground">{summary}</p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted">
            Open in builder
            <ArrowSquareOutIcon className="size-3" />
          </span>
        </div>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Field label="Target" value={`${task.targetKindLabel} · ${task.targetLabel}`} />
        <Field label="Type" value={task.kind === "workflow" ? "Trigger-based workflow" : "Scheduled reminder"} />
        <Field label="Schedule" value={task.scheduleLabel} />
        <Field label="Delivery" value={task.outputMode === "silent" ? "Silent" : "Sends output"} />
        <Field label="Runs" value={String(task.runCount)} />
        <Field label="Created by" value={task.creatorName ?? "—"} />
      </dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground">{value}</dd>
    </div>
  );
}

export const taskRedesignARoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/scheduled-tasks/v1-unified",
  component: DirectionA,
});
