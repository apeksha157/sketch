/**
 * The shared graph-verdict decision sheet, used by both the Your Org review
 * bands and the dev-tools runs panel. The sheet fetches a server dry run
 * before anything applies, so the human always approves what the server says
 * will happen, never what the proposal claimed. When the dry run is green the
 * primary is a single "Approve & apply"; when it isn't, plain Approve keeps
 * the sheet open on the refreshed verdict so Apply is one click away once the
 * dry run recovers. Every other decision closes the sheet.
 */
import { EvidenceList } from "@/components/evidence-list";
import { ApiRequestError, type GraphVerdict, type GraphVerdictStatus, api } from "@/lib/api";
import { Button } from "@sketch/ui/components/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export const GRAPH_VERDICT_ACTION_LABELS: Record<string, string> = {
  keep: "keep",
  merge_into: "merge into",
  nest_under: "nest under",
  archive: "archive",
  remove_alias: "remove alias",
  classify_container: "classify",
};

export const GRAPH_VERDICT_STATUS_TONES: Record<GraphVerdictStatus, string> = {
  awaiting_human: "text-amber-600 dark:text-amber-500",
  approved: "text-foreground",
  applied: "text-emerald-600 dark:text-emerald-500",
  bounced: "text-muted-foreground",
  rejected: "text-muted-foreground",
  reverted: "text-muted-foreground",
};

function isStaleError(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.code === "STALE_VERDICT" || err.code === "PLAN_DRIFT");
}

/**
 * The server allows a dry run for awaiting and approved rows only; anything
 * later already happened, so the sheet shows the recorded ledger ref instead.
 */
function canPreview(status: GraphVerdictStatus): boolean {
  return status === "awaiting_human" || status === "approved";
}

export function GraphVerdictSheet({ verdict, onClose }: { verdict: GraphVerdict | null; onClose: () => void }) {
  return (
    <Sheet open={!!verdict} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-[560px]">
        <SheetTitle className="text-[14px]">
          {verdict
            ? `${GRAPH_VERDICT_ACTION_LABELS[verdict.action] ?? verdict.action} · ${verdict.subjectName ?? "verdict"}`
            : ""}
        </SheetTitle>
        <SheetDescription className="sr-only">
          The proposal's reason and evidence, a server dry run of applying it, and the decision buttons.
        </SheetDescription>
        {verdict ? <VerdictDetail key={verdict.id} verdict={verdict} onDone={onClose} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function VerdictDetail({ verdict, onDone }: { verdict: GraphVerdict; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<unknown>(null);
  const [current, setCurrent] = useState(verdict);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["graph-verdicts"] });
  }

  function settle() {
    setActionError(null);
    invalidate();
    onDone();
  }

  const previewQuery = useQuery({
    queryKey: ["graph-verdicts", "preview", current.id],
    queryFn: () => api.graphVerdicts.apply(current.id, { dryRun: true }),
    enabled: canPreview(current.status),
    retry: false,
  });

  const approve = useMutation({
    mutationFn: () => api.graphVerdicts.approve(current.id),
    onSuccess: (result) => {
      setActionError(null);
      setCurrent(result.verdict);
      invalidate();
    },
    onError: setActionError,
  });
  const reject = useMutation({
    mutationFn: () => api.graphVerdicts.reject(current.id),
    onSuccess: settle,
    onError: setActionError,
  });
  const apply = useMutation({
    mutationFn: () => api.graphVerdicts.apply(current.id),
    onSuccess: settle,
    onError: setActionError,
  });
  /**
   * The one-click primary when the dry run is green: the approve→apply state
   * machine stays intact server-side, only the UI collapses the two steps.
   * If apply fails after approval, the sheet stays open on the approved
   * verdict with the error (or stale banner) showing — same as the two-step
   * path would have.
   */
  const approveAndApply = useMutation({
    mutationFn: async () => {
      const approved = await api.graphVerdicts.approve(current.id);
      setCurrent(approved.verdict);
      return api.graphVerdicts.apply(current.id);
    },
    onSuccess: settle,
    onError: (err) => {
      setActionError(err);
      invalidate();
    },
  });
  const revert = useMutation({
    mutationFn: () => api.graphVerdicts.revert(current.id),
    onSuccess: settle,
    onError: setActionError,
  });

  const busy =
    approve.isPending || reject.isPending || apply.isPending || revert.isPending || approveAndApply.isPending;
  const previewStale = previewQuery.isError && isStaleError(previewQuery.error);
  const actionStale = isStaleError(actionError);
  const evidence = current.action === "classify_container" ? null : parseEvidence(current.evidence);
  const containerEvidence = current.action === "classify_container" ? parseContainerEvidence(current.evidence) : null;
  const wouldChange = previewQuery.data?.application.wouldChange ?? asCounts(current.wouldChange);

  const evidenceQuery = useQuery({
    queryKey: ["graph-verdicts", "evidence", current.id],
    queryFn: () => api.graphVerdicts.evidence(current.id),
    enabled: (evidence?.fileIds.length ?? 0) > 0,
  });

  return (
    <div className="mt-3 flex flex-1 flex-col gap-4 text-[13px]">
      <dl className="space-y-1.5">
        <DetailRow
          label="Subject"
          value={`${current.subjectName ?? current.subjectEntityId ?? current.subjectContainerId}`}
          mono={!current.subjectName}
        />
        {containerEvidence ? (
          <DetailRow
            label="Proposed"
            value={`${containerEvidence.classification}${containerEvidence.entityStatus === "historical" ? " (historical)" : ""}`}
            mono
          />
        ) : null}
        {current.targetEntityId ? (
          <DetailRow
            label="Target"
            value={`${current.targetName ?? current.targetEntityId}`}
            mono={!current.targetName}
          />
        ) : null}
        {current.action === "remove_alias" && current.targetName ? (
          <DetailRow label="Alias" value={current.targetName} />
        ) : null}
        <DetailRow label="Status" value={current.status} mono />
        <DetailRow label="Reason" value={current.reason} />
        {current.validationReason ? <DetailRow label="Validation" value={current.validationReason} mono /> : null}
        {current.appliedLedgerRef ? <DetailRow label="Ledger" value={current.appliedLedgerRef} mono /> : null}
      </dl>

      {evidence ? (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evidence</h3>
          <p className="font-mono text-[11px] text-muted-foreground">
            {evidence.fileIds.length} file{evidence.fileIds.length === 1 ? "" : "s"} · {evidence.reviewIds.length}{" "}
            review
            {evidence.reviewIds.length === 1 ? "" : "s"}
          </p>
          {evidence.fileIds.length > 0 ? (
            evidenceQuery.isLoading ? (
              <Skeleton className="mt-1.5 h-14 rounded-md" />
            ) : (evidenceQuery.data?.rows.length ?? 0) > 0 ? (
              <div className="mt-1.5">
                <EvidenceList
                  testId="graph-verdict-evidence"
                  items={(evidenceQuery.data?.rows ?? []).map((row) => ({
                    key: row.fileId,
                    snippet: row.contextSnippet,
                    fileName: row.fileName,
                    source: row.source,
                    occurredAt: row.occurredAt,
                  }))}
                />
              </div>
            ) : null
          ) : null}
          {evidence.notes.map((note) => (
            <p key={note} className="mt-1 text-[12px] text-muted-foreground">
              {note}
            </p>
          ))}
        </div>
      ) : null}

      {containerEvidence && containerEvidence.samples.length > 0 ? (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sample items</h3>
          {containerEvidence.samples.map((sample) => (
            <p key={sample} className="mt-0.5 truncate text-[12px] text-muted-foreground">
              {sample}
            </p>
          ))}
        </div>
      ) : null}

      {canPreview(current.status) ? (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What applying will do
          </h3>
          {previewQuery.isLoading ? (
            <Skeleton className="h-8 rounded-md" />
          ) : previewStale ? (
            <StaleBanner />
          ) : previewQuery.isError ? (
            <p className="text-[12px] text-destructive">Dry run failed: {String(previewQuery.error)}</p>
          ) : (
            <WouldChangeTable counts={wouldChange} />
          )}
        </div>
      ) : null}

      {actionStale ? <StaleBanner /> : null}
      {actionError && !actionStale ? <p className="text-[12px] text-destructive">{String(actionError)}</p> : null}

      <div className="mt-auto flex justify-end gap-2 border-t border-border pt-3">
        {current.status === "awaiting_human" ? (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate()}>
              Reject
            </Button>
            {previewQuery.isSuccess ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => approveAndApply.mutate()}
                data-testid="graph-verdict-approve"
              >
                Approve &amp; apply
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => approve.mutate()} data-testid="graph-verdict-approve">
                Approve
              </Button>
            )}
          </>
        ) : null}
        {current.status === "approved" ? (
          <Button
            size="sm"
            disabled={busy || !previewQuery.isSuccess}
            onClick={() => apply.mutate()}
            data-testid="graph-verdict-apply"
            title={previewQuery.isSuccess ? undefined : "Apply unlocks once the dry run succeeds"}
          >
            Apply
          </Button>
        ) : null}
        {current.status === "applied" ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => revert.mutate()}>
            Undo
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono text-[11.5px]" : "text-[12.5px]"}`}>{value}</dd>
    </div>
  );
}

function StaleBanner() {
  return (
    <p
      className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px]"
      data-testid="graph-verdict-stale"
    >
      Evidence changed since this was proposed — the graph moved underneath it. Ask the agent to re-propose.
    </p>
  );
}

function WouldChangeTable({ counts }: { counts: Record<string, number> | null }) {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) {
    return <p className="text-[12px] text-muted-foreground">No rows change — this action is a no-op.</p>;
  }
  return (
    <div className="divide-y divide-border rounded-md border border-border">
      {entries.map(([table, count]) => (
        <div key={table} className="flex items-center justify-between px-3 py-1.5">
          <span className="font-mono text-[11.5px]">{table}</span>
          <span className="font-mono text-[11.5px] text-muted-foreground">{count}</span>
        </div>
      ))}
    </div>
  );
}

function parseEvidence(raw: unknown): { fileIds: string[]; reviewIds: string[]; notes: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { fileIds?: unknown; reviewIds?: unknown; notes?: unknown };
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
  return { fileIds: strings(value.fileIds), reviewIds: strings(value.reviewIds), notes: strings(value.notes) };
}

function asCounts(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, number>;
}

const CONTAINER_CLASSIFICATIONS = new Set(["team", "project", "time_box", "account", "ignore"]);

export function parseContainerEvidence(
  raw: unknown,
): { classification: string; entityStatus: string; samples: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { classification?: unknown; entityStatus?: unknown; samples?: unknown };
  if (typeof value.classification !== "string" || !CONTAINER_CLASSIFICATIONS.has(value.classification)) return null;
  const entityStatus = value.entityStatus === "historical" ? "historical" : "active";
  const samples = Array.isArray(value.samples)
    ? value.samples.filter((item): item is string => typeof item === "string").slice(0, 12)
    : [];
  return { classification: value.classification, entityStatus, samples };
}

export function containerClassificationOf(verdict: GraphVerdict): string | null {
  if (verdict.action !== "classify_container") return null;
  return parseContainerEvidence(verdict.evidence)?.classification ?? null;
}
