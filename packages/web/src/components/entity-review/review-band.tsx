import { EntryList, SectionCard, SectionLabel, SourceTag } from "@/components/entity-drawer/drawer-kit";
import { TimelineStrip, usefulSnippet } from "@/components/entity-drawer/timeline-strip";
/**
 * The two review sheets behind Your Org's review band (the band itself is
 * {@link ReviewBandCapped} in routes/projects/org-review):
 *   - {@link BirthInspectSheet} — read-only inspect for a birth row (origin,
 *     linked files, tasks, rename-then-confirm, merge escape hatch).
 *   - {@link ReviewDetailSheet} — the reconcile drawer for rows with a
 *     suggested match: two side-by-side columns (Proposed | Suggested
 *     existing) with inline ✓/✗ on the candidate card. ✗ flips the right
 *     column to a "What instead?" chooser (search + create-as-new); orphan
 *     rows open directly in chooser mode.
 */
import { MergeDialog, MergePreview } from "@/components/entity-merge-dialog";
import { EntityPicker } from "@/components/entity-picker";
import { detailKey, useReviewMutations } from "@/components/review-actions";
import type {
  ChildTask,
  EntityListItem,
  EntityMention,
  EntityReviewEvidenceRow,
  EntityReviewQueueRow,
  EntityTimelineGroup,
  EntityTimelineItem,
} from "@/lib/api";
import { api } from "@/lib/api";
import { EntityAvatar, displayAliases, entityAccent } from "@/lib/entity-ui";
import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ArrowsLeftRightIcon,
  CheckIcon,
  PlugsConnectedIcon,
  PlusIcon,
  SparkleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { birthOrigin, entityEmail, humanSourceType, isWeeklyPassProjectRow } from "./entity-format";

/**
 * The review sheets render linked files with the same day-grouped timeline the
 * entity drawer uses, so a proposed entity reads like a real one. Evidence
 * rows are per-mention; fold them per file so ×N matches the drawer, keeping
 * the first snippet that survives the junk filter.
 */
type TimelineEvidenceRow = EntityReviewEvidenceRow & { relation?: string | null };

function evidenceTimelineGroups(evidence: TimelineEvidenceRow[]): EntityTimelineGroup[] {
  const byFile = new Map<string, EntityTimelineItem>();
  for (const e of evidence) {
    const existing = byFile.get(e.indexed_file_id);
    if (existing) {
      existing.mentionCount += 1;
      if (e.relation && !existing.relations?.includes(e.relation)) existing.relations?.push(e.relation);
      if (!usefulSnippet(existing.contextSnippet, existing.fileName) && e.contextSnippet)
        existing.contextSnippet = e.contextSnippet;
      if (e.seen_at > existing.occurredAt) existing.occurredAt = e.seen_at;
      continue;
    }
    byFile.set(e.indexed_file_id, {
      fileId: e.indexed_file_id,
      fileName: e.file.name,
      fileType: null,
      contentCategory: "document",
      sourceType: e.source,
      occurredAt: e.seen_at,
      mentionConfidence: "EXTRACTED",
      mentionCount: 1,
      contextSnippet: e.contextSnippet ?? null,
      relations: e.relation ? [e.relation] : [],
      url: e.file.providerUrl,
      rollupGroupId: null,
      crmActivity: null,
    });
  }
  const items = [...byFile.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return items.length > 0 ? [{ month: "evidence", items }] : [];
}

/**
 * Expansion source for review evidence rows: quotes of the proposed name cut
 * from the file's indexed chunks — a proposed entity has no mentions table
 * behind it, so the drawer's entity-mentions loader doesn't apply.
 */
function reviewQuotesLoader(reviewId: string) {
  return (item: EntityTimelineItem) => api.entityReview.snippets(reviewId, item.fileId).then((res) => res.quotes);
}

/** Same fold for the candidate side's recent mentions. */
export function mentionTimelineGroups(mentions: EntityMention[]): EntityTimelineGroup[] {
  return evidenceTimelineGroups(
    mentions.map((m) => ({
      id: m.id,
      review_id: "",
      indexed_file_id: m.file.id,
      source: m.file.source,
      note: null,
      seen_at: m.sourceDate,
      contextSnippet: m.contextSnippet,
      relation: m.relation ?? null,
      file: { name: m.file.fileName, providerUrl: m.file.providerUrl, sourcePath: m.file.sourcePath },
    })),
  );
}

/**
 * A small chip naming where a birth row came from: a tracker pull (ClickUp /
 * Linear) or an AI extraction from a connector's documents (Fireflies / Gmail).
 */
function OriginChip({ row }: { row: EntityReviewQueueRow }) {
  const origin = birthOrigin(row);
  if (!origin) return null;
  return (
    <Badge variant="outline" className="gap-1 text-[9px] text-muted-foreground">
      {origin.kind === "ai" ? <SparkleIcon size={9} weight="fill" /> : <PlugsConnectedIcon size={9} />}
      {origin.label}
    </Badge>
  );
}

/** Muted one-liner for the inspect Summary card (mirrors the drawer's activity line). */
function inspectActivityLine(childTaskCount: number, fileCount: number): string {
  const parts: string[] = [];
  if (childTaskCount > 0) parts.push(`${childTaskCount} ${childTaskCount === 1 ? "task" : "tasks"} under it`);
  if (fileCount > 0) parts.push(`${fileCount} linked ${fileCount === 1 ? "file" : "files"}`);
  if (parts.length === 0) return "Not yet in your org.";
  return `${parts.join(" · ")}. Not yet in your org.`;
}

/**
 * Read-only inspect sheet for a birth row, styled to match {@link EntityDrawer}
 * so a proposed entity reads like a real one: accent top-stripe header, avatar,
 * serif name, and `font-mono` section labels in accent-tinted cards. Shows
 * where the proposal came from + the tasks/files behind it, plus the same
 * Confirm / Merge / Dismiss actions. One column — a birth has no candidate to
 * compare against, so the reconcile layout doesn't apply.
 */
export function BirthInspectSheet({
  reviewId,
  onResolved,
  onClose,
}: {
  reviewId: string | null;
  onResolved: () => void;
  onClose: () => void;
}) {
  const { data: detail, isLoading } = useQuery({
    queryKey: reviewId ? detailKey(reviewId) : ["entity-review", "detail", "none"],
    queryFn: () => api.entityReview.get(reviewId as string),
    enabled: !!reviewId,
  });
  const row = detail?.row;
  const evidence: EntityReviewEvidenceRow[] = detail?.evidence ?? [];
  const childTasks: ChildTask[] = detail?.childTasks ?? [];
  const childTaskCount = detail?.childTaskCount ?? 0;

  return (
    <Sheet open={!!reviewId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[720px]">
        <SheetTitle className="sr-only">{row ? `Review: ${row.proposed_name}` : "Review"}</SheetTitle>
        <SheetDescription className="sr-only">
          Inspect where this proposed entity came from and which tasks and files are linked to it.
        </SheetDescription>
        {isLoading ? (
          <div className="space-y-4 p-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !row ? (
          <div className="p-6 text-sm text-muted-foreground">Review row not found.</div>
        ) : (
          <BirthInspectBody
            key={row.id}
            row={row}
            evidence={evidence}
            childTasks={childTasks}
            childTaskCount={childTaskCount}
            onClose={onClose}
            onResolved={() => {
              onResolved();
              onClose();
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function BirthInspectBody({
  row,
  evidence,
  childTasks,
  childTaskCount,
  onClose,
  onResolved,
}: {
  row: EntityReviewQueueRow;
  evidence: EntityReviewEvidenceRow[];
  childTasks: ChildTask[];
  childTaskCount: number;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [mergeOpen, setMergeOpen] = useState(false);
  const [name, setName] = useState(row.proposed_name);
  const mutations = useReviewMutations(row, onResolved);
  const dismissClosesOnly = row.entity_type === "person";
  const origin = birthOrigin(row);
  const trimmedName = name.trim();
  const nameOverride = trimmedName && trimmedName !== row.proposed_name ? trimmedName : undefined;
  const identity = { id: row.id, name: row.proposed_name, sourceType: row.entity_type };
  const accent = entityAccent(identity);

  return (
    <>
      <div
        className="sticky top-0 z-10 border-b bg-background px-6 pb-4 pt-5"
        style={{ borderTopColor: accent, borderTopWidth: 3 }}
      >
        <div className="flex items-start gap-3">
          <EntityAvatar entity={identity} size="lg" />
          <div className="min-w-0 flex-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={mutations.isPending}
              aria-label="Name"
              placeholder="Name"
              className="w-full rounded-sm bg-transparent font-serif text-[20px] leading-tight outline-none placeholder:text-muted-foreground/40 focus:bg-muted/40"
              data-testid="birth-name-input"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                {humanSourceType(row.entity_type)}
              </Badge>
              <OriginChip row={row} />
              <Badge variant="secondary" className="text-[10px]">
                new
              </Badge>
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
        <SectionCard accent={accent} label="Summary">
          <div className="space-y-1 text-sm leading-snug">
            <p>
              New {humanSourceType(row.entity_type).toLowerCase()}
              {origin ? ` from ${origin.label}` : ""}.
            </p>
            <p className="text-muted-foreground">{inspectActivityLine(childTaskCount, evidence.length)}</p>
          </div>
        </SectionCard>

        {childTaskCount > 0 ? (
          <div className="flex flex-col">
            <SectionLabel className="mb-1.5 font-medium">Tasks under this ({childTaskCount})</SectionLabel>
            <EntryList>
              {childTasks.map((t) => (
                <li key={t.indexedFileId}>
                  <div className="flex w-full items-center gap-2 px-3 py-2">
                    <SourceTag>{t.source}</SourceTag>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.name}</span>
                    {t.providerUrl ? (
                      <a
                        href={t.providerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <ArrowSquareOutIcon size={12} />
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
              {childTaskCount > childTasks.length ? (
                <li className="px-3 py-2 text-[10px] text-muted-foreground">
                  + {childTaskCount - childTasks.length} more
                </li>
              ) : null}
            </EntryList>
          </div>
        ) : null}

        {evidence.length > 0 || childTaskCount === 0 ? (
          <div className="flex flex-col">
            <SectionLabel className="mb-1.5 font-medium">Linked files ({evidence.length})</SectionLabel>
            {evidence.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {origin?.kind === "tracker"
                  ? "Pulled from the connector's structure — no document evidence."
                  : "No linked files."}
              </p>
            ) : (
              <TimelineStrip
                groups={evidenceTimelineGroups(evidence)}
                loadQuotes={reviewQuotesLoader(row.id)}
                quotesScope={row.id}
              />
            )}
          </div>
        ) : null}

        {mutations.errorCopy ? <p className="text-xs text-destructive">{mutations.errorCopy.message}</p> : null}
      </div>

      <div className="flex items-center gap-2 border-t bg-background px-6 py-3">
        {isWeeklyPassProjectRow(row) ? (
          <span className="text-[11px] text-muted-foreground">
            Projects are only created by the weekly mint pass — merge, dismiss, or leave it pooling.
          </span>
        ) : (
          <Button
            size="sm"
            onClick={() => mutations.confirm({ nameOverride })}
            disabled={mutations.isPending || trimmedName.length === 0}
            className="h-7 gap-1 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700"
            data-testid="birth-inspect-confirm"
          >
            <CheckIcon size={12} weight="bold" />
            Confirm new
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setMergeOpen(true)}
          disabled={mutations.isPending}
          className="h-7 gap-1 text-[11px]"
          data-testid="birth-inspect-merge"
        >
          <ArrowsLeftRightIcon size={12} />
          Merge
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => (dismissClosesOnly ? onClose() : mutations.dismiss())}
          disabled={mutations.isPending}
          className="ml-auto h-7 gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          data-testid="birth-inspect-dismiss"
        >
          <XIcon size={12} />
          Dismiss
        </Button>
      </div>

      <MergePickerDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        row={row}
        onPick={(entityId) => {
          setMergeOpen(false);
          mutations.mergeInto(entityId);
        }}
      />
    </>
  );
}

/**
 * The birth-row "Merge" escape hatch, on the shared {@link MergeDialog} +
 * {@link MergePreview} surface. Picking does NOT merge — the preview shows
 * the target with the drawer's anatomy first, and only the explicit Merge
 * button calls `onPick`.
 */
function MergePickerDialog({
  open,
  onOpenChange,
  row,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: EntityReviewQueueRow;
  onPick: (entityId: string) => void;
}) {
  return (
    <MergeDialog
      open={open}
      onOpenChange={onOpenChange}
      entityType={row.entity_type}
      title={(picked) =>
        picked ? `Merge "${row.proposed_name}" into ${picked.name}` : `Merge "${row.proposed_name}" into…`
      }
      description={(picked) =>
        picked
          ? "Check this is the right one — the proposed entity and its evidence fold in here."
          : `Pick an existing ${humanSourceType(row.entity_type).toLowerCase()} this is a duplicate of. No new entity is created.`
      }
      renderPreview={(picked, reset) => (
        <MergePreview
          subject={{ kind: "proposal", row }}
          target={picked}
          onBack={reset}
          onMerge={(targetId) => {
            reset();
            onPick(targetId);
          }}
        />
      )}
    />
  );
}

export function ReviewDetailSheet({ reviewId, onClose }: { reviewId: string | null; onClose: () => void }) {
  const { data: detail, isLoading } = useQuery({
    queryKey: reviewId ? detailKey(reviewId) : ["entity-review", "detail", "none"],
    queryFn: () => api.entityReview.get(reviewId as string),
    enabled: !!reviewId,
  });

  const row = detail?.row;
  const evidence: EntityReviewEvidenceRow[] = detail?.evidence ?? [];

  return (
    <Sheet open={!!reviewId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle className="text-base">
            {isLoading ? "Loading..." : row ? `Reconcile: ${row.proposed_name}` : "Review"}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Compare the proposed entity against suggested existing matches, then confirm or reject the reconciliation.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-40 rounded-lg" />
            </div>
          ) : !row ? (
            <p className="text-sm text-muted-foreground">Review row not found.</p>
          ) : (
            <ReconcileBody key={row.id} row={row} evidence={evidence} onClose={onClose} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ReconcileBody({
  row,
  evidence,
  onClose,
}: {
  row: EntityReviewQueueRow;
  evidence: EntityReviewEvidenceRow[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // Initial mode: chooser for orphans (nothing to confirm), candidate otherwise.
  const hasOriginalCandidate = !!row.candidate_entity_id;
  const [mode, setMode] = useState<"candidate" | "chooser">(hasOriginalCandidate ? "candidate" : "chooser");
  // When set, the candidate card previews a picked entity instead of the row's default suggestion.
  const [pickedEntityId, setPickedEntityId] = useState<string | null>(null);

  const mutations = useReviewMutations(row, () => {
    queryClient.invalidateQueries({ queryKey: ["entities"] });
    queryClient.invalidateQueries({ queryKey: ["entity-review"] });
    onClose();
  });

  const activeCandidateId = mode === "candidate" ? (pickedEntityId ?? row.candidate_entity_id ?? null) : null;

  const { data: candidateEntity } = useQuery({
    queryKey: ["entity-detail", activeCandidateId],
    queryFn: () => api.entities.get(activeCandidateId as string),
    enabled: !!activeCandidateId,
  });

  const { data: candidateMentionsData } = useQuery({
    queryKey: ["entity-mentions", activeCandidateId, { limit: 20 }],
    queryFn: () => api.entities.mentions(activeCandidateId as string, { limit: 20 }),
    enabled: !!activeCandidateId,
  });

  const candidate = candidateEntity?.entity ?? null;
  const candidateMentions = candidateMentionsData?.mentions ?? [];
  const isPickedPreview = pickedEntityId !== null;

  return (
    <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-3 md:grid-cols-2">
      <ReconcileColumn
        title="Proposed"
        toneClass="border-amber-400 bg-amber-50/40 dark:border-amber-400/60 dark:bg-amber-950/20"
        name={row.proposed_name}
        typeLabel={humanSourceType(row.entity_type)}
        email={row.proposed_email}
        evidence={evidence}
        reviewId={row.id}
      />
      {mode === "candidate" ? (
        <CandidateView
          row={row}
          candidateEntity={candidate}
          candidateMentions={candidateMentions}
          isPickedPreview={isPickedPreview}
          isPending={mutations.isPending}
          errorMessage={mutations.errorCopy?.message ?? null}
          onConfirm={() => {
            if (pickedEntityId) mutations.mergeInto(pickedEntityId);
            else mutations.confirm();
          }}
          onReject={() => {
            mutations.clearError();
            setMode("chooser");
          }}
        />
      ) : (
        <ChooserView
          row={row}
          suggestedCandidates={row.candidates ?? []}
          isPending={mutations.isPending}
          errorMessage={mutations.errorCopy?.message ?? null}
          canBackToCandidate={hasOriginalCandidate && !isPickedPreview}
          onBack={() => {
            mutations.clearError();
            setMode("candidate");
          }}
          onPick={(entityId) => {
            mutations.clearError();
            setPickedEntityId(entityId);
            setMode("candidate");
          }}
          onCreateNew={() => mutations.reject()}
        />
      )}
    </div>
  );
}

/**
 * The reconcile column shell — eyebrow + name + meta header, optional error
 * strip, scrollable body, optional footer. Shared between the review-queue
 * reconcile sheet and the graph-verdict merge sheet so the two comparison
 * surfaces stay one structure.
 */
export function CompareColumn({
  eyebrow,
  eyebrowClass,
  name,
  meta,
  toneClass = "border-border",
  error,
  children,
  footer,
  testId,
}: {
  eyebrow: string;
  eyebrowClass?: string;
  name: string;
  meta?: ReactNode;
  toneClass?: string;
  error?: string | null;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
}) {
  return (
    <div className={`flex min-h-0 flex-col rounded-lg border ${toneClass}`} data-testid={testId}>
      <div className="border-b border-current/10 px-3 py-2">
        <p className={`text-[10px] font-medium uppercase tracking-wider ${eyebrowClass ?? "text-muted-foreground"}`}>
          {eyebrow}
        </p>
        <p className="mt-0.5 truncate text-sm font-semibold">{name}</p>
        {meta ? <div className="mt-1 flex flex-wrap items-center gap-1.5">{meta}</div> : null}
      </div>
      {error ? <div className="border-b border-border px-3 py-2 text-xs text-destructive">{error}</div> : null}
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2">{children}</div>
      {footer ? <div className="border-t border-border px-3 py-2">{footer}</div> : null}
    </div>
  );
}

function ReconcileColumn({
  title,
  toneClass,
  name,
  typeLabel,
  email,
  evidence,
  reviewId,
}: {
  title: string;
  toneClass: string;
  name: string;
  typeLabel: string;
  email: string | null;
  evidence: EntityReviewEvidenceRow[];
  reviewId: string;
}) {
  return (
    <CompareColumn
      eyebrow={title}
      name={name}
      toneClass={toneClass}
      testId="reconcile-proposed"
      meta={
        <>
          <Badge variant="outline" className="text-[10px]">
            {typeLabel}
          </Badge>
          {email ? <span className="text-[11px] text-muted-foreground">{email}</span> : null}
        </>
      }
    >
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Evidence ({evidence.length})
      </p>
      {evidence.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">No evidence rows.</p>
      ) : (
        <div className="mt-1 flex-1 overflow-y-auto">
          <TimelineStrip
            groups={evidenceTimelineGroups(evidence)}
            loadQuotes={reviewQuotesLoader(reviewId)}
            quotesScope={reviewId}
          />
        </div>
      )}
    </CompareColumn>
  );
}

/**
 * Right column when the reconcile body is showing a candidate (the original
 * suggestion OR a picked one). Header carries the candidate name + ✓/✗
 * icon-buttons; body shows recent mentions.
 *
 * When `isPickedPreview` is true the column is tinted emerald and the title
 * reads "PICKED — CONFIRM TO MERGE" so the user knows the ✓ will merge into
 * the picked target instead of the row's original suggestion.
 */
function CandidateView({
  row,
  candidateEntity,
  candidateMentions,
  isPickedPreview,
  isPending,
  errorMessage,
  onConfirm,
  onReject,
}: {
  row: EntityReviewQueueRow;
  candidateEntity: EntityListItem | null;
  candidateMentions: EntityMention[];
  isPickedPreview: boolean;
  isPending: boolean;
  errorMessage: string | null;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const sectionTitle = isPickedPreview ? "Picked — confirm to merge" : "Suggested existing";
  const email = entityEmail(candidateEntity) ?? (isPickedPreview ? null : row.candidate?.email);
  return (
    <CompareColumn
      testId="reconcile-candidate"
      toneClass={`bg-muted/20 ${isPickedPreview ? "border-emerald-400 dark:border-emerald-600" : "border-border"}`}
      eyebrow={sectionTitle}
      eyebrowClass={isPickedPreview ? "text-emerald-700 dark:text-emerald-400" : undefined}
      name={candidateEntity?.name ?? row.candidate?.name ?? "…"}
      error={errorMessage}
      meta={
        <>
          {candidateEntity ? (
            <Badge variant="outline" className="text-[10px]">
              {humanSourceType(candidateEntity.sourceType)}
            </Badge>
          ) : null}
          {email ? <span className="text-[11px] text-muted-foreground">{email}</span> : null}
          {row.candidate_reason && !isPickedPreview ? (
            <span className="text-[11px] text-muted-foreground">· {row.candidate_reason}</span>
          ) : null}
        </>
      }
      footer={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={isPending}
            data-testid="confirm-merge"
            className="h-7 gap-1 bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600"
          >
            <CheckIcon size={12} weight="bold" />
            Merge into {candidateEntity?.name ?? row.candidate?.name ?? "this"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onReject}
            disabled={isPending}
            data-testid="reject-match"
            className="h-7"
          >
            Not a match
          </Button>
        </div>
      }
    >
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Recent mentions ({candidateMentions.length})
      </p>
      {candidateMentions.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">No mentions yet.</p>
      ) : (
        <div className="mt-1 flex-1 overflow-y-auto">
          <TimelineStrip groups={mentionTimelineGroups(candidateMentions)} entityId={candidateEntity?.id} />
        </div>
      )}
    </CompareColumn>
  );
}

/**
 * Right column when the reconcile body is in chooser mode — either because
 * the row is an orphan (no original candidate) or the user clicked ✗ on a
 * candidate. Shows a search box for picking an existing entity + a
 * "Create as new" fallback button.
 *
 * When the row HAS an original candidate to return to, a back arrow next
 * to the title brings the user back to the candidate view.
 */
function ChooserView({
  row,
  suggestedCandidates,
  isPending,
  errorMessage,
  canBackToCandidate,
  onBack,
  onPick,
  onCreateNew,
}: {
  row: EntityReviewQueueRow;
  suggestedCandidates: Array<{ id: string; name: string; email: string | null }>;
  isPending: boolean;
  errorMessage: string | null;
  canBackToCandidate: boolean;
  onBack: () => void;
  onPick: (entityId: string) => void;
  onCreateNew: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-border" data-testid="reconcile-candidate">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {canBackToCandidate ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to suggested candidate"
            className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowLeftIcon size={14} />
          </button>
        ) : null}
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">What instead?</p>
      </div>
      {errorMessage ? (
        <div className="border-b border-border px-3 py-2 text-xs text-destructive">{errorMessage}</div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-3">
        {suggestedCandidates.length > 0 ? (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Possible matches</p>
            <div className="mt-2 space-y-1.5">
              {suggestedCandidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => onPick(candidate.id)}
                  className="flex w-full items-center justify-between rounded-md border border-border px-2.5 py-2 text-left hover:bg-muted"
                  data-testid={`suggested-candidate-${candidate.id}`}
                >
                  <span className="truncate text-sm font-medium">{candidate.name}</span>
                  {candidate.email ? (
                    <span className="ml-2 truncate text-[11px] text-muted-foreground">{candidate.email}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Search for a match</p>
          <div className="mt-2">
            <EntityPicker
              entityType={row.entity_type}
              excludeEntityId={row.candidate_entity_id ?? undefined}
              onPick={onPick}
            />
          </div>
        </div>
        {isWeeklyPassProjectRow(row) ? (
          <p className="text-[11px] text-muted-foreground">
            Projects are only created by the weekly mint pass — link or merge into an existing one, or leave it pooling.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onCreateNew}
              disabled={isPending}
              className="gap-1.5"
              data-testid="create-new"
            >
              <PlusIcon size={14} />
              Create as new {row.entity_type}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
