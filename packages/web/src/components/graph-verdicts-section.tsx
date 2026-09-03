import { CompactAction } from "@/components/compact-action";
/**
 * "Agent proposals" — open graph-curation verdicts (awaiting a decision, or
 * approved but not yet applied), rendered as a section of each type tab's
 * review band. Presentational: the band owns the query (admin-gated there)
 * and passes rows in, which also lets verdict presence count toward the
 * band's render/early-return decision. Dismiss rejects inline without opening
 * the sheet. Confirm on a merge proposal opens the {@link GraphVerdictSheet},
 * whose reconcile comparison is the merge surface; other actions get a plain
 * confirm dialog gated on the verdict's server dry run. Rows with related
 * open verdicts also go to the sheet, where the chain ordering is spelled
 * out. Row clicks open the same sheet.
 */
import {
  GRAPH_VERDICT_ACTION_LABELS,
  GraphVerdictSheet,
  containerClassificationOf,
  relatedOpenVerdicts,
  summarizeWouldChange,
  verdictTitle,
} from "@/components/graph-verdict-sheet";
import { OrgRow } from "@/components/org-row";
import { type GraphVerdict, api } from "@/lib/api";
import { EntityAvatar } from "@/lib/entity-ui";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sketch/ui/components/alert-dialog";
import { Button } from "@sketch/ui/components/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const BAND_TYPES = new Set(["person", "company", "team", "project", "product", "tool"]);

/**
 * Which type tab's band a verdict belongs to. Subject entity type when it is
 * a real taxonomy type; container-classification verdicts land where their
 * proposed classification will live (team → Teams, everything else →
 * Projects, the container spine's home tab).
 */
export function graphVerdictBandType(verdict: GraphVerdict): string {
  if (verdict.subjectEntityType && BAND_TYPES.has(verdict.subjectEntityType)) return verdict.subjectEntityType;
  if (verdict.action === "classify_container" && containerClassificationOf(verdict) === "team") return "team";
  return "project";
}

/**
 * `allOpen` is the unfiltered open-verdict list (a chain can cross type
 * tabs); it defaults to the section's own rows when the caller has nothing
 * wider. Rows that share a survivor or form a chain get a "related" chip —
 * the sheet spells out which order is safe.
 */
export function GraphVerdictsSection({ verdicts, allOpen }: { verdicts: GraphVerdict[]; allOpen?: GraphVerdict[] }) {
  const queryClient = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const dismiss = useMutation({
    mutationFn: (verdictId: string) => api.graphVerdicts.reject(verdictId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["graph-verdicts"] });
    },
  });

  const confirm = verdicts.find((verdict) => verdict.id === confirmId) ?? null;
  const confirmPreview = useQuery({
    queryKey: ["graph-verdicts", "preview", confirmId],
    queryFn: () => api.graphVerdicts.apply(confirmId as string, { dryRun: true }),
    enabled: !!confirmId,
    retry: false,
  });
  /**
   * The server's approve→apply state machine stays intact; only the UI
   * collapses the steps. Any failure closes the dialog and opens the sheet,
   * which knows how to render stale banners and errors.
   */
  const approveApply = useMutation({
    mutationFn: async (verdictId: string) => {
      await api.graphVerdicts.approve(verdictId);
      return api.graphVerdicts.apply(verdictId);
    },
    onSuccess: () => {
      const appliedId = confirmId;
      setConfirmId(null);
      queryClient.removeQueries({ queryKey: ["graph-verdicts", "preview", appliedId] });
      queryClient.invalidateQueries({ queryKey: ["graph-verdicts"] });
    },
    onError: () => {
      const failedId = confirmId;
      setConfirmId(null);
      setOpenId(failedId);
      queryClient.invalidateQueries({ queryKey: ["graph-verdicts"] });
    },
  });

  if (verdicts.length === 0) return null;

  const open = verdicts.find((verdict) => verdict.id === openId) ?? null;
  const confirmSummary = confirm
    ? summarizeWouldChange(confirm, confirmPreview.data?.application.wouldChange ?? null)
    : null;
  const confirmSummaryNode = (
    <p className="text-xs text-muted-foreground" data-testid="graph-verdict-confirm-summary">
      {confirmPreview.isLoading
        ? "Running a dry run on the server…"
        : confirmPreview.isError
          ? "The dry run failed — open the proposal for details."
          : (confirmSummary ?? "No rows change — this action is a no-op.")}
    </p>
  );

  return (
    <section
      className="overflow-hidden border-b border-amber-300/40 dark:border-amber-700/30"
      data-testid="review-band-graph-verdicts"
    >
      <div className="flex items-baseline justify-between border-b border-border bg-muted/30 px-3 py-2">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Agent proposals · {verdicts.length}
        </span>
      </div>
      <div>
        {verdicts.map((verdict) => {
          const target = verdict.targetEntityId
            ? (verdict.targetName ?? verdict.targetEntityId)
            : verdict.action === "remove_alias" && verdict.targetName
              ? verdict.targetName
              : containerClassificationOf(verdict);
          return (
            <OrgRow
              key={verdict.id}
              buttonTestId={`graph-verdict-band-row-${verdict.id}`}
              onOpen={() => setOpenId(verdict.id)}
              avatar={
                <EntityAvatar
                  entity={{
                    id: verdict.subjectEntityId ?? verdict.subjectContainerId ?? verdict.id,
                    name: verdict.subjectName ?? verdict.subjectEntityId ?? verdict.subjectContainerId ?? "?",
                    sourceType: verdict.subjectEntityType ?? "project",
                  }}
                  size="sm"
                />
              }
              primary={verdict.subjectName ?? verdict.subjectEntityId ?? verdict.subjectContainerId}
              inlineSuffix={target ? `→ ${target}` : undefined}
              meta={
                <>
                  <span className="hidden shrink-0 text-[10px] text-muted-foreground/70 sm:inline">
                    agent · {GRAPH_VERDICT_ACTION_LABELS[verdict.action] ?? verdict.action}
                  </span>
                  {relatedOpenVerdicts(verdict, allOpen ?? verdicts).length > 0 ? (
                    <span
                      className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-amber-700 dark:text-amber-400"
                      data-testid={`graph-verdict-related-chip-${verdict.id}`}
                    >
                      ⛓ related
                    </span>
                  ) : null}
                  {verdict.status === "approved" ? (
                    <span className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                      approved — apply pending
                    </span>
                  ) : null}
                </>
              }
              actions={
                verdict.status === "awaiting_human" ? (
                  <span className="flex shrink-0 items-center gap-0.5 pr-3">
                    <CompactAction
                      label="Confirm"
                      emphasis
                      data-testid={`graph-verdict-band-approve-${verdict.id}`}
                      disabled={approveApply.isPending}
                      onClick={() =>
                        verdict.action === "merge_into" || relatedOpenVerdicts(verdict, allOpen ?? verdicts).length > 0
                          ? setOpenId(verdict.id)
                          : setConfirmId(verdict.id)
                      }
                    />
                    <span className="text-muted-foreground/40">·</span>
                    <CompactAction
                      label="Dismiss"
                      disabled={dismiss.isPending}
                      onClick={() => dismiss.mutate(verdict.id)}
                    />
                  </span>
                ) : null
              }
            />
          );
        })}
      </div>
      <GraphVerdictSheet verdict={open} onClose={() => setOpenId(null)} />
      <AlertDialog open={!!confirm} onOpenChange={(dialogOpen) => !dialogOpen && setConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{confirm ? verdictTitle(confirm) : ""}</AlertDialogTitle>
            <AlertDialogDescription asChild>{confirmSummaryNode}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approveApply.isPending}>Cancel</AlertDialogCancel>
            {confirmPreview.isError ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const failedId = confirmId;
                  setConfirmId(null);
                  setOpenId(failedId);
                }}
              >
                Open details
              </Button>
            ) : (
              <Button
                size="sm"
                data-testid="graph-verdict-confirm-apply"
                disabled={!confirmPreview.isSuccess || approveApply.isPending}
                onClick={() => confirm && approveApply.mutate(confirm.id)}
              >
                Apply
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
