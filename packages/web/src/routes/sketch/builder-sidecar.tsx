/**
 * /scheduled-tasks/builder-sidecar — chat-driven automation builder.
 *
 * User got here by clicking "Open builder" on the artifact in
 * /chat/automation-sidecar. The chat continues in a left rail next to the
 * canvas — same conversation, still live.
 *
 * The right pane is the real graph canvas, showing the Trustpilot draft. A Run
 * button simulates an execution and a Runs panel shows history — clicking a past
 * run replays its per-step results onto the graph + drawer. Dummy data only.
 */
import { BuilderSidecar } from "@/components/sketch/builder-sidecar";
import { SketchShell } from "@/components/sketch/shell";
import { AutomationCanvas } from "@/routes/automation-builder/canvas";
import { DRAFT_TRUSTPILOT } from "@/routes/automation-builder/data";
import { NodeDrawer } from "@/routes/automation-builder/node-drawer";
import { RunButton, RunsButton, RunsPanel, formatRunTime } from "@/routes/automation-builder/run-controls";
import type { AutomationRun, StepNodeData, StepRunResult } from "@/routes/automation-builder/types";
import { MOCK_CREDITS, MOCK_FILES } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { ArrowCounterClockwiseIcon, FloppyDiskIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

const automation = DRAFT_TRUSTPILOT;

function BuilderSidecarPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();

  const [runs, setRuns] = useState<AutomationRun[]>(automation.runs ?? []);
  const [activeRunId, setActiveRunId] = useState<string | null>(runs[0]?.id ?? null);
  const [running, setRunning] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [runsOpen, setRunsOpen] = useState(false);

  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0];
  const isLatest = !activeRun || activeRun.id === runs[0]?.id;

  const runningResults = useMemo<Record<string, StepRunResult>>(
    () => Object.fromEntries(automation.steps.map((s) => [s.id, { status: "running" as const }])),
    [],
  );
  const runResults = running ? runningResults : (activeRun?.stepResults ?? automation.lastRun);
  const runKey = running ? "running" : (activeRun?.id ?? "latest");

  const stepsById = useMemo(() => new Map(automation.steps.map((s) => [s.id, s])), []);
  const selectedStep = selectedStepId ? stepsById.get(selectedStepId) : undefined;
  const selectedData: StepNodeData | null = selectedStep
    ? { step: selectedStep, content: automation.content[selectedStep.id], run: runResults[selectedStep.id] }
    : null;

  function runNow() {
    if (running) return;
    setRunning(true);
    setRunsOpen(false);
    setTimeout(() => {
      const newRun: AutomationRun = {
        id: `run-${Date.now().toString(36)}`,
        status: "success",
        trigger: "manual",
        startedAt: new Date().toISOString(),
        durationMs: 4200,
        stepResults: automation.lastRun,
      };
      setRuns((prev) => [newRun, ...prev]);
      setActiveRunId(newRun.id);
      setRunning(false);
    }, 1600);
  }

  return (
    <SketchShell
      profile={{ name: auth.displayName, isAdmin: auth.role === "admin", identifier: auth.displayIdentifier }}
      orgName={auth.orgName}
      credits={MOCK_CREDITS}
      files={MOCK_FILES}
    >
      <div className="flex h-full min-h-0">
        <BuilderSidecar threadTitle="Sharing five-star Trustpilot reviews" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-[10px]">
            <h1 className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground/85">{automation.title}</h1>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Toggle theme"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            >
              {resolvedTheme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
            </Button>
            <RunsButton count={runs.length} onClick={() => setRunsOpen(true)} />
            <RunButton running={running} onRun={runNow} />
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5"
              onClick={() => navigate({ to: "/chat/automation-sidecar" })}
            >
              <FloppyDiskIcon size={13} />
              Save
            </Button>
          </div>

          {!isLatest && activeRun && (
            <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-5 py-1.5 text-xs text-muted-foreground">
              <span>Viewing run from {formatRunTime(activeRun.startedAt)}</span>
              <button
                type="button"
                className="ml-auto flex items-center gap-1 text-foreground hover:underline"
                onClick={() => setActiveRunId(runs[0]?.id ?? null)}
              >
                <ArrowCounterClockwiseIcon size={12} />
                Back to latest
              </button>
            </div>
          )}

          <div className="relative min-h-0 flex-1">
            <AutomationCanvas
              automation={automation}
              runResults={runResults}
              runKey={runKey}
              onSelectStep={setSelectedStepId}
            />
          </div>
        </div>
      </div>

      <NodeDrawer data={selectedData} onClose={() => setSelectedStepId(null)} onRun={runNow} running={running} />
      <RunsPanel
        open={runsOpen}
        onOpenChange={setRunsOpen}
        runs={runs}
        activeRunId={activeRun?.id ?? null}
        onSelectRun={(id) => {
          setActiveRunId(id);
          setRunsOpen(false);
        }}
      />
    </SketchShell>
  );
}

export const builderSidecarRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/scheduled-tasks/builder-sidecar",
  component: BuilderSidecarPage,
});
