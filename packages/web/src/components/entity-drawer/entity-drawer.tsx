/**
 * EntityDrawer — the universal provenance/audit surface for one entity.
 *
 * Layout:
 *   1. Header — name + type badge + identity chips (domains / email+role /
 *      aliases) inline; last seen right-aligned.
 *   2. Summary block — Gemini narrative + up to 3 top learned-fact bullets.
 *      Falls back to the deterministic WHAT line when the brief is cold and
 *      there are no facts yet.
 *   3. Tabs — Timeline (default) | Relationships | Tasks (projects only) | Scope (projects only).
 *
 * Driven by EntityUiProvider's stack. Each level renders independently —
 * pushing a related entity pushes a new id onto the stack; Back chip pops.
 */
import { EntityMergeDialog } from "@/components/entity-merge-dialog";
import { EntityShareDialog } from "@/components/entity-share-dialog";
import type {
  EntityContactPoint,
  EntityContactPointKind,
  EntityDetail,
  EntityRelationEvidenceRow,
  EntityRelationView,
  EntityRelationsResponse,
  EntityTask,
  TaskStatus,
} from "@/lib/api";
import { api } from "@/lib/api";
import {
  EntityAvatar,
  EntityChip,
  displayAliases,
  entityAccent,
  entityDisplayLabel,
  useEntityUi,
} from "@/lib/entity-ui";
import { formatRelativeTime } from "@/lib/time";
import {
  ArrowLeftIcon,
  ArrowsLeftRightIcon,
  CheckIcon,
  DotsThreeIcon,
  GlobeIcon,
  PencilSimpleIcon,
  PlusIcon,
  ShareNetworkIcon,
  SpinnerGapIcon,
  TrashIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sketch/ui/components/alert-dialog";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { Input } from "@sketch/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { SectionCard, SectionLabel } from "./drawer-kit";
import { RelationshipsPanel } from "./relationships-panel";
import { ScopePanel } from "./scope-panel";
import { TimelineStrip } from "./timeline-strip";

const TASK_STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "dropped", label: "Dropped" },
];

export function EntityDrawer() {
  const ui = useEntityUi();
  const open = ui.stack.length > 0 && ui.mode === "drawer";
  const currentId = ui.stack[ui.stack.length - 1];
  const previousName = useDrawerPreviousName(ui.stack);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) ui.closeAll();
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[720px]">
        <SheetTitle className="sr-only">Entity drawer</SheetTitle>
        <SheetDescription className="sr-only">
          Provenance and audit view for the selected entity, with identity flags, summary, timeline, and relationships.
        </SheetDescription>
        {currentId ? (
          <EntityDrawerBody
            key={currentId}
            entityId={currentId}
            stackDepth={ui.stack.length}
            previousName={previousName}
            onBack={ui.popEntity}
            onOpenEntity={ui.openEntity}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function useDrawerPreviousName(stack: string[]): string | null {
  const prevId = stack.length > 1 ? stack[stack.length - 2] : null;
  const { data } = useQuery({
    queryKey: ["entity-drawer", "header-name", prevId],
    queryFn: () => api.entities.get(prevId as string),
    enabled: !!prevId,
  });
  return data?.entity.name ?? null;
}

interface EntityDrawerBodyProps {
  entityId: string;
  stackDepth: number;
  previousName: string | null;
  onBack: () => void;
  onOpenEntity: (id: string) => void;
}

function EntityDrawerBody({ entityId, stackDepth, previousName, onBack, onOpenEntity }: EntityDrawerBodyProps) {
  const sessionQuery = useQuery({
    queryKey: ["auth-session"],
    queryFn: () => api.auth.session(),
    staleTime: 60_000,
  });
  const profileQuery = useQuery({
    queryKey: ["entity-drawer", "profile", entityId],
    queryFn: () => api.entities.get(entityId),
  });
  const relationsQuery = useQuery({
    queryKey: ["entity-drawer", "relations", entityId],
    queryFn: () => api.entities.relations(entityId),
    enabled: !!profileQuery.data,
  });

  if (profileQuery.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (!profileQuery.data) {
    return <div className="p-6 text-sm text-muted-foreground">Entity not found.</div>;
  }

  const { entity } = profileQuery.data;
  const isAdmin = sessionQuery.data?.role === "admin";
  const accent = entityAccent({ id: entity.id, name: entity.name, sourceType: entity.sourceType });

  return (
    <>
      <DrawerHeader
        entity={entity}
        stackDepth={stackDepth}
        previousName={previousName}
        onBack={onBack}
        accent={accent}
        onOpenEntity={onOpenEntity}
        isAdmin={isAdmin}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <IdentitySection entity={entity} isAdmin={isAdmin} />
        <SummaryBlock entity={entity} accent={accent} />
        <DrawerTabs
          entityId={entity.id}
          sourceType={entity.sourceType}
          relations={relationsQuery.data}
          relationsLoading={relationsQuery.isLoading}
          isAdmin={isAdmin}
        />
      </div>
    </>
  );
}

interface DrawerHeaderProps {
  entity: EntityDetail;
  stackDepth: number;
  previousName: string | null;
  onBack: () => void;
  accent: string;
  onOpenEntity: (id: string) => void;
  isAdmin: boolean;
}

function DrawerHeader({ entity, stackDepth, previousName, onBack, accent, onOpenEntity, isAdmin }: DrawerHeaderProps) {
  const lastSeen = entity.profile.lastSeenAt;
  const [shareOpen, setShareOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div
      className="sticky top-0 z-10 border-b bg-background px-6 pb-4 pt-5"
      style={{ borderTopColor: accent, borderTopWidth: 3 }}
    >
      {stackDepth > 1 && previousName ? (
        <button
          type="button"
          onClick={onBack}
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          <span>Back to {previousName}</span>
        </button>
      ) : null}
      <div className="flex items-start gap-3">
        <EntityAvatar entity={entity} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 flex-1 truncate font-serif text-[20px] leading-tight">
              {entityDisplayLabel(entity)}
            </h2>
            <div className="flex shrink-0 items-center gap-2">
              {entity.shareWithEveryone ? (
                <Badge variant="outline" className="gap-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <GlobeIcon size={10} />
                  Anyone in org
                </Badge>
              ) : null}
              {lastSeen ? (
                <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Last seen {formatRelativeTime(lastSeen)}
                </span>
              ) : null}
              {isAdmin ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" className="h-7 w-7 p-0" aria-label="Entity actions">
                      <DotsThreeIcon size={14} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setMergeOpen(true)}>
                      <ArrowsLeftRightIcon size={12} />
                      Merge…
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setShareOpen(true)}>
                      <ShareNetworkIcon size={12} />
                      Share…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <TrashIcon size={12} />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {entity.profile.entityType}
            </Badge>
            <IdentityChips entity={entity} />
            {entity.status !== "confirmed" ? (
              <Badge variant="secondary" className="text-[10px]">
                {entity.status}
              </Badge>
            ) : null}
            {(entity.manualShares?.length ?? 0) > 0 ? (
              <Badge variant="secondary" className="text-[10px]">
                Shared with {entity.manualShares?.length ?? 0}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>
      {isAdmin ? (
        <>
          <EntityShareDialog
            entityId={entity.id}
            entityName={entity.name}
            open={shareOpen}
            onOpenChange={setShareOpen}
          />
          <EntityMergeDialog
            entityId={entity.id}
            entityName={entity.name}
            sourceType={entity.sourceType}
            open={mergeOpen}
            onOpenChange={setMergeOpen}
            onMerged={(survivorId) => {
              if (survivorId !== entity.id) onOpenEntity(survivorId);
            }}
          />
          <DeleteEntityDialog
            entityId={entity.id}
            entityName={entity.name}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * Admin-only soft delete. The entity is tombstoned server-side (hidden from the
 * graph, recoverable by an admin) and its name is suppressed so the LLM
 * enrichment paths don't re-mint it. On success the drawer closes and every
 * surface that could still show the entity is invalidated.
 */
function DeleteEntityDialog({
  entityId,
  entityName,
  open,
  onOpenChange,
}: {
  entityId: string;
  entityName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ui = useEntityUi();
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: () => api.entities.remove(entityId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entity-drawer"] });
      queryClient.invalidateQueries({ queryKey: ["entities"] });
      queryClient.invalidateQueries({ queryKey: ["entity-graph"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`${entityName} deleted`);
      onOpenChange(false);
      ui.closeAll();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {entityName}?</AlertDialogTitle>
          <AlertDialogDescription>
            It will be hidden from the graph and won't be recreated automatically. An admin can restore it later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              deleteMutation.mutate();
            }}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Deleting…
              </>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Identity flags rendered inline in the header. Person → email + role.
 * Company/product → domains (primary first). Aliases moved out of the header
 * into {@link AliasStrip} — the raw list was junk-prone and unmanageable here.
 */
function IdentityChips({ entity }: { entity: EntityDetail }) {
  const meta = entity.metadata ?? {};
  const role = typeof meta.role === "string" ? meta.role : null;
  const domains = entity.profile.domainsForCompany;

  return (
    <>
      {role ? (
        <Badge variant="outline" className="text-[10px]">
          {role}
        </Badge>
      ) : null}
      {domains.map((d) => (
        <Badge
          key={d.domain}
          variant={d.isPrimary ? "secondary" : "outline"}
          className="font-mono text-[10px] normal-case tracking-normal"
        >
          {d.domain}
          {d.isPrimary ? " · primary" : null}
        </Badge>
      ))}
    </>
  );
}

/**
 * One registry entry per identity-handle kind the section can edit. A future
 * kind (github, slack handle…) is a new row here plus its backend support —
 * no new UI. `name` rows live in the aliases blob; the rest are contact
 * points, which only person entities carry.
 */
const IDENTITY_KINDS = [
  { kind: "email", label: "Email", placeholder: "name@example.com", personOnly: true, hasPrimary: true },
  { kind: "phone", label: "Phone", placeholder: "+14155550123", personOnly: true, hasPrimary: true },
  { kind: "name", label: "Name", placeholder: "Another name this goes by", personOnly: false, hasPrimary: false },
] as const;

type IdentityKind = (typeof IDENTITY_KINDS)[number]["kind"];

function localContactValue(kind: EntityContactPointKind, value: string): string {
  const trimmed = value.trim();
  return kind === "email" ? trimmed.toLowerCase() : trimmed.replace(/[\s()-]/g, "");
}

interface IdentityForm {
  kind: IdentityKind;
  value: string;
  isPrimary: boolean;
  originalAlias?: string;
  originalPoint?: EntityContactPoint;
}

/**
 * The chip-shaped alias editor — an editing or brand-new name renders as a
 * chip among the other chips, so the wall never reflows around a bulky form.
 * Enter saves, Escape cancels.
 */
function AliasChipEditor({
  form,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  form: IdentityForm;
  pending: boolean;
  onChange: (form: IdentityForm) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const subject = form.originalAlias ?? "new name";
  return (
    <form
      className="inline-flex items-center gap-1 rounded-full border border-foreground/40 px-2 py-0.5 text-[11px]"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: the editor only appears on an explicit edit/add click, so focus belongs in it
        autoFocus
        value={form.value}
        onChange={(event) => onChange({ ...form, value: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        placeholder="New name"
        style={{ width: `${Math.max(9, form.value.length)}ch` }}
        className="max-w-56 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
        aria-label={form.originalAlias ? `New value for ${form.originalAlias}` : "New name"}
        required
      />
      <button
        type="submit"
        aria-label={`Save ${subject}`}
        className="text-muted-foreground hover:text-foreground"
        disabled={pending}
      >
        <CheckIcon size={12} />
      </button>
      <button
        type="button"
        aria-label={`Cancel ${subject}`}
        className="text-muted-foreground hover:text-foreground"
        onClick={onCancel}
      >
        <XIcon size={12} />
      </button>
    </form>
  );
}

/**
 * The row-shaped identity editor for contact points, rendered in place of
 * the row being edited (or appended when adding) so the journey never jumps
 * away from the value it concerns. Enter saves, Escape cancels.
 */
function IdentityRowForm({
  form,
  def,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  form: IdentityForm;
  def: (typeof IDENTITY_KINDS)[number];
  pending: boolean;
  onChange: (form: IdentityForm) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-md border bg-background p-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <span className="w-11 text-[10px] font-semibold uppercase text-muted-foreground">
        {form.kind === "name" ? "name" : form.kind}
      </span>
      <Input
        autoFocus
        value={form.value}
        onChange={(event) => onChange({ ...form, value: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        className={cn("h-7 min-w-48 flex-1 text-xs", form.kind !== "name" && "font-mono")}
        placeholder={def.placeholder}
        aria-label={
          form.originalAlias || form.originalPoint
            ? `New value for ${form.originalAlias ?? form.originalPoint?.value}`
            : `New ${def.label.toLowerCase()}`
        }
        required
      />
      {def.hasPrimary ? (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={form.isPrimary}
            onChange={(event) => onChange({ ...form, isPrimary: event.target.checked })}
            className="size-3.5 accent-foreground"
          />
          Primary
        </label>
      ) : null}
      <Button type="submit" size="sm" className="h-7 text-[11px]" disabled={pending}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-7 text-[11px]" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/**
 * The one card for every way this entity is identified — contact points
 * (email/phone) and name aliases together. Reading stays quiet: mono value
 * lines plus a single "aka" line, no edit chrome. All CRUD sits behind the
 * explicit Edit toggle, where the rows unify two stores: alias writes go to
 * the alias API (delete records a rejection so the pipeline can't re-mint
 * the name; add declares human-confirmed provenance; edit is
 * remove-then-add), contact writes go to the contact-point API.
 */
function IdentitySection({ entity, isAdmin }: { entity: EntityDetail; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const isPerson = entity.sourceType === "person";
  const points = isPerson
    ? (entity.contactPoints ?? []).filter((point) => point.kind === "email" || point.kind === "phone")
    : [];
  const sortedPoints = [...points].sort((a, b) =>
    a.kind === b.kind ? Number(b.isPrimary) - Number(a.isPrimary) : a.kind === "email" ? -1 : 1,
  );
  const aliases = displayAliases(entity.aliases, [
    entity.name,
    ...(entity.contactPoints ?? []).map((point) => point.value),
    ...entity.profile.domainsForCompany.map((d) => d.domain),
  ]);
  const kinds = IDENTITY_KINDS.filter((def) => isPerson || !def.personOnly);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<IdentityForm | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["entity-drawer", "profile", entity.id] });
    void queryClient.invalidateQueries({ queryKey: ["entities"] });
    setForm(null);
  };
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!form) return;
      if (form.kind === "name") {
        const next = form.value.trim();
        if (!next) throw new Error("Alias is required");
        if (form.originalAlias && form.originalAlias !== next) {
          await api.entities.removeAlias(entity.id, form.originalAlias);
        }
        if (form.originalAlias !== next) await api.entities.addAlias(entity.id, next);
        return;
      }
      const normalized = localContactValue(form.kind, form.value);
      const duplicate = points.some(
        (point) =>
          point.id !== form.originalPoint?.id &&
          point.kind === form.kind &&
          localContactValue(form.kind, point.value) === normalized,
      );
      if (duplicate) throw new Error("This contact point already exists on this person");
      if (form.originalPoint) {
        await api.entities.updateContactPoint(entity.id, form.originalPoint.id, {
          value: form.value,
          isPrimary: form.isPrimary,
        });
      } else {
        await api.entities.createContactPoint(entity.id, {
          kind: form.kind,
          value: form.value,
          makePrimary: form.isPrimary,
        });
      }
    },
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message),
  });
  const deleteMutation = useMutation({
    mutationFn: async (target: { alias?: string; pointId?: string }) => {
      if (target.alias) return api.entities.removeAlias(entity.id, target.alias);
      if (target.pointId) await api.entities.deleteContactPoint(entity.id, target.pointId);
      return null;
    },
    onSuccess: (result) => {
      if (result && "removed" in result) {
        toast.success(`Removed "${result.removed[0]}" — it won't come back on its own`);
      }
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const empty = sortedPoints.length === 0 && aliases.length === 0;
  if (empty && !isAdmin) return null;

  const formKindDef = form ? IDENTITY_KINDS.find((def) => def.kind === form.kind) : null;
  const addingName = form?.kind === "name" && !form.originalAlias;
  const startAdd = (def: (typeof IDENTITY_KINDS)[number]) =>
    setForm({
      kind: def.kind,
      value: "",
      isPrimary: def.hasPrimary && !points.some((point) => point.kind === def.kind),
    });

  return (
    <div className="mb-4 rounded-lg border bg-muted/20 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Identity</div>
        {isAdmin ? (
          <Button
            type="button"
            size="sm"
            variant={editing ? "secondary" : "ghost"}
            className="h-7 text-[11px]"
            data-testid="identity-edit-toggle"
            onClick={() => {
              setEditing((current) => !current);
              setForm(null);
            }}
          >
            {editing ? "Done" : "Edit"}
          </Button>
        ) : null}
      </div>

      {!editing ? (
        <div className="mt-1 space-y-0.5">
          {sortedPoints.map((point) => (
            <div key={point.id} className="truncate font-mono text-xs">
              {point.value}
            </div>
          ))}
          {aliases.length > 0 ? (
            <div className="truncate text-xs text-muted-foreground">aka {aliases.join(" · ")}</div>
          ) : null}
          {empty ? <div className="text-[11px] text-muted-foreground">Nothing recorded yet.</div> : null}
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {sortedPoints.map((point) =>
            form?.originalPoint?.id === point.id && formKindDef ? (
              <IdentityRowForm
                key={point.id}
                form={form}
                def={formKindDef}
                pending={saveMutation.isPending}
                onChange={setForm}
                onSave={() => saveMutation.mutate()}
                onCancel={() => setForm(null)}
              />
            ) : (
              <div key={point.id} className="flex items-center gap-2 rounded-md bg-background px-3 py-1.5">
                <span className="w-11 shrink-0 text-[10px] font-semibold uppercase text-muted-foreground">
                  {point.kind}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{point.value}</span>
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{point.provenance}</span>
                {point.isPrimary ? (
                  <Badge variant="secondary" className="text-[9px]">
                    Primary
                  </Badge>
                ) : null}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label={`Edit ${point.value}`}
                  onClick={() =>
                    setForm({
                      kind: point.kind as IdentityKind,
                      value: point.value,
                      isPrimary: point.isPrimary,
                      originalPoint: point,
                    })
                  }
                >
                  <PencilSimpleIcon size={13} />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  aria-label={`Delete ${point.value}`}
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate({ pointId: point.id })}
                >
                  <TrashIcon size={13} />
                </Button>
              </div>
            ),
          )}
          {aliases.length > 0 || addingName ? (
            <div className="flex items-start gap-2 rounded-md bg-background px-3 py-2">
              <span className="w-11 shrink-0 pt-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                name
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {aliases.map((alias) =>
                  form?.originalAlias === alias ? (
                    <AliasChipEditor
                      key={alias}
                      form={form}
                      pending={saveMutation.isPending}
                      onChange={setForm}
                      onSave={() => saveMutation.mutate()}
                      onCancel={() => setForm(null)}
                    />
                  ) : (
                    <span
                      key={alias}
                      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px]"
                      data-testid={`alias-row-${alias}`}
                    >
                      <span className="max-w-56 truncate">{alias}</span>
                      <button
                        type="button"
                        aria-label={`Edit alias ${alias}`}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setForm({ kind: "name", value: alias, isPrimary: false, originalAlias: alias })}
                      >
                        <PencilSimpleIcon size={11} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete alias ${alias}`}
                        className="text-muted-foreground hover:text-destructive"
                        disabled={deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate({ alias })}
                      >
                        <XIcon size={11} />
                      </button>
                    </span>
                  ),
                )}
                {addingName && form ? (
                  <AliasChipEditor
                    form={form}
                    pending={saveMutation.isPending}
                    onChange={setForm}
                    onSave={() => saveMutation.mutate()}
                    onCancel={() => setForm(null)}
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {form && formKindDef && form.kind !== "name" && !form.originalPoint ? (
            <IdentityRowForm
              form={form}
              def={formKindDef}
              pending={saveMutation.isPending}
              onChange={setForm}
              onSave={() => saveMutation.mutate()}
              onCancel={() => setForm(null)}
            />
          ) : form ? null : kinds.length === 1 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-[11px]"
              data-testid="identity-add"
              onClick={() => startAdd(kinds[0])}
            >
              <PlusIcon size={12} /> Add name
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-[11px]"
                  data-testid="identity-add"
                >
                  <PlusIcon size={12} /> Add
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {kinds.map((def) => (
                  <DropdownMenuItem key={def.kind} onClick={() => startAdd(def)}>
                    {def.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  );
}

function formatTaskStatus(status: string): string {
  return TASK_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status.replace(/_/g, " ");
}

function formatTaskCount(status: TaskStatus, count: number): string {
  return `${count} ${formatTaskStatus(status).toLowerCase()}`;
}

function formatTasksSummaryLine(tasks: EntityTask[]): string {
  if (tasks.length === 0) return "No tasks";
  const counts = new Map<TaskStatus, number>(TASK_STATUS_OPTIONS.map((option) => [option.value, 0]));
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  const editableCount = tasks.filter((task) => task.canEditStatus).length;
  const parts = [
    `${tasks.length} total`,
    ...TASK_STATUS_OPTIONS.flatMap((option) => {
      const count = counts.get(option.value) ?? 0;
      return count > 0 ? [formatTaskCount(option.value, count)] : [];
    }),
  ];
  parts.push(editableCount > 0 ? `${editableCount} editable` : "monitoring only");
  return parts.join(" · ");
}

function taskStatusTone(status: TaskStatus): string {
  switch (status) {
    case "in_progress":
      return "border-amber-500/40 text-amber-600 dark:border-amber-500/30 dark:text-amber-400";
    case "done":
      return "border-emerald-500/40 text-emerald-600 dark:border-emerald-500/30 dark:text-emerald-400";
    case "dropped":
      return "text-muted-foreground line-through";
    default:
      return "text-muted-foreground";
  }
}

function taskPriorityTone(priority: string): string {
  switch (priority) {
    case "high":
      return "border-amber-500/40 text-amber-600 dark:border-amber-500/30 dark:text-amber-400";
    case "medium":
      return "border-sky-500/40 text-sky-600 dark:border-sky-500/30 dark:text-sky-400";
    case "low":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

function PriorityBadge({ priority }: { priority: string }) {
  return (
    <Badge variant="outline" className={cn("text-[10px] uppercase tracking-wider", taskPriorityTone(priority))}>
      {formatTitleCase(priority)}
    </Badge>
  );
}

function TaskStatusPill({ status }: { status: TaskStatus }) {
  return (
    <Badge variant="outline" className={cn("max-w-full truncate text-[10px] sm:max-w-40", taskStatusTone(status))}>
      {formatTaskStatus(status)}
    </Badge>
  );
}

function MetaSeparator() {
  return (
    <span aria-hidden className="text-muted-foreground/40">
      ·
    </span>
  );
}

function formatTitleCase(value: string): string {
  return value
    .replace(/[_-]/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatProviderName(source: string): string {
  if (source === "clickup") return "ClickUp";
  if (source === "linear") return "Linear";
  return formatTitleCase(source);
}

function formatTaskSource(task: EntityTask): string {
  if (task.provenance === "summary") return "From Summarizer";
  if (task.provenance === "brief") return "From Daily Brief";
  if (task.externalRef) return `${formatProviderName(task.source)} ${task.externalRef}`;
  return formatProviderName(task.source);
}

function taskAssigneeMeta(
  task: EntityTask,
): { kind: "assigned"; label: string } | { kind: "proposed"; label: string } | null {
  if (task.assigneeName) return { kind: "assigned", label: `Assigned to ${task.assigneeName}` };
  if (task.assigneeEntityId) return { kind: "assigned", label: "Assigned" };
  if (task.proposedAssigneeName) return { kind: "proposed", label: `Mentioned: ${task.proposedAssigneeName}` };
  return null;
}

function taskCreatorLabel(task: EntityTask): string | null {
  if (task.isOwnedByViewer) return "Created by you";
  if (task.createdByUserName) return `Created by ${task.createdByUserName}`;
  if (task.createdByUserEmail) return `Created by ${task.createdByUserEmail}`;
  if (task.createdByUserId) return "Created by another user";
  return null;
}

function externalStatusValue(task: EntityTask): string | null {
  if (task.statusRaw && task.statusAuthority === "external") return task.statusRaw;
  return null;
}

interface TasksPanelProps {
  entityId: string;
  tasksQuery: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.entities.tasks>>>>;
}

/**
 * TasksPanel — the project-only Tasks tab body. Renders a compact,
 * hairline-divided list of project tasks with inline status controls for
 * editable (local/owned) tasks and a passive status pill for read-only /
 * external-authority tasks. No big read-only instruction block — the source
 * line and external status already carry that context.
 */
function TasksPanel({ entityId, tasksQuery }: TasksPanelProps) {
  const queryClient = useQueryClient();
  const updateMutation = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: TaskStatus }) =>
      api.entities.updateTaskStatus(entityId, taskId, status),
    onSuccess: ({ task }) => {
      queryClient.setQueryData<{ tasks: EntityTask[] }>(tasksKey(entityId), (current) => ({
        tasks: (current?.tasks ?? []).map((item) => (item.id === task.id ? task : item)),
      }));
      toast.success("Task status updated");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  if (tasksQuery.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  if (tasksQuery.isError) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
        <p className="text-xs text-muted-foreground">Couldn’t load project tasks.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void tasksQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const tasks = tasksQuery.data?.tasks ?? [];
  if (tasks.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-3">
        <p className="text-xs font-medium">No project tasks yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Summarizer action items will appear here when they are linked to this project.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <SectionLabel>{formatTasksSummaryLine(tasks)}</SectionLabel>
      <div>
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            disabled={updateMutation.isPending}
            onStatusChange={(status) => updateMutation.mutate({ taskId: task.id, status })}
          />
        ))}
      </div>
    </div>
  );
}

interface TaskRowProps {
  task: EntityTask;
  disabled: boolean;
  onStatusChange: (status: TaskStatus) => void;
}

function TaskRow({ task, disabled, onStatusChange }: TaskRowProps) {
  const assignee = taskAssigneeMeta(task);
  const creator = taskCreatorLabel(task);
  const externalStatus = externalStatusValue(task);
  return (
    <fieldset
      aria-label={`${task.title} task`}
      className="grid min-w-0 grid-cols-1 gap-1.5 border-0 border-b p-0 py-2 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-start sm:gap-3"
    >
      <div className="min-w-0">
        <div className="break-words text-sm font-medium leading-snug">{task.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-muted-foreground">
          <span className="font-mono uppercase tracking-wider">{formatTaskSource(task)}</span>
          {task.priority ? (
            <>
              <MetaSeparator />
              <PriorityBadge priority={task.priority} />
            </>
          ) : null}
          {assignee ? (
            <>
              <MetaSeparator />
              <span>{assignee.label}</span>
            </>
          ) : null}
          {creator ? (
            <>
              <MetaSeparator />
              <span>{creator}</span>
            </>
          ) : null}
          {externalStatus ? (
            <>
              <MetaSeparator />
              <span>{externalStatus}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-start">
        {task.canEditStatus ? (
          <Select
            value={task.status}
            onValueChange={(value) => onStatusChange(value as TaskStatus)}
            disabled={disabled}
          >
            <SelectTrigger aria-label={`${task.title} status`} className="h-8 w-full text-xs sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <TaskStatusPill status={task.status} />
        )}
      </div>
    </fieldset>
  );
}

/**
 * Summary block — deterministic prose built server-side from relationships +
 * activity aggregates. No LLM, no shimmer. Two short paragraphs: identity
 * (type / role / employer / engagements) and activity (file count, mention
 * count, distinct days active, most-frequent collaborators).
 */
function SummaryBlock({ entity, accent }: { entity: EntityDetail; accent: string }) {
  const { identity, activity } = entity.profile.summary;
  const crmBrief = entity.profile.crmActivityBrief;
  const hasContent = identity.length > 0 || activity.length > 0 || Boolean(crmBrief);
  return (
    <SectionCard accent={accent} label="Summary">
      {hasContent ? (
        <div className="space-y-2 text-sm leading-snug">
          {identity ? <p>{identity}</p> : null}
          {activity ? <p className="text-muted-foreground">{activity}</p> : null}
          {crmBrief ? (
            <div className="border-t pt-2">
              <SectionLabel className="mb-1">CRM Activity</SectionLabel>
              <p>{crmBrief.summary}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {crmBrief.activityCount} {crmBrief.activityCount === 1 ? "activity" : "activities"} · updated{" "}
                {formatShortDate(crmBrief.updatedAt)}
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No summary yet.</p>
      )}
    </SectionCard>
  );
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface DrawerTabsProps {
  entityId: string;
  sourceType: string;
  relations: EntityRelationsResponse | undefined;
  relationsLoading: boolean;
  isAdmin: boolean;
}

function tasksKey(entityId: string): unknown[] {
  return ["entity-drawer", "tasks", entityId];
}

function DrawerTabs({ entityId, sourceType, relations, relationsLoading, isAdmin }: DrawerTabsProps) {
  const isProject = sourceType === "project";
  const [tab, setTab] = useState<"timeline" | "relationships" | "tasks" | "scope">("timeline");
  const timelineQuery = useQuery({
    queryKey: ["entity-drawer", "timeline", entityId],
    queryFn: () => api.entities.timeline(entityId),
  });
  const tasksQuery = useQuery({
    queryKey: tasksKey(entityId),
    queryFn: () => api.entities.tasks(entityId),
    enabled: isProject,
  });

  const timelineCount = timelineQuery.data?.totalCount ?? 0;
  const timelineHint = timelineQuery.data?.truncated
    ? `${timelineCount}+`
    : timelineCount > 0
      ? `${timelineCount}`
      : null;
  const relationsCount = relations?.totalCount ?? 0;
  const relationsHint = relations?.truncated ? `${relationsCount}+` : relationsCount > 0 ? `${relationsCount}` : null;
  const tasksCount = tasksQuery.data?.tasks.length ?? 0;
  const tasksHint = tasksCount > 0 ? `${tasksCount}` : null;

  return (
    <div className="mt-5">
      <div className="mb-3 inline-flex rounded-lg border-[0.5px] border-border bg-card p-0.5 dark:bg-[#111110]">
        <TabButton
          active={tab === "timeline"}
          onClick={() => setTab("timeline")}
          label="Timeline"
          hint={timelineHint}
        />
        <TabButton
          active={tab === "relationships"}
          onClick={() => setTab("relationships")}
          label="Relationships"
          hint={relationsHint}
        />
        {isProject ? (
          <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")} label="Tasks" hint={tasksHint} />
        ) : null}
        {isProject ? (
          <TabButton active={tab === "scope"} onClick={() => setTab("scope")} label="Scope" hint={null} />
        ) : null}
      </div>
      {tab === "scope" && isProject ? (
        <ScopePanel entityId={entityId} />
      ) : tab === "tasks" && isProject ? (
        <TasksPanel entityId={entityId} tasksQuery={tasksQuery} />
      ) : tab === "timeline" ? (
        <TimelinePanel entityId={entityId} timelineQuery={timelineQuery} />
      ) : (
        <RelationshipsPanel
          relations={relations}
          isLoading={relationsLoading}
          entityId={entityId}
          sourceType={sourceType}
          isAdmin={isAdmin}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-1 text-xs transition-colors",
        active
          ? "bg-accent font-medium text-foreground dark:bg-[#1C1C1A]"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {hint ? <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{hint}</span> : null}
    </button>
  );
}

interface TimelinePanelProps {
  entityId: string;
  timelineQuery: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.entities.timeline>>>>;
}

function TimelinePanel({ entityId, timelineQuery }: TimelinePanelProps) {
  if (timelineQuery.isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }
  const groups = timelineQuery.data?.groups ?? [];
  if (groups.length === 0) {
    return <p className="text-xs text-muted-foreground">No file mentions yet.</p>;
  }
  return <TimelineStrip groups={groups} entityId={entityId} />;
}

/** Convenience re-export so callers can pull both the provider mount and the drawer from one place. */
export { EntityChip };
