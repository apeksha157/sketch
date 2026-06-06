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
import { BackToLatestButton, RunButton, RunsMenu } from "@/routes/automation-builder/run-controls";
import type { AutomationRun, StepNodeData, StepRunResult } from "@/routes/automation-builder/types";
import { MOCK_CREDITS, MOCK_FILES } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { FloppyDiskIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

const automation = DRAFT_TRUSTPILOT;

function BuilderSidecarPage() {
  const auth = useSketchAuth();
  const navigate = useNavigate();

  const [runs, setRuns] = useState<AutomationRun[]>(automation.runs ?? []);
  const [activeRunId, setActiveRunId] = useState<string | null>(runs[0]?.id ?? null);
  const [running, setRunning] = useState(false);
  const [runningStepId, setRunningStepId] = useState<string | null>(null);
  const [liveResults, setLiveResults] = useState<Record<string, StepRunResult> | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0];
  const isLatest = !activeRun || activeRun.id === runs[0]?.id;

  const runResults = activeRun?.stepResults ?? automation.lastRun;
  const runKey = activeRun?.id ?? "latest";

  const stepsById = useMemo(() => new Map(automation.steps.map((s) => [s.id, s])), []);
  const selectedStep = selectedStepId ? stepsById.get(selectedStepId) : undefined;
  const selectedData: StepNodeData | null = selectedStep
    ? {
        step: selectedStep,
        content: automation.content[selectedStep.id],
        run:
          liveResults?.[selectedStep.id] ??
          (runningStepId === selectedStep.id ? { status: "running" as const } : runResults[selectedStep.id]),
      }
    : null;

  /** Simulate running a single step (the drawer's "Run step"), not the whole automation. */
  function runStep(stepId: string) {
    if (running || runningStepId) return;
    setRunningStepId(stepId);
    setTimeout(() => setRunningStepId(null), 1200);
  }

  /**
   * Simulate a run as a gradual cascade — each step lights up "running", then
   * settles to its result, before the next begins — so the states are legible
   * instead of flipping all at once. A manual run uses the last successful run's
   * per-step results, then commits a new run to history.
   */
  function runNow() {
    if (running) return;
    setRunning(true);
    setSelectedStepId(null);

    const okResults = automation.runs?.find((r) => r.status === "success")?.stepResults ?? automation.lastRun;
    const order = automation.steps.map((s) => s.id);
    const live: Record<string, StepRunResult> = {};
    for (const id of order) live[id] = { status: "idle" };
    setLiveResults({ ...live });

    let i = 0;
    const advance = () => {
      if (i >= order.length) {
        const newRun: AutomationRun = {
          id: `run-${Date.now().toString(36)}`,
          status: "success",
          trigger: "manual",
          startedAt: new Date().toISOString(),
          durationMs: 4200,
          stepResults: okResults,
        };
        setRuns((prev) => [newRun, ...prev]);
        setActiveRunId(newRun.id);
        setRunning(false);
        setLiveResults(null);
        return;
      }
      const id = order[i];
      live[id] = { status: "running" };
      setLiveResults({ ...live });
      setTimeout(() => {
        live[id] = okResults[id] ?? { status: "success" };
        setLiveResults({ ...live });
        i += 1;
        setTimeout(advance, 220);
      }, 620);
    };
    advance();
  }

  return (
    <SketchShell
      profile={{ name: auth.displayName, isAdmin: auth.role === "admin", identifier: auth.displayIdentifier }}
      orgName={auth.orgName}
      credits={MOCK_CREDITS}
      files={MOCK_FILES}
      defaultSidebarCollapsed
    >
      <div className="flex h-full min-h-0">
        <BuilderSidecar title={automation.title} />
        {/* The canvas is chrome-free (no top header) — its title lives in the chat
         *  rail, and the actions float over the surface like the zoom controls. */}
        <div className="relative min-h-0 min-w-0 flex-1">
          <AutomationCanvas
            automation={automation}
            runResults={runResults}
            runKey={runKey}
            liveResults={liveResults}
            selectedStepId={selectedStepId}
            onSelectStep={setSelectedStepId}
          />

          {/* History control, top-left: reads "Runs · N" at latest, flips to an
           *  accent "Viewing · {time}" with a back-to-latest button when a past
           *  run is loaded — so context + exit live on the control, not a banner. */}
          <div className="absolute left-4 top-4 z-20 flex items-center gap-1.5">
            <RunsMenu
              runs={runs}
              activeRunId={activeRun?.id ?? null}
              isLatest={isLatest}
              disabled={running}
              onSelectRun={(id) => {
                setActiveRunId(id);
                setSelectedStepId(null);
              }}
            />
            {!isLatest && <BackToLatestButton onClick={() => setActiveRunId(runs[0]?.id ?? null)} />}
          </div>

          {/* Edit/run actions, top-right. Both buttons are self-contained, so they
           *  sit side by side with no separator; Run is the one solid CTA. */}
          <div className="absolute right-4 top-4 z-20 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[13px] shadow-sm"
              disabled={running}
              onClick={() => navigate({ to: "/chat/automation-sidecar" })}
            >
              <FloppyDiskIcon size={13} />
              Save
            </Button>
            <RunButton running={running} onRun={runNow} />
          </div>
        </div>
      </div>

      <NodeDrawer
        data={selectedData}
        onClose={() => setSelectedStepId(null)}
        onRun={() => {
          if (selectedStepId) runStep(selectedStepId);
        }}
        running={runningStepId === selectedStepId}
      />
    </SketchShell>
  );
}

export const builderSidecarRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/scheduled-tasks/builder-sidecar",
  component: BuilderSidecarPage,
});
