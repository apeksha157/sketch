/**
 * The dev-tools view over graph-verdict runs: agents propose curation actions
 * through the MCP tool; this panel shows every run with per-status rollups and
 * drills into all of a run's verdicts, terminal states included. Day-to-day
 * approval happens in Your Org's review bands — both surfaces share
 * {@link GraphVerdictSheet}, so the dry-run-gated decision flow is identical.
 */
import {
  GRAPH_VERDICT_ACTION_LABELS,
  GRAPH_VERDICT_STATUS_TONES,
  GraphVerdictSheet,
  containerClassificationOf,
} from "@/components/graph-verdict-sheet";
import { type GraphVerdict, type GraphVerdictRun, api } from "@/lib/api";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

export function GraphVerdicts() {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [openVerdict, setOpenVerdict] = useState<GraphVerdict | null>(null);

  const runsQuery = useQuery({
    queryKey: ["graph-verdicts", "runs"],
    queryFn: () => api.graphVerdicts.listRuns(),
    retry: false,
  });

  if (runsQuery.isLoading) {
    return (
      <div className="mt-4 space-y-2">
        {[1, 2].map((k) => (
          <Skeleton key={k} className="h-11 rounded-md" />
        ))}
      </div>
    );
  }
  if (runsQuery.isError) {
    return (
      <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
        Could not load verdict runs: {String(runsQuery.error)}
      </p>
    );
  }

  const runs = runsQuery.data?.runs ?? [];

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Graph verdict runs · {runs.length}
      </h2>
      <p className="mb-2 text-[12px] text-muted-foreground">
        Curation actions proposed by agents. Expand a run, open a verdict to see its evidence and a live dry run of what
        applying will do, then approve, apply, or undo.
      </p>

      {runs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-6 text-center">
          <p className="text-[13px] text-muted-foreground">
            No proposals yet — runs appear when an agent calls propose_graph_verdicts.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              expanded={expandedRunId === run.id}
              onToggle={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
              onOpenVerdict={setOpenVerdict}
            />
          ))}
        </div>
      )}

      <GraphVerdictSheet verdict={openVerdict} onClose={() => setOpenVerdict(null)} />
    </section>
  );
}

function rollupSummary(run: GraphVerdictRun): string {
  const parts: string[] = [];
  for (const status of [
    "awaiting_human",
    "approved",
    "pending_corroboration",
    "veto_window",
    "applied",
    "reverted",
    "rejected",
    "retired",
    "bounced",
  ] as const) {
    const count = run.rollups?.[status] ?? 0;
    if (count > 0) parts.push(`${count} ${status === "awaiting_human" ? "awaiting" : status}`);
  }
  return parts.length > 0 ? parts.join(" · ") : `${run.verdictsProposed} proposed`;
}

function RunRow({
  run,
  expanded,
  onToggle,
  onOpenVerdict,
}: {
  run: GraphVerdictRun;
  expanded: boolean;
  onToggle: () => void;
  onOpenVerdict: (verdict: GraphVerdict) => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        data-testid="graph-verdict-run-row"
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/40"
      >
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{expanded ? "▾" : "▸"}</span>
        <span className="shrink-0 font-mono text-[11px] text-foreground">{run.id.slice(0, 8)}</span>
        <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{run.source}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
          {run.note ? `${run.note} · ` : ""}
          {rollupSummary(run)}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{run.createdAt.slice(0, 10)}</span>
      </button>
      {expanded ? <RunVerdicts runId={run.id} onOpenVerdict={onOpenVerdict} /> : null}
    </div>
  );
}

function RunVerdicts({ runId, onOpenVerdict }: { runId: string; onOpenVerdict: (verdict: GraphVerdict) => void }) {
  const verdictsQuery = useQuery({
    queryKey: ["graph-verdicts", "runs", runId, "verdicts"],
    queryFn: () => api.graphVerdicts.listRunVerdicts(runId),
    retry: false,
  });

  if (verdictsQuery.isLoading) return <Skeleton className="mx-3 mb-2 h-8 rounded-md" />;
  if (verdictsQuery.isError) {
    return (
      <p className="px-3 pb-2 text-[12px] text-destructive">Could not load verdicts: {String(verdictsQuery.error)}</p>
    );
  }

  const verdicts = verdictsQuery.data?.verdicts ?? [];
  if (verdicts.length === 0) {
    return <p className="px-3 pb-2 text-[12px] text-muted-foreground">No verdicts stored for this run.</p>;
  }

  return (
    <div className="mx-3 mb-2 divide-y divide-border rounded-md border border-border bg-muted/20">
      {verdicts.map((verdict) => (
        <button
          key={verdict.id}
          type="button"
          data-testid="graph-verdict-row"
          onClick={() => onOpenVerdict(verdict)}
          className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-muted/40"
        >
          <span className="shrink-0 font-mono text-[10.5px] uppercase text-muted-foreground">
            {GRAPH_VERDICT_ACTION_LABELS[verdict.action] ?? verdict.action}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
            {verdict.subjectName ?? verdict.subjectEntityId ?? verdict.subjectContainerId}
            {verdict.targetEntityId ? ` → ${verdict.targetName ?? verdict.targetEntityId}` : ""}
            {verdict.action === "remove_alias" && verdict.targetName ? ` → ${verdict.targetName}` : ""}
            {containerClassificationOf(verdict) ? ` → ${containerClassificationOf(verdict)}` : ""}
          </span>
          <span className={`shrink-0 font-mono text-[10px] uppercase ${GRAPH_VERDICT_STATUS_TONES[verdict.status]}`}>
            {verdict.status === "awaiting_human" ? "awaiting" : verdict.status}
          </span>
        </button>
      ))}
    </div>
  );
}
