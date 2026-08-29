import { CompactAction } from "@/components/compact-action";
import { SourceTag } from "@/components/entity-drawer/drawer-kit";
/**
 * The review surface for Your Org: each type tab's band, expanding in place
 * to the full type-scoped list (the standalone Review tab is gone — triage
 * keeps its type context). Rows render as {@link ReviewRowCompact} — a single
 * line with quiet text actions, because the band sits above a directory and
 * must not read as a second queue.
 *
 * Row-body clicks open the existing reconcile sheet
 * ({@link ReviewDetailSheet}) for rows with a suggested match or the birth
 * inspect sheet ({@link BirthInspectSheet}) for rows without one — evidence,
 * match reason, and pick-a-different-existing all live there.
 */
import { isExpiringSoon, isWeeklyPassProjectRow } from "@/components/entity-review/entity-format";
import { BirthInspectSheet, ReviewDetailSheet } from "@/components/entity-review/review-band";
import {
  WhatsAppIdentityDrawer,
  WhatsAppIdentityRow,
  useWhatsAppIdentityReview,
} from "@/components/entity-review/whatsapp-identity-review";
import { GraphVerdictsSection, graphVerdictBandType } from "@/components/graph-verdicts-section";
import { OrgRow } from "@/components/org-row";
import { ProjectSuggestionsSection } from "@/components/project-suggestions";
import { useReviewMutations } from "@/components/review-actions";
import type { EntityReviewQueueRow } from "@/lib/api";
import { api } from "@/lib/api";
import { EntityAvatar } from "@/lib/entity-ui";
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/** Shared 300ms debounce for the org search inputs (band + tab lists). */
export function useDebouncedSearch(delay = 300) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const ref = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => {
    if (ref.current) clearTimeout(ref.current);
    ref.current = setTimeout(() => setDebounced(search.trim()), delay);
    return () => {
      if (ref.current) clearTimeout(ref.current);
    };
  }, [search, delay]);
  return { search, setSearch, debounced };
}

/**
 * Manages the two review sheets (reconcile vs birth inspect) for a list of
 * rows and exposes an `openRow` that routes each row to the right one. Also
 * hands back a `refresh` that clears the whole `entity-review` query prefix
 * (bands + tabs live outside `LIST_KEY`, so the mutation hook's own
 * invalidation would miss them).
 */
export function useReviewRowSheets() {
  const queryClient = useQueryClient();
  const [reconcileId, setReconcileId] = useState<string | null>(null);
  const [birthId, setBirthId] = useState<string | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["entity-review"] });
    queryClient.invalidateQueries({ queryKey: ["entities"] });
  };

  const openRow = (row: EntityReviewQueueRow) => {
    if (row.candidate || (row.candidates?.length ?? 0) > 0) setReconcileId(row.id);
    else setBirthId(row.id);
  };

  const sheets = (
    <>
      <ReviewDetailSheet reviewId={reconcileId} onClose={() => setReconcileId(null)} />
      <BirthInspectSheet reviewId={birthId} onResolved={refresh} onClose={() => setBirthId(null)} />
    </>
  );

  return { openRow, sheets, refresh };
}

/**
 * One-line review row: name, muted suggested-match, quiet Confirm/Dismiss
 * text actions. Everything else (evidence detail, match reason, pick
 * existing) is one click away in the sheet. `detail` adds the candidate email
 * and a per-source evidence summary — the Review tab turns it on; the capped
 * bands stay tightest.
 */
export function ReviewRowCompact({
  row,
  onOpen,
  onResolved,
  detail,
  selectMode,
  selectable,
  isSelected,
  onToggleSelect,
}: {
  row: EntityReviewQueueRow;
  onOpen: (row: EntityReviewQueueRow) => void;
  onResolved: () => void;
  detail?: boolean;
  selectMode?: boolean;
  selectable?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (row: EntityReviewQueueRow) => void;
}) {
  const mutations = useReviewMutations(row, onResolved);
  const candidates = row.candidates ?? (row.candidate ? [row.candidate] : []);
  const hasCandidate = row.candidate_entity_id !== null || candidates.length > 0;
  const suggestion = hasCandidate
    ? `→ ${candidates.map((candidate) => `${candidate.name}${detail && candidate.email ? ` · ${candidate.email}` : ""}`).join(", ")}`
    : "new — no suggested match";
  const evidence =
    detail && row.sourceBreakdown.length > 0
      ? row.sourceBreakdown.map((b) => `${b.count}× ${b.source}`).join(", ")
      : null;
  /**
   * Project rows born from file evidence never get inline confirm/dismiss:
   * a one-click confirm would birth a bare section-less entity (the server
   * refuses it too), and dismiss is terminal — it silently starves future
   * sub-project minting. The only safe one-click action is linking to the
   * single suggested entity; everything else lives in the sheet. Structural
   * connector rows keep the standard actions.
   */
  const guardedProject = isWeeklyPassProjectRow(row);
  const linkOnly = guardedProject && row.candidate_entity_id !== null;
  const sheetOnly = guardedProject && row.candidate_entity_id === null;
  return (
    <OrgRow
      testId={`org-review-row-${row.id}`}
      rowClassName={selectMode && !selectable ? "opacity-45" : undefined}
      disabled={selectMode && !selectable}
      onOpen={() => (selectMode ? onToggleSelect?.(row) : onOpen(row))}
      avatar={
        <>
          {selectMode ? (
            <input
              type="checkbox"
              readOnly
              tabIndex={-1}
              checked={isSelected ?? false}
              disabled={!selectable}
              className="pointer-events-none size-3.5 shrink-0 accent-foreground"
              data-testid={`org-review-select-${row.id}`}
            />
          ) : null}
          <EntityAvatar entity={{ id: row.id, name: row.proposed_name, sourceType: row.entity_type }} size="sm" />
        </>
      }
      primary={row.proposed_name}
      inlineSuffix={suggestion}
      meta={
        evidence ? (
          <span className="hidden shrink-0 text-[10.5px] text-muted-foreground/70 sm:inline">{evidence}</span>
        ) : null
      }
      actions={
        sheetOnly || selectMode ? null : (
          <span className="flex shrink-0 items-center gap-0.5 pr-3">
            <CompactAction
              label={linkOnly ? "Link" : hasCandidate ? "Confirm" : "Add"}
              emphasis
              disabled={mutations.isPending}
              onClick={() => mutations.confirm()}
            />
            {linkOnly ? null : (
              <>
                <span className="text-muted-foreground/40">·</span>
                <CompactAction label="Dismiss" disabled={mutations.isPending} onClick={() => mutations.dismiss()} />
              </>
            )}
          </span>
        )
      }
      footer={
        mutations.errorCopy ? (
          <p className="px-3 pb-1.5 text-[11px] text-destructive">{mutations.errorCopy.message}</p>
        ) : null
      }
    />
  );
}

/** A birth proposal — no suggested match at all; bulk verb is Dismiss. */
function isBirthRow(row: EntityReviewQueueRow): boolean {
  return row.candidate_entity_id === null && (row.candidates?.length ?? 0) === 0;
}

/** The origin shown in the bulk source filter — LLM origin first, structural seed as fallback. */
function bulkSource(row: EntityReviewQueueRow): string {
  return row.source ?? row.seed_source ?? "unknown";
}

/** Whether the row was last seen more than `days` ago (missing timestamps never match). */
function olderThan(row: EntityReviewQueueRow, days: number): boolean {
  const seen = row.last_seen_at ?? row.first_seen_at;
  if (!seen) return false;
  return Date.now() - new Date(seen).getTime() > days * 24 * 60 * 60 * 1000;
}

/** Label for the next natural weekly pass — the Monday after today. */
function nextPassLabel(): string {
  const now = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  return next.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/**
 * Candidate-less, seed-less project rows are not individually actionable —
 * they pool for the weekly mint pass. One summary line by default; clicking
 * it discloses the read-only list for transparency. "Run now" (admin) forces
 * this week's pass early, behind a warning: re-judging previously skipped
 * groups is where measured LLM variance re-mints junk.
 */
function PoolingSummary({
  rows,
  isAdmin,
  onRunStarted,
}: {
  rows: EntityReviewQueueRow[];
  isAdmin: boolean;
  onRunStarted: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const run = useMutation({
    mutationFn: () => api.projectMinting.runNow(),
    onSuccess: () => {
      setConfirmOpen(false);
      setStarted(true);
      onRunStarted();
    },
  });

  if (rows.length === 0) return null;

  const expiringCount = rows.filter(isExpiringSoon).length;

  return (
    <div className="border-t border-amber-300/40 dark:border-amber-700/30" data-testid="review-band-pooling">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setListOpen((v) => !v)}
          className="min-w-0 truncate text-left text-[11.5px] text-muted-foreground hover:text-foreground"
          data-testid="review-band-pooling-toggle"
        >
          {listOpen ? "▾" : "▸"} {rows.length} new {rows.length === 1 ? "name" : "names"} pooling for the weekly pass ·
          next pass {nextPassLabel()}
          {expiringCount > 0 ? ` · ${expiringCount} expiring` : ""}
        </button>
        {isAdmin ? (
          started ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">pass running — check back shortly</span>
          ) : (
            <CompactAction
              label="Run now"
              emphasis
              className="shrink-0"
              onClick={() => setConfirmOpen(true)}
              data-testid="review-band-run-now"
            />
          )
        ) : null}
      </div>
      {run.isError ? (
        <p className="px-3 pb-1.5 text-[11px] text-destructive">
          {run.error instanceof Error && run.error.message.includes("already")
            ? "A pass is already running."
            : "Could not start the pass. Try again shortly."}
        </p>
      ) : null}
      {listOpen ? (
        <div className="border-t border-amber-300/30 dark:border-amber-700/20">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 last:border-b-0"
              data-testid={`review-band-pooling-row-${row.id}`}
            >
              <EntityAvatar entity={{ id: row.id, name: row.proposed_name, sourceType: row.entity_type }} size="sm" />
              <span className="min-w-0 flex-1 truncate text-[12px]">{row.proposed_name}</span>
              {isExpiringSoon(row) ? (
                <SourceTag className="tracking-wide" data-testid="review-band-expiring-chip">
                  expiring
                </SourceTag>
              ) : null}
              <span className="shrink-0 text-[10.5px] text-muted-foreground/70">seen {row.occurrence_count}×</span>
            </div>
          ))}
        </div>
      ) : null}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Run the mint pass now?</DialogTitle>
            <DialogDescription>
              This re-judges groups the last pass skipped — occasional model variance can re-mint junk, which lands in
              the dossier for you to strike. Companies with a dossier already awaiting review are left untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} disabled={run.isPending}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending} data-testid="run-now-confirm">
              {run.isPending ? "Starting…" : "Run now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Type-scoped review band — the only review surface now that the Review tab
 * is gone. No collapsed preview: the full type-scoped list always renders in
 * a capped scroll region, so the directory below stays reachable. The band has
 * no search box of its own — the org-wide search is the only search, and the
 * results view remounts this band with the query via `search` so pending
 * reviews are filtered alongside entities. Projects additionally get the
 * pending mint dossiers first (admin) and the pooling summary last. Admins
 * also get the graph-curation verdict lane ({@link GraphVerdictsSection}) —
 * open verdicts filtered to this tab's subject types. `null` when there is
 * nothing to review keeps the entity list flush to the top.
 *
 * Select mode (the header toggle) turns the list into bulk triage: client-side
 * source/age/births filters over the fetched page, checkboxes on rows, and a
 * footer that splits the selection by verb — Dismiss for births (drops the
 * proposal), Confirm for rows with a suggested match. Weekly-pass project rows
 * are never selectable: bulk-dismiss silently starves sub-project minting.
 */
export function ReviewBandCapped({
  types,
  isAdmin = false,
  search = "",
}: {
  types: string[];
  isAdmin?: boolean;
  search?: string;
}) {
  const activeSearch = search.trim();
  const matchesSearch = (...names: (string | null | undefined)[]) =>
    activeSearch.length === 0 || names.some((n) => n?.toLowerCase().includes(activeSearch.toLowerCase()));

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState("all");
  const [ageFilter, setAgeFilter] = useState("any");
  const [birthsOnly, setBirthsOnly] = useState(false);

  const { data } = useQuery({
    queryKey: ["entity-review", "band-capped", types.join(","), activeSearch],
    queryFn: () => api.entityReview.list({ limit: 200, types, search: activeSearch || undefined }),
    refetchInterval: 30000,
  });
  const queryClient = useQueryClient();
  const rows = data?.rows ?? [];
  const realTotal = data?.total ?? rows.length;
  const { openRow, sheets, refresh } = useReviewRowSheets();

  const isProjectBand = types.includes("project");
  const verdictsQuery = useQuery({
    queryKey: ["project-minting", "verdicts"],
    queryFn: () => api.projectMinting.listVerdicts(),
    enabled: isAdmin && isProjectBand,
    retry: false,
    refetchInterval: 30000,
  });
  const verdicts =
    isAdmin && isProjectBand
      ? (verdictsQuery.data?.verdicts ?? []).filter((verdict) => matchesSearch(verdict.companyName))
      : [];

  const graphVerdictsQuery = useQuery({
    queryKey: ["graph-verdicts", "open"],
    queryFn: () => api.graphVerdicts.listOpen(),
    enabled: isAdmin,
    retry: false,
    refetchInterval: 30000,
  });
  const graphVerdicts = isAdmin
    ? (graphVerdictsQuery.data?.verdicts ?? []).filter(
        (verdict) =>
          types.includes(graphVerdictBandType(verdict)) && matchesSearch(verdict.subjectName, verdict.targetName),
      )
    : [];

  const poolingRows = isProjectBand
    ? rows.filter(
        (row) => isWeeklyPassProjectRow(row) && row.candidate_entity_id === null && (row.candidates?.length ?? 0) === 0,
      )
    : [];
  const poolingIds = new Set(poolingRows.map((row) => row.id));
  const actionableRows = rows.filter((row) => !poolingIds.has(row.id));

  /**
   * Weekly-pass project rows never join a bulk action (dismiss starves future
   * sub-project minting; confirm can birth a bare entity), and rows without a
   * CAS timestamp can't clear the server's per-item check.
   */
  const isSelectable = (row: EntityReviewQueueRow) =>
    !isWeeklyPassProjectRow(row) && row.candidate_generated_at !== null;
  const passesBulkFilters = (row: EntityReviewQueueRow) =>
    (sourceFilter === "all" || bulkSource(row) === sourceFilter) &&
    (ageFilter === "any" || olderThan(row, Number(ageFilter))) &&
    (!birthsOnly || isBirthRow(row));
  const visibleRows = selectMode ? actionableRows.filter(passesBulkFilters) : actionableRows;
  const selectableVisible = visibleRows.filter(isSelectable);
  const sourceOptions = [...new Set(actionableRows.map(bulkSource))].sort();
  const selectedRows = actionableRows.filter((row) => selected.has(row.id) && isSelectable(row));
  const selectedBirths = selectedRows.filter(isBirthRow);
  const selectedMatches = selectedRows.filter((row) => !isBirthRow(row));

  const toggleSelect = (row: EntityReviewQueueRow) => {
    if (!isSelectable(row)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  };
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const wa = useWhatsAppIdentityReview(types);
  const waItems = wa.items.filter((item) => matchesSearch(item.phoneE164, item.lid));
  const [waSelected, setWaSelected] = useState<string | null>(null);

  const bulk = useMutation({
    mutationFn: ({ verb, items }: { verb: "dismiss" | "confirm"; items: EntityReviewQueueRow[] }) => {
      const payload = items.map((row) => ({
        reviewId: row.id,
        candidateGeneratedAt: row.candidate_generated_at ?? "",
      }));
      return verb === "dismiss" ? api.entityReview.dismissBatch(payload) : api.entityReview.confirmBatch(payload);
    },
    onSuccess: (res, { verb }) => {
      const okIds = new Set(res.results.filter((r) => r.ok).map((r) => r.reviewId));
      const failed = res.results.length - okIds.size;
      const label = verb === "dismiss" ? "Dismissed" : "Confirmed";
      if (failed === 0) toast.success(`${label} ${okIds.size} ${okIds.size === 1 ? "row" : "rows"}.`);
      else toast.warning(`${label} ${okIds.size}, ${failed} failed — failed rows stay selected in the queue.`);
      setSelected((prev) => new Set([...prev].filter((id) => !okIds.has(id))));
      refresh();
    },
    onError: () => toast.error("Bulk action failed. Try again."),
  });

  if (rows.length === 0 && waItems.length === 0 && verdicts.length === 0 && graphVerdicts.length === 0) return null;

  const headerCount = realTotal + waItems.length + verdicts.length + graphVerdicts.length;

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-amber-300/60 bg-amber-50/40 dark:border-amber-700/50 dark:bg-amber-950/20">
      <div className="flex items-baseline justify-between border-b border-amber-300/50 px-3 py-2 dark:border-amber-700/40">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
          Needs your review · {headerCount}
        </span>
        {actionableRows.length > 0 ? (
          <CompactAction
            label={selectMode ? "Done" : "Select"}
            emphasis
            className="shrink-0"
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            data-testid="review-band-select-toggle"
          />
        ) : null}
      </div>
      {selectMode ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-300/40 px-3 py-1.5 dark:border-amber-700/30">
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="h-6 rounded-md border border-border bg-background px-1.5 text-[11px]"
            data-testid="review-band-source-filter"
          >
            <option value="all">All sources</option>
            {sourceOptions.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
          <select
            value={ageFilter}
            onChange={(e) => setAgeFilter(e.target.value)}
            className="h-6 rounded-md border border-border bg-background px-1.5 text-[11px]"
            data-testid="review-band-age-filter"
          >
            <option value="any">Any age</option>
            <option value="7">Older than 7 days</option>
            <option value="30">Older than 30 days</option>
          </select>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={birthsOnly}
              onChange={(e) => setBirthsOnly(e.target.checked)}
              className="size-3 accent-foreground"
              data-testid="review-band-births-only"
            />
            Births only
          </label>
          <span className="flex-1" />
          <CompactAction
            label={`Select all ${selectableVisible.length}`}
            onClick={() => setSelected(new Set(selectableVisible.map((row) => row.id)))}
            data-testid="review-band-select-all"
          />
          <span className="text-muted-foreground/40">·</span>
          <CompactAction label="Clear" onClick={() => setSelected(new Set())} />
        </div>
      ) : null}
      {verdicts.length > 0 ? <ProjectSuggestionsSection verdicts={verdicts} /> : null}
      {graphVerdicts.length > 0 ? (
        <GraphVerdictsSection verdicts={graphVerdicts} allOpen={graphVerdictsQuery.data?.verdicts ?? graphVerdicts} />
      ) : null}
      <div className="max-h-[60vh] overflow-y-auto">
        {visibleRows.map((row) => (
          <ReviewRowCompact
            key={row.id}
            row={row}
            onOpen={openRow}
            onResolved={refresh}
            detail
            selectMode={selectMode}
            selectable={isSelectable(row)}
            isSelected={selected.has(row.id)}
            onToggleSelect={toggleSelect}
          />
        ))}
        {waItems.map((item) => (
          <WhatsAppIdentityRow
            key={item.id}
            item={item}
            onOpen={() => setWaSelected(item.id)}
            onResolve={(message) => wa.resolve(item.id, message)}
          />
        ))}
        {realTotal > rows.length ? (
          <p className="border-t border-amber-300/40 px-3 py-2 text-[10.5px] text-muted-foreground dark:border-amber-700/30">
            Showing {rows.length} of {realTotal}. Use the org search above to narrow the rest.
          </p>
        ) : null}
      </div>
      {selectMode ? (
        <div
          className="flex flex-wrap items-center gap-2 border-t border-amber-300/50 px-3 py-2 dark:border-amber-700/40"
          data-testid="review-band-bulk-bar"
        >
          <span className="text-[11.5px] text-muted-foreground">{selectedRows.length} selected</span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[11px]"
            disabled={selectedBirths.length === 0 || bulk.isPending}
            onClick={() => bulk.mutate({ verb: "dismiss", items: selectedBirths })}
            data-testid="review-band-bulk-dismiss"
          >
            Dismiss {selectedBirths.length} {selectedBirths.length === 1 ? "birth" : "births"}
          </Button>
          <Button
            size="sm"
            className="h-6 text-[11px]"
            disabled={selectedMatches.length === 0 || bulk.isPending}
            onClick={() => bulk.mutate({ verb: "confirm", items: selectedMatches })}
            data-testid="review-band-bulk-confirm"
          >
            Confirm {selectedMatches.length} {selectedMatches.length === 1 ? "match" : "matches"}
          </Button>
        </div>
      ) : null}
      <PoolingSummary
        rows={poolingRows}
        isAdmin={isAdmin}
        onRunStarted={() => {
          queryClient.invalidateQueries({ queryKey: ["project-minting"] });
          queryClient.invalidateQueries({ queryKey: ["entity-review"] });
        }}
      />
      {sheets}
      <WhatsAppIdentityDrawer
        item={wa.items.find((item) => item.id === waSelected) ?? null}
        onClose={() => setWaSelected(null)}
        onResolve={wa.resolve}
      />
    </section>
  );
}
