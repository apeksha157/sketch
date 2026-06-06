/**
 * Direction B — "Two surfaces, one page".
 *
 * Thesis: reminders and workflows are different *objects* and deserve different
 * treatment — but both should read as a tight, scannable list, not a stack of
 * tall cards. Two sections, each a uniform list of compact two-line rows:
 *   • Workflows → app chain + health + status inline; failures flagged with a
 *     subtle red marker (not a banner). Expand a row for the flow + builder jump.
 *   • Reminders → an even lighter checklist with a small on/off toggle.
 * Each section's header has a caret that collapses the whole section in one
 * click, so a long list never buries the other type — and the page keeps a
 * single, normal scroll (no nested scroll panels).
 */
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_CREDITS, MOCK_FILES } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { ArrowSquareOutIcon, BellSimpleIcon, CaretDownIcon, DotsThreeIcon, LightningIcon } from "@phosphor-icons/react";
import { Switch } from "@sketch/ui/components/switch";
import { cn } from "@sketch/ui/lib/utils";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { type MockTask, REMINDERS, WORKFLOWS } from "./mock";
import { AppChain, RunHealth, StatusBadge, relativeTime, stepSummary } from "./shared";

function DirectionB() {
  const auth = useSketchAuth();
  const failing = WORKFLOWS.filter((t) => t.lastRunStatus === "failed").length;

  return (
    <SketchShell
      profile={{ name: auth.displayName, isAdmin: auth.role === "admin", identifier: auth.displayIdentifier }}
      orgName={auth.orgName}
      credits={MOCK_CREDITS}
      files={MOCK_FILES}
    >
      <div className="mx-auto box-content max-w-4xl px-10 py-8">
        <h1 className="text-xl font-semibold text-foreground">Automations</h1>
        <p className="mt-2 text-sm text-muted-foreground">Created or modified by talking to Sketch in chat.</p>

        {/* Each type is its own collapsible section. The caret on a header folds
         * the entire section in one click, so with many workflows you collapse
         * the section to drop straight to reminders — no nested scroll. */}
        <div className="mt-6 space-y-4">
          <Section
            icon={<LightningIcon weight="fill" className="size-3.5 text-amber-500" />}
            title="Workflows"
            count={WORKFLOWS.length}
            note={failing ? `${failing} ${failing === 1 ? "needs" : "need"} attention` : undefined}
          >
            {WORKFLOWS.map((task, i) => (
              <WorkflowRow key={task.id} task={task} isLast={i === WORKFLOWS.length - 1} />
            ))}
          </Section>

          <Section
            icon={<BellSimpleIcon weight="fill" className="size-3.5 text-muted-foreground" />}
            title="Reminders & nudges"
            count={REMINDERS.length}
          >
            {REMINDERS.map((task, i) => (
              <ReminderRow key={task.id} task={task} isLast={i === REMINDERS.length - 1} />
            ))}
          </Section>
        </div>
      </div>
    </SketchShell>
  );
}

function Section({
  icon,
  title,
  count,
  note,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  note?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/40"
        aria-expanded={open}
      >
        {icon}
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground">{count}</span>
        {note ? <span className="ml-1.5 text-xs font-medium text-destructive">{note}</span> : null}
        <CaretDownIcon
          className={cn("ml-auto size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")}
        />
      </button>
      {open ? <div className="border-t border-border">{children}</div> : null}
    </section>
  );
}

function WorkflowRow({ task, isLast }: { task: MockTask; isLast: boolean }) {
  const [open, setOpen] = useState(false);
  const failed = task.lastRunStatus === "failed";
  const summary = stepSummary(task);

  return (
    <div className={cn(!isLast && "border-b border-border", failed && "border-l-2 border-l-destructive")}>
      <div className="flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-muted/40">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-amber-500/10">
            <LightningIcon weight="fill" className="size-3.5 text-amber-500" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="truncate text-sm font-medium text-foreground">{task.title}</p>
              {task.scope === "system" ? (
                <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
                  System
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              {task.appChain ? <AppChain apps={task.appChain} /> : null}
              <span className="truncate">{task.scheduleLabel}</span>
              {failed ? (
                <span className="shrink-0 font-medium text-destructive">· Failed {relativeTime(task.lastRunAt)}</span>
              ) : null}
            </div>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-2.5">
          <RunHealth health={task.runHealth} />
          <StatusBadge task={task} />
          <span className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted">
            <DotsThreeIcon className="size-4" />
          </span>
        </div>
      </div>

      {open ? (
        <div className="border-t border-border bg-muted/20 px-3.5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Flow</p>
              <p className="mt-0.5 truncate text-xs text-foreground">{summary}</p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted">
              Open in builder
              <ArrowSquareOutIcon className="size-3" />
            </span>
          </div>
          {failed ? (
            <p className="mt-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              Slack channel could not be resolved — last run {relativeTime(task.lastRunAt)}.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReminderRow({ task, isLast }: { task: MockTask; isLast: boolean }) {
  const [on, setOn] = useState(task.status === "active");
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3.5 py-2 transition-colors hover:bg-muted/40",
        !isLast && "border-b border-border",
      )}
    >
      <Switch size="sm" checked={on} onCheckedChange={setOn} aria-label={`${on ? "Pause" : "Resume"} ${task.title}`} />

      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-sm", on ? "text-foreground" : "text-muted-foreground")}>{task.title}</p>
      </div>

      <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
        {task.scheduleLabel}
        {task.lastRunStatus === "failed" ? <span className="text-destructive"> · failed</span> : null}
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {task.outputMode === "silent" ? "Silent" : task.targetLabel}
      </span>
      <span className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted">
        <DotsThreeIcon className="size-4" />
      </span>
    </div>
  );
}

export const taskRedesignBRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/scheduled-tasks/v2-split",
  component: DirectionB,
});
