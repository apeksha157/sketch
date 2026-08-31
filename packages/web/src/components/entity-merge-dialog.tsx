import { SectionLabel } from "@/components/entity-drawer/drawer-kit";
/**
 * The one merge surface. Every entity-to-entity combination in the app goes
 * through {@link MergeDialog} (pick the other side) + {@link MergePreview}
 * (look before committing): the drawer dialog, the WhatsApp identity review,
 * and the review sheets' "merge into existing" escape hatch.
 *
 * The preview always shows the picked target with the entity drawer's header
 * anatomy and recent timeline. When BOTH sides are real entities it adds the
 * survivor toggle and the dry-run counts; when the subject is a proposed
 * review row (not an entity yet) the target always survives and the caller
 * owns the commit mutation.
 */
import { TimelineStrip } from "@/components/entity-drawer/timeline-strip";
import { humanSourceType } from "@/components/entity-review/entity-format";
import { GRAPH_VERDICT_ACTION_LABELS } from "@/components/graph-verdict-sheet";
import {
  type EntityListItem,
  type EntityMergePreview,
  type EntityMergeRecord,
  type EntityReviewQueueRow,
  type GraphVerdict,
  api,
} from "@/lib/api";
import { ApiRequestError } from "@/lib/api";
import { EntityAvatar, displayAliases, entityAccent } from "@/lib/entity-ui";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Fragment, useState } from "react";
import { EntityPicker } from "./entity-picker";

/** What is being folded into the picked target. */
export type MergeSubject =
  | { kind: "entity"; id: string; name: string }
  | { kind: "proposal"; row: EntityReviewQueueRow };

function mergesKey(entityId: string): unknown[] {
  return ["entity-merge", "history", entityId];
}

function invalidateEntitySurfaces(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: ["entity-drawer"] });
  queryClient.invalidateQueries({ queryKey: ["entities"] });
  queryClient.invalidateQueries({ queryKey: ["entity-graph"] });
}

function verdictTouches(verdict: GraphVerdict, entityId: string): boolean {
  return (
    verdict.subjectEntityId === entityId ||
    verdict.targetEntityId === entityId ||
    verdict.resolvedTargetEntityId === entityId
  );
}

/**
 * The shared two-step merge dialog shell: step one is the {@link EntityPicker},
 * step two is whatever `renderPreview` returns for the picked entity (always a
 * {@link MergePreview} in practice). Title and description get the picked
 * entity so they can change between steps.
 */
export function MergeDialog({
  open,
  onOpenChange,
  entityType,
  excludeEntityId,
  initialPickId,
  pickerPlaceholder,
  title,
  description,
  notice,
  below,
  renderPreview,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: string;
  excludeEntityId?: string;
  /**
   * Skip the picker and open straight on this entity's preview (a suggestion
   * the caller already trusts enough to show). Back still returns to the
   * picker so the human can choose someone else.
   */
  initialPickId?: string | null;
  pickerPlaceholder?: string;
  title: (picked: EntityListItem | null) => ReactNode;
  description: (picked: EntityListItem | null) => ReactNode;
  notice?: ReactNode;
  below?: ReactNode;
  renderPreview: (picked: EntityListItem, reset: () => void) => ReactNode;
}) {
  const [picked, setPicked] = useState<EntityListItem | null>(null);
  const [seedCleared, setSeedCleared] = useState(false);
  const seedActive = Boolean(initialPickId) && !picked && !seedCleared;
  const seedQuery = useQuery({
    queryKey: ["entities", "detail", initialPickId],
    queryFn: () => api.entities.get(initialPickId as string),
    enabled: open && seedActive,
  });
  const effective = picked ?? (seedActive ? (seedQuery.data?.entity ?? null) : null);
  const reset = () => {
    setPicked(null);
    setSeedCleared(true);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPicked(null);
          setSeedCleared(false);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{title(effective)}</DialogTitle>
          <DialogDescription>{description(effective)}</DialogDescription>
        </DialogHeader>
        {notice}
        {effective ? (
          <Fragment key={effective.id}>{renderPreview(effective, reset)}</Fragment>
        ) : seedActive ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="py-1">
            <EntityPicker
              entityType={entityType}
              excludeEntityId={excludeEntityId}
              placeholder={pickerPlaceholder}
              onPick={(_, entity) => setPicked(entity)}
            />
          </div>
        )}
        {below}
      </DialogContent>
    </Dialog>
  );
}

interface EntityMergeDialogProps {
  entityId: string;
  entityName: string;
  sourceType: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged?: (survivorId: string) => void;
}

/** The entity drawer's merge entry point: generic dedup of two same-type entities. */
export function EntityMergeDialog({
  entityId,
  entityName,
  sourceType,
  open,
  onOpenChange,
  onMerged,
}: EntityMergeDialogProps) {
  /**
   * Cross-pipeline guard: if an open agent proposal already touches this
   * entity, say so before the human merges by hand — otherwise one of the
   * two races the other and the loser only finds out via a stale banner at
   * apply time. Non-blocking; the dialog is admin-only so the fetch is safe.
   */
  const openVerdictsQuery = useQuery({
    queryKey: ["graph-verdicts", "open"],
    queryFn: () => api.graphVerdicts.listOpen(),
    enabled: open,
    retry: false,
  });
  const overlapping = (openVerdictsQuery.data?.verdicts ?? []).filter((verdict) => verdictTouches(verdict, entityId));

  return (
    <MergeDialog
      open={open}
      onOpenChange={onOpenChange}
      entityType={sourceType}
      excludeEntityId={entityId}
      pickerPlaceholder={`Find the other ${sourceType}…`}
      title={() => `Merge ${entityName}`}
      description={() =>
        `Combine two ${sourceType}s that are the same. Everything from the merged-in side moves onto the survivor; you can undo it afterward.`
      }
      notice={
        overlapping.length > 0 ? (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
            data-testid="merge-agent-overlap"
          >
            {overlapping.map((verdict) => (
              <p key={verdict.id}>
                An open agent proposal already covers this entity (
                {GRAPH_VERDICT_ACTION_LABELS[verdict.action] ?? verdict.action}
                {verdict.targetName ? ` → ${verdict.targetName}` : ""}). Review it in Your Org before merging by hand —
                whichever runs second goes stale.
              </p>
            ))}
          </div>
        ) : null
      }
      below={<MergeHistory entityId={entityId} />}
      renderPreview={(picked, reset) => (
        <MergePreview
          subject={{ kind: "entity", id: entityId, name: entityName }}
          target={picked}
          onBack={reset}
          onMerged={(survivorId) => {
            reset();
            onOpenChange(false);
            onMerged?.(survivorId);
          }}
        />
      )}
    />
  );
}

function movesTotal(counts: EntityMergePreview["counts"]): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

function collisionsTotal(collisions: EntityMergePreview["collisions"]): number {
  return Object.values(collisions).reduce((a, b) => a + b, 0);
}

/**
 * The look-before-merge card: the target rendered with the entity drawer's
 * header anatomy and its recent timeline, so a bare name like "Rahul" is
 * checkable against real activity before anything commits.
 */
function MergeTargetCard({ target }: { target: EntityListItem }) {
  const timelineQuery = useQuery({
    queryKey: ["entity-drawer", "timeline", target.id],
    queryFn: () => api.entities.timeline(target.id),
  });
  const recentItems = (timelineQuery.data?.groups ?? []).flatMap((group) => group.items).slice(0, 6);
  const email =
    (target.contactPoints ?? []).find((point) => point.kind === "email" && point.isPrimary)?.value ??
    (target.contactPoints ?? []).find((point) => point.kind === "email")?.value;
  const aka = displayAliases(target.aliases ?? [], [target.name, email]);
  const accent = entityAccent({ id: target.id, name: target.name, sourceType: target.sourceType });

  return (
    <div
      className="min-w-0 overflow-hidden rounded-lg border bg-muted/20"
      style={{ borderTopColor: accent, borderTopWidth: 3 }}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <EntityAvatar entity={{ id: target.id, name: target.name, sourceType: target.sourceType }} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-serif text-[18px] leading-tight">{target.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {humanSourceType(target.sourceType)}
            </Badge>
            {email ? <span className="font-mono text-[11px] text-muted-foreground">{email}</span> : null}
            {target.mentionCount > 0 ? (
              <span className="text-[11px] text-muted-foreground">
                {target.mentionCount} {target.mentionCount === 1 ? "mention" : "mentions"}
              </span>
            ) : null}
          </div>
          {aka.length > 0 ? (
            <p className="mt-1 truncate text-[11px] text-muted-foreground">aka {aka.slice(0, 4).join(", ")}</p>
          ) : null}
        </div>
      </div>
      <div className="max-h-56 overflow-y-auto border-t px-4 py-3">
        {timelineQuery.isLoading ? (
          <p className="text-[11px] text-muted-foreground">Loading recent activity…</p>
        ) : recentItems.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No recent activity.</p>
        ) : (
          <TimelineStrip groups={[{ month: "recent", items: recentItems }]} entityId={target.id} />
        )}
      </div>
    </div>
  );
}

/**
 * The one merge preview. Entity subjects get the survivor toggle, direction
 * line, and dry-run counts, and this component commits the merge itself
 * (`onMerged` fires with the survivor id). Proposal subjects (review rows)
 * always fold into the target — `onMerge` fires with the target id and the
 * caller runs its own mutation.
 */
export function MergePreview({
  subject,
  target,
  defaultSurvivor = "subject",
  onBack,
  onMerged,
  onMerge,
}: {
  subject: MergeSubject;
  target: EntityListItem;
  defaultSurvivor?: "subject" | "target";
  onBack: () => void;
  onMerged?: (survivorId: string) => void;
  onMerge?: (targetId: string) => void;
}) {
  const queryClient = useQueryClient();
  const subjectId = subject.kind === "entity" ? subject.id : null;
  const subjectName = subject.kind === "entity" ? subject.name : subject.row.proposed_name;
  const [survivorId, setSurvivorId] = useState(
    subjectId === null || defaultSurvivor === "target" ? target.id : subjectId,
  );
  const loserId = survivorId === subjectId ? target.id : subjectId;

  const previewQuery = useQuery({
    queryKey: ["entity-merge", "preview", survivorId, loserId],
    queryFn: () => api.entities.previewMerge(survivorId, loserId as string),
    enabled: loserId !== null,
  });

  const mergeMutation = useMutation({
    mutationFn: () => api.entities.merge(survivorId, loserId as string),
    onSuccess: () => {
      invalidateEntitySurfaces(queryClient);
      if (subjectId) queryClient.invalidateQueries({ queryKey: mergesKey(subjectId) });
      onMerged?.(survivorId);
    },
  });

  const sides: { id: string; name: string }[] = subjectId
    ? [
        { id: subjectId, name: subjectName },
        { id: target.id, name: target.name },
      ]
    : [];

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3" data-testid="merge-target-preview">
      <MergeTargetCard target={target} />

      {subject.kind === "entity" ? (
        <>
          <div>
            <SectionLabel className="mb-1.5">Keep as survivor</SectionLabel>
            <div className="inline-flex w-full rounded-lg border-[0.5px] border-border bg-card p-0.5">
              {sides.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSurvivorId(s.id)}
                  className={cn(
                    "flex-1 truncate rounded-md px-3 py-1.5 text-xs transition-colors",
                    survivorId === s.id
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s.name}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="merge-direction">
              <ArrowsLeftRightIcon className="mr-1 inline h-3 w-3" />
              Merging <span className="font-medium">{sides.find((s) => s.id === loserId)?.name}</span> into{" "}
              <span className="font-medium">{sides.find((s) => s.id === survivorId)?.name}</span>.
            </p>
          </div>

          {previewQuery.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : previewQuery.data?.blocked ? (
            <p className="rounded-md border border-amber-300/50 bg-amber-50/40 p-2 text-xs text-amber-700 dark:bg-amber-950/20 dark:text-amber-500">
              These can't be merged ({previewQuery.data.blocked.toLowerCase().replace(/_/g, " ")}).
            </p>
          ) : previewQuery.data ? (
            <div className="rounded-lg border p-3 text-xs">
              <p className="mb-2" data-testid="merge-summary">
                <span className="font-medium">{movesTotal(previewQuery.data.counts)}</span> records move onto the
                survivor
                {collisionsTotal(previewQuery.data.collisions) > 0 ? (
                  <>
                    {" · "}
                    <span className="text-muted-foreground">
                      {collisionsTotal(previewQuery.data.collisions)} duplicates will be combined
                    </span>
                  </>
                ) : null}
                {previewQuery.data.selfLoopsDropped > 0 ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {previewQuery.data.selfLoopsDropped} self-links dropped
                  </span>
                ) : null}
              </p>
              <div className="flex flex-wrap gap-1">
                <CountBadge label="mentions" n={previewQuery.data.counts.mentions} />
                <CountBadge label="relationships" n={previewQuery.data.counts.relationships} />
                <CountBadge label="sources" n={previewQuery.data.counts.sourceRefs} />
                <CountBadge label="contacts" n={previewQuery.data.counts.contactPoints} />
                <CountBadge label="domains" n={previewQuery.data.counts.domains} />
              </div>
            </div>
          ) : null}

          {mergeMutation.isError ? (
            <p className="text-[11px] text-destructive">{mergeErrorMessage(mergeMutation.error)}</p>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onBack}>
              Back
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={mergeMutation.isPending || previewQuery.isLoading || Boolean(previewQuery.data?.blocked)}
              onClick={() => mergeMutation.mutate()}
            >
              Confirm merge
            </Button>
          </DialogFooter>
        </>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">
            "{subjectName}"
            {subject.row.evidenceCount > 0
              ? ` and its ${subject.row.evidenceCount} linked ${subject.row.evidenceCount === 1 ? "file" : "files"}`
              : ""}{" "}
            fold into this {humanSourceType(target.sourceType).toLowerCase()}.
          </p>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onBack}>
              Back
            </Button>
            <Button type="button" size="sm" onClick={() => onMerge?.(target.id)} data-testid="merge-target-confirm">
              <ArrowsLeftRightIcon size={12} />
              Merge into {target.name}
            </Button>
          </DialogFooter>
        </>
      )}
    </div>
  );
}

function CountBadge({ label, n }: { label: string; n: number }) {
  if (n === 0) return null;
  return (
    <Badge variant="outline" className="text-[10px] tabular-nums">
      {n} {label}
    </Badge>
  );
}

function MergeHistory({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const historyQuery = useQuery({
    queryKey: mergesKey(entityId),
    queryFn: () => api.entities.listMerges(entityId),
  });
  const unmergeMutation = useMutation({
    mutationFn: (mergeId: string) => api.entities.unmerge(mergeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mergesKey(entityId) });
      invalidateEntitySurfaces(queryClient);
    },
  });

  const merges = historyQuery.data?.merges ?? [];
  if (merges.length === 0) return null;

  return (
    <div className="border-t pt-3">
      <SectionLabel className="mb-2">Merge history</SectionLabel>
      <div className="flex flex-col">
        {merges.map((m) => (
          <MergeHistoryRow
            key={m.id}
            record={m}
            pending={unmergeMutation.isPending}
            onUnmerge={() => unmergeMutation.mutate(m.id)}
          />
        ))}
      </div>
    </div>
  );
}

function MergeHistoryRow({
  record,
  pending,
  onUnmerge,
}: {
  record: EntityMergeRecord;
  pending: boolean;
  onUnmerge: () => void;
}) {
  const undone = Boolean(record.unmerged_at);
  return (
    <div className="flex items-center justify-between gap-2 border-b py-2 text-xs last:border-b-0">
      <span className={cn("min-w-0 flex-1 truncate", undone && "text-muted-foreground line-through")}>
        Merged {record.merged_entity_id.slice(0, 8)} → {record.survivor_entity_id.slice(0, 8)}
      </span>
      {undone ? (
        <Badge variant="secondary" className="text-[9px] uppercase tracking-wider">
          Unmerged
        </Badge>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground"
          disabled={pending}
          onClick={onUnmerge}
        >
          Unmerge
        </Button>
      )}
    </div>
  );
}

function mergeErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === "TYPE_MISMATCH") return "Those two entities are different types.";
    if (err.code === "SELF_MERGE") return "Pick a different entity to merge.";
    if (err.code === "ALREADY_MERGED") return "One of these has already been merged.";
    return err.message;
  }
  return "Something went wrong. Please try again.";
}
