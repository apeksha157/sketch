/**
 * The shared graph-verdict decision sheet, used by both the Your Org review
 * bands and the dev-tools runs panel. The sheet fetches a server dry run
 * before anything applies, so the human always approves what the server says
 * will happen, never what the proposal claimed. When the dry run is green the
 * primary is a single "Approve & apply"; when it isn't, plain Approve keeps
 * the sheet open on the refreshed verdict so Apply is one click away once the
 * dry run recovers. Every other decision closes the sheet.
 */
import { CompactAction } from "@/components/compact-action";
import { TimelineStrip } from "@/components/entity-drawer/timeline-strip";
import { humanSourceType } from "@/components/entity-review/entity-format";
import { CompareColumn, mentionTimelineGroups } from "@/components/entity-review/review-band";
import { EvidenceList } from "@/components/evidence-list";
import { ApiRequestError, type GraphVerdict, type GraphVerdictStatus, api } from "@/lib/api";
import { CheckIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@sketch/ui/components/sheet";
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
  link_to: "link mention",
  dismiss: "dismiss mention",
};

const TITLE_VERBS: Record<string, string> = {
  keep: "Keep",
  merge_into: "Merge",
  nest_under: "Nest",
  archive: "Archive",
  remove_alias: "Remove alias",
  classify_container: "Classify",
  link_to: "Link mention",
  dismiss: "Dismiss mention",
};

/**
 * "Merge OW → Oliver Wyman", never "merge into · OW" — the old form read as
 * merging INTO the subject. The arrow only appears for actions that carry a
 * target entity; remove_alias keeps its alias in the detail rows instead.
 */
export function verdictTitle(verdict: GraphVerdict): string {
  const verb = TITLE_VERBS[verdict.action] ?? GRAPH_VERDICT_ACTION_LABELS[verdict.action] ?? verdict.action;
  const subject =
    verdict.subjectName ?? verdict.subjectMentionName ?? verdict.subjectEntityId ?? verdict.subjectContainerId ?? "";
  const target = verdict.targetEntityId ? (verdict.targetName ?? verdict.targetEntityId) : null;
  return target ? `${verb} ${subject} → ${target}` : `${verb} ${subject}`.trim();
}

const STATUS_COPY: Record<GraphVerdictStatus, string> = {
  awaiting_human: "Awaiting your review",
  approved: "Approved — not yet applied",
  applied: "Applied",
  bounced: "Bounced by validation",
  rejected: "Rejected",
  reverted: "Reverted",
  pending_corroboration: "Waiting for more proof",
  veto_window: "Corroborated — ready",
  retired: "Retired — revives on new evidence",
};

const ENTITY_TYPE_PLURALS: Record<string, string> = {
  person: "people",
  company: "companies",
  team: "teams",
  project: "projects",
  product: "products",
  tool: "tools",
};

/**
 * Ledger and index rows the merge machinery writes as a consequence of the
 * decision — real, but not part of what the human is deciding. They fold into
 * one trailing phrase instead of one row each.
 */
const BOOKKEEPING_TABLES = new Set([
  "entity_merges",
  "entity_source_refs",
  "entity_name_embeddings",
  "fact_materialization_state",
]);

/**
 * The dry run reports per-table row counts; the reviewer is deciding a graph
 * change. This turns the counts into one sentence in graph terms ("2
 * companies become 1 · 1 mention moves to Oliver Wyman"), with unknown tables
 * degrading to a readable generic phrase rather than a schema name.
 */
export function summarizeWouldChange(verdict: GraphVerdict, counts: Record<string, number> | null): string | null {
  const entries = Object.entries(counts ?? {}).filter(([, count]) => count > 0);
  if (entries.length === 0) return null;
  const target = verdict.targetName ?? verdict.resolvedTargetEntityId ?? verdict.targetEntityId;
  const typePlural = ENTITY_TYPE_PLURALS[verdict.subjectEntityType ?? ""] ?? "entities";
  const s = (count: number) => (count === 1 ? "" : "s");
  const parts: string[] = [];
  let bookkeeping = false;
  for (const [table, count] of entries) {
    if (BOOKKEEPING_TABLES.has(table)) {
      bookkeeping = true;
      continue;
    }
    switch (table) {
      case "entities":
        parts.push(
          verdict.action === "merge_into" && count > 1
            ? `${count} ${typePlural} become 1`
            : `${count} entit${count === 1 ? "y" : "ies"} update${count === 1 ? "s" : ""}`,
        );
        break;
      case "entity_mentions":
        parts.push(
          verdict.action === "merge_into" && target
            ? `${count} mention${s(count)} move${count === 1 ? "s" : ""} to ${target}`
            : verdict.action === "link_to" && target
              ? `${count} mention${s(count)} link${count === 1 ? "s" : ""} to ${target}`
              : `${count} mention${s(count)} update`,
        );
        break;
      case "entity_relationships":
        parts.push(
          verdict.action === "merge_into"
            ? `${count} relationship${s(count)} move${count === 1 ? "s" : ""}`
            : `${count} relationship${s(count)} update`,
        );
        break;
      case "entity_review_queue":
        parts.push(`${count} review row${s(count)} resolve${count === 1 ? "s" : ""}`);
        break;
      case "entity_aliases":
        parts.push(`${count} alias${count === 1 ? "" : "es"} update`);
        break;
      case "containers":
        parts.push(
          verdict.action === "classify_container"
            ? `${count} container${s(count)} classified`
            : `${count} container${s(count)} update`,
        );
        break;
      default:
        parts.push(`${count} ${table.replace(/_/g, " ")} row${s(count)}`);
    }
  }
  if (bookkeeping) parts.push("plus ledger and index bookkeeping");
  return parts.join(" · ");
}

export const GRAPH_VERDICT_STATUS_TONES: Record<GraphVerdictStatus, string> = {
  awaiting_human: "text-amber-600 dark:text-amber-500",
  approved: "text-foreground",
  applied: "text-emerald-600 dark:text-emerald-500",
  bounced: "text-muted-foreground",
  rejected: "text-muted-foreground",
  reverted: "text-muted-foreground",
  pending_corroboration: "text-muted-foreground",
  veto_window: "text-amber-600 dark:text-amber-500",
  retired: "text-muted-foreground",
};

function isStaleError(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.code === "STALE_VERDICT" || err.code === "PLAN_DRIFT");
}

export type RelatedVerdictKind = "fan_in" | "chain_apply_this_first" | "chain_apply_other_first" | "same_subject";

function verdictTargetId(verdict: GraphVerdict): string | null {
  return verdict.resolvedTargetEntityId ?? verdict.targetEntityId;
}

/**
 * Other OPEN verdicts that touch the same entities as `current`. The server
 * dedupes on (subject, action) only, so fan-ins (two subjects merging into
 * one survivor — safe in any order) and chains (one verdict's target is the
 * other's subject — order decides which one goes stale) both reach the queue
 * with no cross-reference. This computes that awareness read-time so the
 * reviewer sees it BEFORE approving, not as a stale banner after.
 */
export function relatedOpenVerdicts(
  current: GraphVerdict,
  open: GraphVerdict[],
): { verdict: GraphVerdict; kind: RelatedVerdictKind }[] {
  const currentTarget = verdictTargetId(current);
  const out: { verdict: GraphVerdict; kind: RelatedVerdictKind }[] = [];
  for (const other of open) {
    if (other.id === current.id) continue;
    const otherTarget = verdictTargetId(other);
    let kind: RelatedVerdictKind | null = null;
    if (otherTarget && currentTarget && otherTarget === currentTarget) kind = "fan_in";
    else if (currentTarget && other.subjectEntityId === currentTarget) kind = "chain_apply_this_first";
    else if (otherTarget && current.subjectEntityId && otherTarget === current.subjectEntityId)
      kind = "chain_apply_other_first";
    else if (current.subjectEntityId && other.subjectEntityId === current.subjectEntityId) kind = "same_subject";
    if (kind) out.push({ verdict: other, kind });
  }
  return out;
}

const RELATED_KIND_COPY: Record<RelatedVerdictKind, string> = {
  fan_in: "lands on the same survivor — safe in any order",
  chain_apply_this_first: "merges this proposal's target away — apply this one first or it goes stale",
  chain_apply_other_first: "targets this proposal's subject — apply that one first or it goes stale",
  same_subject: "same entity, different action",
};

/**
 * The server allows a dry run for awaiting and approved rows only; anything
 * later already happened, so the sheet shows the recorded ledger ref instead.
 */
function canPreview(status: GraphVerdictStatus): boolean {
  return (
    status === "awaiting_human" ||
    status === "approved" ||
    status === "pending_corroboration" ||
    status === "veto_window"
  );
}

/**
 * Awaiting merge verdicts render the reconcile comparison (two columns, wide
 * sheet); everything else keeps the narrow detail layout.
 */
function isCompareLayout(verdict: GraphVerdict): boolean {
  return (
    verdict.action === "merge_into" &&
    verdict.status === "awaiting_human" &&
    !!verdict.subjectEntityId &&
    !!verdictTargetId(verdict)
  );
}

export function GraphVerdictSheet({ verdict, onClose }: { verdict: GraphVerdict | null; onClose: () => void }) {
  const wide = !!verdict && isCompareLayout(verdict);
  return (
    <Sheet open={!!verdict} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className={`flex w-full flex-col ${wide ? "sm:max-w-3xl" : "sm:max-w-[560px]"}`}>
        <SheetHeader>
          <SheetTitle className="text-base">
            {verdict
              ? wide
                ? `Reconcile: ${verdict.subjectName ?? verdict.subjectEntityId}`
                : verdictTitle(verdict)
              : ""}
          </SheetTitle>
          <SheetDescription className="sr-only">
            The proposal's reason and evidence, a server dry run of applying it, and the decision buttons.
          </SheetDescription>
        </SheetHeader>
        <div className={`flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3 ${wide ? "" : "overflow-y-auto"}`}>
          {verdict ? <VerdictDetail key={verdict.id} verdict={verdict} onDone={onClose} /> : null}
        </div>
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

  /**
   * Drop the dry-run preview before invalidating: a broad invalidate would
   * refetch the still-mounted preview against a decided verdict — a wasted
   * server dry run that can only error.
   */
  function settle() {
    setActionError(null);
    queryClient.removeQueries({ queryKey: ["graph-verdicts", "preview", current.id] });
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

  const openQuery = useQuery({
    queryKey: ["graph-verdicts", "open"],
    queryFn: () => api.graphVerdicts.listOpen(),
  });
  const related = relatedOpenVerdicts(current, openQuery.data?.verdicts ?? []);

  const compare = isCompareLayout(current);
  const targetId = verdictTargetId(current);
  const targetQuery = useQuery({
    queryKey: ["entity-detail", targetId],
    queryFn: () => api.entities.get(targetId as string),
    enabled: compare && !!targetId,
  });
  const targetMentionsQuery = useQuery({
    queryKey: ["entity-mentions", targetId, { limit: 20 }],
    queryFn: () => api.entities.mentions(targetId as string, { limit: 20 }),
    enabled: compare && !!targetId,
  });

  if (compare) {
    const targetEntity = targetQuery.data?.entity ?? null;
    const targetName = current.targetName ?? targetEntity?.name ?? (targetId as string);
    const targetMentions = targetMentionsQuery.data?.mentions ?? [];
    const evidenceRows = evidenceQuery.data?.rows ?? [];
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 text-[13px]">
        {related.length > 0 ? <RelatedProposals related={related} /> : null}
        {previewStale || actionStale ? <StaleBanner /> : null}
        {actionError && !actionStale ? <p className="text-xs text-destructive">{String(actionError)}</p> : null}
        <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-3 md:grid-cols-2">
          <CompareColumn
            testId="graph-verdict-subject"
            eyebrow="Proposed"
            toneClass="border-amber-400 bg-amber-50/40 dark:border-amber-400/60 dark:bg-amber-950/20"
            name={current.subjectName ?? (current.subjectEntityId as string)}
            meta={
              current.subjectEntityType ? (
                <Badge variant="outline" className="text-[10px]">
                  {humanSourceType(current.subjectEntityType)}
                </Badge>
              ) : undefined
            }
          >
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Evidence ({evidenceRows.length})
            </p>
            {evidenceQuery.isLoading ? (
              <Skeleton className="mt-1.5 h-14 rounded-md" />
            ) : evidenceRows.length > 0 ? (
              <div className="mt-1 flex-1 overflow-y-auto">
                <EvidenceList
                  testId="graph-verdict-evidence"
                  items={evidenceRows.map((row) => ({
                    key: row.fileId,
                    snippet: row.contextSnippet,
                    fileName: row.fileName,
                    source: row.source,
                    occurredAt: row.occurredAt,
                  }))}
                />
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">No file evidence.</p>
            )}
            {evidence?.notes.map((note) => (
              <p key={note} className="mt-1 text-xs text-muted-foreground">
                {note}
              </p>
            ))}
          </CompareColumn>
          <CompareColumn
            testId="graph-verdict-target"
            eyebrow="Suggested existing"
            toneClass="border-border bg-muted/20"
            name={targetName}
            error={previewQuery.isError && !previewStale ? `Dry run failed: ${String(previewQuery.error)}` : null}
            meta={
              <>
                {targetEntity ? (
                  <Badge variant="outline" className="text-[10px]">
                    {humanSourceType(targetEntity.sourceType)}
                  </Badge>
                ) : null}
                <span className="text-[11px] text-muted-foreground">· {current.reason}</span>
              </>
            }
            footer={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => approveAndApply.mutate()}
                  disabled={busy || !previewQuery.isSuccess}
                  data-testid="graph-verdict-approve"
                  className="h-7 gap-1 bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600"
                >
                  <CheckIcon size={12} weight="bold" />
                  Merge into {targetName}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => reject.mutate()}
                  disabled={busy}
                  data-testid="graph-verdict-reject"
                  className="h-7"
                >
                  Not a match
                </Button>
              </div>
            }
          >
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Recent mentions ({targetMentions.length})
            </p>
            {targetMentions.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">No mentions yet.</p>
            ) : (
              <div className="mt-1 flex-1 overflow-y-auto">
                <TimelineStrip groups={mentionTimelineGroups(targetMentions)} entityId={targetEntity?.id} />
              </div>
            )}
          </CompareColumn>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 text-[13px]">
      <dl className="space-y-1.5">
        {containerEvidence ? (
          <DetailRow
            label="Proposed"
            value={`${containerEvidence.classification}${containerEvidence.entityStatus === "historical" ? " (historical)" : ""}`}
            mono
          />
        ) : null}
        {current.action === "remove_alias" && current.targetName ? (
          <DetailRow label="Alias" value={current.targetName} />
        ) : null}
        <DetailRow label="Status" value={STATUS_COPY[current.status] ?? current.status} />
        <DetailRow label="Reason" value={current.reason} />
        {current.validationReason ? <DetailRow label="Validation" value={current.validationReason} mono /> : null}
        {current.appliedLedgerRef ? <DetailRow label="Ledger" value={current.appliedLedgerRef} mono /> : null}
      </dl>

      {evidence && (evidence.fileIds.length > 0 || evidence.reviewIds.length > 0 || evidence.notes.length > 0) ? (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evidence</h3>
          {evidence.fileIds.length > 0 || evidence.reviewIds.length > 0 ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              {evidence.fileIds.length} file{evidence.fileIds.length === 1 ? "" : "s"} · {evidence.reviewIds.length}{" "}
              review
              {evidence.reviewIds.length === 1 ? "" : "s"}
            </p>
          ) : null}
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
            <p key={note} className="mt-1 text-xs text-muted-foreground">
              {note}
            </p>
          ))}
        </div>
      ) : null}

      {containerEvidence && containerEvidence.samples.length > 0 ? (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sample items</h3>
          {containerEvidence.samples.map((sample) => (
            <p key={sample} className="mt-0.5 truncate text-xs text-muted-foreground">
              {sample}
            </p>
          ))}
        </div>
      ) : null}

      {related.length > 0 ? <RelatedProposals related={related} /> : null}

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
            <p className="text-xs text-destructive">Dry run failed: {String(previewQuery.error)}</p>
          ) : (
            <WouldChangeSummary verdict={current} counts={wouldChange} />
          )}
        </div>
      ) : null}

      {actionStale ? <StaleBanner /> : null}
      {actionError && !actionStale ? <p className="text-xs text-destructive">{String(actionError)}</p> : null}

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

function RelatedProposals({ related }: { related: { verdict: GraphVerdict; kind: RelatedVerdictKind }[] }) {
  return (
    <div data-testid="graph-verdict-related">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Related proposals</h3>
      <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
        {related.map(({ verdict: other, kind }) => (
          <p key={other.id} className="text-xs">
            <span className="font-mono text-[10px] uppercase text-muted-foreground">
              {GRAPH_VERDICT_ACTION_LABELS[other.action] ?? other.action}
            </span>{" "}
            <span className="font-medium">{other.subjectName ?? other.subjectEntityId}</span>
            {verdictTargetId(other) ? (
              <span className="text-muted-foreground"> → {other.targetName ?? verdictTargetId(other)}</span>
            ) : null}
            <span className="text-muted-foreground"> — {RELATED_KIND_COPY[kind]}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono text-[11px]" : "text-[12.5px]"}`}>{value}</dd>
    </div>
  );
}

function StaleBanner() {
  return (
    <p
      className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
      data-testid="graph-verdict-stale"
    >
      Evidence changed since this was proposed — the graph moved underneath it. Ask the agent to re-propose.
    </p>
  );
}

/**
 * The human sentence leads; the raw per-table counts stay one click away for
 * anyone who wants to check the plumbing.
 */
function WouldChangeSummary({ verdict, counts }: { verdict: GraphVerdict; counts: Record<string, number> | null }) {
  const [showCounts, setShowCounts] = useState(false);
  const summary = summarizeWouldChange(verdict, counts);
  if (!summary) {
    return <p className="text-xs text-muted-foreground">No rows change — this action is a no-op.</p>;
  }
  return (
    <div className="space-y-1.5">
      <p className="text-[12.5px]">{summary}</p>
      <CompactAction
        label={showCounts ? "Hide row counts" : "Show row counts"}
        className="-ml-1.5"
        data-testid="graph-verdict-counts-toggle"
        onClick={() => setShowCounts((value) => !value)}
      />
      {showCounts ? <WouldChangeTable counts={counts} /> : null}
    </div>
  );
}

function WouldChangeTable({ counts }: { counts: Record<string, number> | null }) {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No rows change — this action is a no-op.</p>;
  }
  return (
    <div className="divide-y divide-border rounded-md border border-border">
      {entries.map(([table, count]) => (
        <div key={table} className="flex items-center justify-between px-3 py-1.5">
          <span className="font-mono text-[11px]">{table}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{count}</span>
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
