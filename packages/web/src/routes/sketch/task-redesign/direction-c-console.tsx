/**
 * Direction C — "Ops console".
 *
 * Thesis: at scale this page is a monitoring surface, not a settings list. Take
 * Viktor's tab model (All / My tasks / System) and add an ops summary strip
 * (active · failing · next to run). One adaptive table where the middle column
 * shows a schedule for reminders and a live run-health strip for workflows.
 * Clicking a row opens a right-hand drawer — tiny for a reminder, a full
 * run-history + steps + output panel for a workflow. Segmentation by tab +
 * column, detail by drawer.
 */
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_CREDITS, MOCK_FILES } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import {
  ArrowSquareOutIcon,
  ArrowsDownUpIcon,
  CheckCircleIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PlayIcon,
  WarningCircleIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Input } from "@sketch/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { cn } from "@sketch/ui/lib/utils";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ALL_TASKS, type MockTask, REMINDERS, SYSTEM_TASKS, WORKFLOWS } from "./mock";
import { AppChain, KindIcon, RunHealth, StatusBadge, relativeTime, stepSummary } from "./shared";

type Tab = "all" | "mine" | "system";
type StatusFilter = "all" | "active" | "attention" | "paused";
type Sort = "recent" | "next" | "name" | "attention";

const isAttention = (t: MockTask) => t.lastRunStatus === "failed";
const ms = (s: string | null) => (s ? new Date(s).getTime() : null);

/** Sort comparators. "attention" floats failures up, then by recency. */
const SORTS: Record<Sort, (a: MockTask, b: MockTask) => number> = {
  recent: (a, b) => (ms(b.lastRunAt) ?? Number.NEGATIVE_INFINITY) - (ms(a.lastRunAt) ?? Number.NEGATIVE_INFINITY),
  next: (a, b) => (ms(a.nextRunAt) ?? Number.POSITIVE_INFINITY) - (ms(b.nextRunAt) ?? Number.POSITIVE_INFINITY),
  name: (a, b) => (a.title ?? "").localeCompare(b.title ?? ""),
  attention: (a, b) =>
    Number(isAttention(b)) - Number(isAttention(a)) ||
    (ms(b.lastRunAt) ?? Number.NEGATIVE_INFINITY) - (ms(a.lastRunAt) ?? Number.NEGATIVE_INFINITY),
};

const SORT_LABEL: Record<Sort, string> = {
  recent: "Recent activity",
  next: "Next run",
  name: "Name",
  attention: "Needs attention",
};

function DirectionC() {
  const auth = useSketchAuth();
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [selected, setSelected] = useState<MockTask | null>(null);

  const tabTasks: Record<Tab, MockTask[]> = {
    all: ALL_TASKS,
    mine: [...WORKFLOWS, ...REMINDERS].filter((t) => t.scope === "personal"),
    system: SYSTEM_TASKS,
  };

  const q = query.trim().toLowerCase();
  const searched = q ? tabTasks[tab].filter((t) => (t.title ?? "").toLowerCase().includes(q)) : tabTasks[tab];

  // Status counts reflect the current tab + search, so the chips stay honest.
  const counts = {
    all: searched.length,
    active: searched.filter((t) => t.status === "active").length,
    attention: searched.filter(isAttention).length,
    paused: searched.filter((t) => t.status === "paused").length,
  };

  const filtered =
    statusFilter === "all"
      ? searched
      : statusFilter === "attention"
        ? searched.filter(isAttention)
        : searched.filter((t) => t.status === statusFilter);

  const tasks = [...filtered].sort(SORTS[sort]);

  return (
    <SketchShell
      profile={{ name: auth.displayName, isAdmin: auth.role === "admin", identifier: auth.displayIdentifier }}
      orgName={auth.orgName}
      credits={MOCK_CREDITS}
      files={MOCK_FILES}
    >
      <div className="mx-auto box-content max-w-4xl px-10 py-8">
        <h1 className="text-xl font-semibold text-foreground">Scheduled tasks</h1>

        {/* Toolbar: search + sort */}
        <div className="mt-5 flex items-center gap-2">
          <div className="relative flex-1">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tasks"
              className="pl-8"
              aria-label="Search tasks"
            />
          </div>
          <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <SelectTrigger className="h-9 w-[176px] gap-2">
              <ArrowsDownUpIcon className="size-4 shrink-0 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABEL) as Sort[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {SORT_LABEL[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Ownership tabs */}
        <div className="mt-5 flex items-center gap-1 border-b border-border">
          {(
            [
              ["all", "All tasks", tabTasks.all.length],
              ["mine", "My tasks", tabTasks.mine.length],
              ["system", "System tasks", tabTasks.system.length],
            ] as [Tab, string, number][]
          ).map(([key, label, n]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                tab === key
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {label} <span className="ml-1 text-xs text-muted-foreground">{n}</span>
            </button>
          ))}
        </div>

        {/* Status chips — compact, actionable summary that doubles as a filter */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <FilterChip
            label="All"
            count={counts.all}
            active={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
          />
          <FilterChip
            label="Active"
            count={counts.active}
            active={statusFilter === "active"}
            onClick={() => setStatusFilter("active")}
          />
          <FilterChip
            label="Needs attention"
            count={counts.attention}
            tone="bad"
            active={statusFilter === "attention"}
            onClick={() => setStatusFilter("attention")}
          />
          <FilterChip
            label="Paused"
            count={counts.paused}
            active={statusFilter === "paused"}
            onClick={() => setStatusFilter("paused")}
          />
        </div>

        {/* Adaptive table */}
        <div className="mt-3">
          {tasks.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {q || statusFilter !== "all" ? "No tasks match your search." : "No tasks here yet."}
            </div>
          ) : (
            tasks.map((task) => (
              <TableRow
                key={task.id}
                task={task}
                active={selected?.id === task.id}
                onSelect={() => setSelected(task)}
              />
            ))
          )}
        </div>
      </div>

      {selected ? <DetailDrawer task={selected} onClose={() => setSelected(null)} /> : null}
    </SketchShell>
  );
}

function FilterChip({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  tone?: "bad";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-foreground text-background"
          : tone === "bad" && count > 0
            ? "bg-destructive/10 text-destructive hover:bg-destructive/15"
            : "bg-muted text-muted-foreground hover:bg-muted/70",
      )}
    >
      {label}
      <span className={cn("text-[10px] tabular-nums", active ? "opacity-80" : "opacity-70")}>{count}</span>
    </button>
  );
}

function TableRow({ task, active, onSelect }: { task: MockTask; active: boolean; onSelect: () => void }) {
  const isWorkflow = task.kind === "workflow";
  const failed = task.lastRunStatus === "failed";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left transition-colors hover:bg-muted/40",
        active && "bg-muted/60",
      )}
    >
      <div
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg",
          isWorkflow ? "bg-amber-500/10" : "bg-muted",
        )}
      >
        <KindIcon task={task} className="size-3.5" />
      </div>

      <div className="min-w-0 flex-[2]">
        <p className="truncate text-sm font-medium text-foreground">{task.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {isWorkflow ? `${task.kind} · ${task.stepCount} steps` : "reminder"}
          {task.scope === "system" ? " · system" : ""}
        </p>
      </div>

      {/* Adaptive middle column */}
      <div className="hidden flex-[2] items-center gap-2 sm:flex">
        {isWorkflow ? (
          <>
            {task.appChain ? <AppChain apps={task.appChain} /> : null}
            <RunHealth health={task.runHealth} />
          </>
        ) : (
          <span className="text-xs text-muted-foreground">{task.scheduleLabel}</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {failed ? <WarningCircleIcon className="size-4 text-destructive" weight="fill" /> : null}
        <StatusBadge task={task} />
      </div>
    </button>
  );
}

function DetailDrawer({ task, onClose }: { task: MockTask; onClose: () => void }) {
  const isWorkflow = task.kind === "workflow";
  const summary = stepSummary(task);
  let stepList: Array<{ id: string; type: string; label: string }> = [];
  try {
    stepList = task.steps ? JSON.parse(task.steps) : [];
  } catch {
    stepList = [];
  }

  return (
    <>
      <button type="button" className="fixed inset-0 z-30 bg-black/20" onClick={onClose} aria-label="Close drawer" />
      <aside className="fixed inset-y-0 right-0 z-40 flex w-[420px] max-w-[90vw] flex-col border-l border-border bg-background shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <KindIcon task={task} className="size-4" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {isWorkflow ? "Workflow" : "Reminder"}
              </span>
            </div>
            <h2 className="mt-1 text-sm font-semibold text-foreground">{task.title}</h2>
          </div>
          <button type="button" onClick={onClose} className="grid size-7 place-items-center rounded hover:bg-muted">
            <XIcon className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
            >
              {task.status === "active" ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
              {task.status === "active" ? "Pause" : "Resume"}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
            >
              <PlayIcon className="size-3.5" /> Run now
            </button>
            {isWorkflow ? (
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Builder <ArrowSquareOutIcon className="size-3" />
              </button>
            ) : null}
          </div>

          {/* Reminder: minimal. Workflow: steps + runs. */}
          {isWorkflow ? (
            <>
              <DrawerSection title="Flow">
                <div className="space-y-1.5">
                  {stepList.map((s, i) => (
                    <div key={s.id} className="flex items-center gap-2 text-xs">
                      <span className="w-4 text-right text-muted-foreground">{i + 1}</span>
                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        {s.type}
                      </span>
                      <span className="truncate text-foreground">{s.label}</span>
                    </div>
                  ))}
                </div>
              </DrawerSection>

              <DrawerSection title="Recent runs">
                <div className="space-y-1">
                  {(task.runHealth ?? [])
                    .slice()
                    .reverse()
                    .map((h, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static decorative run list, order is stable
                      <div key={i} className="flex items-center gap-2 rounded px-1 py-1 text-xs">
                        {h === "fail" ? (
                          <XCircleIcon className="size-3.5 text-destructive" weight="fill" />
                        ) : (
                          <CheckCircleIcon className="size-3.5 text-emerald-500" weight="fill" />
                        )}
                        <span className="text-muted-foreground">
                          {relativeTime(new Date(Date.now() - i * 6 * 3600_000).toISOString())}
                        </span>
                        <span className="ml-auto text-muted-foreground">{(120 + i).toFixed(1)}s</span>
                      </div>
                    ))}
                </div>
              </DrawerSection>
            </>
          ) : (
            <DrawerSection title="Message">
              <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-foreground">
                {task.prompt}
              </p>
            </DrawerSection>
          )}

          <DrawerSection title="Details">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
              <Field label="Schedule" value={task.scheduleLabel} />
              <Field label="Target" value={`${task.targetKindLabel} · ${task.targetLabel}`} />
              <Field label="Delivery" value={task.outputMode === "silent" ? "Silent" : "Sends output"} />
              <Field label="Runs" value={String(task.runCount)} />
              <Field label="Created by" value={task.creatorName ?? "—"} />
              <Field label="Summary" value={summary ?? "Single message"} />
            </dl>
          </DrawerSection>
        </div>
      </aside>
    </>
  );
}

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-xs text-foreground">{value}</dd>
    </div>
  );
}

export const taskRedesignCRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/scheduled-tasks/v3-console",
  component: DirectionC,
});
