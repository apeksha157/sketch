import { CompactAction } from "@/components/compact-action";
/**
 * "Agent proposals" — open graph-curation verdicts (awaiting a decision, or
 * approved but not yet applied), rendered as a section of each type tab's
 * review band. Presentational: the band owns the query (admin-gated there)
 * and passes rows in, which also lets verdict presence count toward the
 * band's render/early-return decision. Dismiss rejects inline without opening
 * the sheet; row clicks open the shared {@link GraphVerdictSheet} with the
 * dry-run preview and the full decision flow.
 */
import {
  GRAPH_VERDICT_ACTION_LABELS,
  GraphVerdictSheet,
  containerClassificationOf,
  relatedOpenVerdicts,
} from "@/components/graph-verdict-sheet";
import { OrgRow } from "@/components/org-row";
import { type GraphVerdict, api } from "@/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  const dismiss = useMutation({
    mutationFn: (verdictId: string) => api.graphVerdicts.reject(verdictId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["graph-verdicts"] });
    },
  });

  if (verdicts.length === 0) return null;

  const open = verdicts.find((verdict) => verdict.id === openId) ?? null;

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
                <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
                  {GRAPH_VERDICT_ACTION_LABELS[verdict.action] ?? verdict.action}
                </span>
              }
              primary={verdict.subjectName ?? verdict.subjectEntityId ?? verdict.subjectContainerId}
              inlineSuffix={target ? `→ ${target}` : undefined}
              meta={
                <>
                  {relatedOpenVerdicts(verdict, allOpen ?? verdicts).length > 0 ? (
                    <span
                      className="shrink-0 font-mono text-[9.5px] uppercase tracking-wide text-amber-700 dark:text-amber-400"
                      data-testid={`graph-verdict-related-chip-${verdict.id}`}
                    >
                      ⛓ related
                    </span>
                  ) : null}
                  {verdict.status === "approved" ? (
                    <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-wide text-muted-foreground">
                      approved — apply pending
                    </span>
                  ) : null}
                </>
              }
              actions={
                verdict.status === "awaiting_human" ? (
                  <CompactAction
                    label="Dismiss"
                    className="shrink-0 pr-3"
                    disabled={dismiss.isPending}
                    onClick={() => dismiss.mutate(verdict.id)}
                  />
                ) : null
              }
            />
          );
        })}
      </div>
      <GraphVerdictSheet verdict={open} onClose={() => setOpenId(null)} />
    </section>
  );
}
