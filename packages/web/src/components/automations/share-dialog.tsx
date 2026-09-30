/**
 * AutomationShareDialog — who has access to an automation, and their role.
 *
 * Two views inside one body that hugs its content:
 *  - At rest you see only who HAS access (owner, editors, an admins note). There
 *    is no standing list of addable people — a wall of "add me" rows reads as
 *    pushy and buries the point of the dialog. The roster grows with the list up
 *    to ~3.5 rows, then caps and scrolls; at that point a seamless gradient fades
 *    the content into the dialog surface (no hard line) so more is clearly there.
 *    At rest the dialog just ends after the roster — no footer band, no filler.
 *    The Discard / Save action rail appears only once you have staged changes.
 *  - The search field IS the add mechanism. Typing swaps the body to a flat list
 *    of just the people matching the query, each showing its status: a teammate
 *    without access gets "+ Add"; anyone who already has access shows their role.
 *    Adding someone clears the query and drops you back to the roster, where the
 *    new editor has just appeared. The × in the field clears it the same way.
 *
 * There is no floating picker, so a stray click can never dismiss the dialog.
 *
 * Changes are STAGED, not live. Adding queues an editor as "Adding", removing
 * marks them "Removing" (struck) — nothing takes effect until you commit with
 * one "Save changes", which is the single confirmation point for the whole
 * batch (Discard drops it all). Until then every pending edit is reversible, so
 * no one ever loses access on a stray click. On Save the grant/revoke calls fire
 * together; the endpoints are idempotent per the API contract, and a partial
 * failure keeps just the failed edits pending so they can be retried.
 *
 * Roles are labels, not a per-person choice: the backend share model is binary
 * (granted = Editor), so there is no viewer/editor dropdown here.
 */
import { type User, api } from "@/lib/api";
import { invalidateAutomationQueries } from "@/lib/automation-refresh";
import { MagnifyingGlassIcon, PlusIcon, ShareNetworkIcon, SpinnerGapIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { cn, getInitials } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

interface AutomationShareDialogProps {
  taskId: string;
  taskName: string;
  ownerUserId: string | null | undefined;
  canShare: boolean;
  /**
   * Accepted for call-site compatibility but no longer rendered. Edit
   * provenance ("last edited by / when") is builder context, not a sharing
   * concern, so it lives on the builder surface rather than in this dialog.
   */
  lastEditedByName?: string | null;
  lastEditedAt?: string | null;
  lease?: { clientSessionId: string; generation: number } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A person's status relative to this automation, with their staged edit folded in. */
type AccessState = "owner" | "admin" | "editor" | "adding" | "removing" | "addable";

/** What Save will do for a staged user: add them (grant) or drop them (revoke). */
type PendingChange = "grant" | "revoke";

const SHARES_QUERY_KEY = (taskId: string) => ["automation-shares", taskId] as const;

function ShareAvatar({ name, dimmed }: { name: string; dimmed?: boolean }) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] text-[11px] font-medium uppercase leading-none text-foreground/75 ring-1 ring-inset ring-border/50",
        dimmed && "opacity-50",
      )}
    >
      {getInitials(name)}
    </span>
  );
}

function AccessRow({
  name,
  email,
  state,
  isYou,
  canManage,
  onRemove,
  onUndo,
}: {
  name: string;
  email: string | null;
  state: AccessState;
  isYou?: boolean;
  canManage?: boolean;
  onRemove?: () => void;
  onUndo?: () => void;
}) {
  const removing = state === "removing";
  const adding = state === "adding";
  const roleLabel = state === "owner" ? "Owner" : state === "admin" ? "Admin" : "Editor";

  return (
    <div
      className={cn("group flex items-center gap-3 rounded-lg px-2 py-2", onRemove && !removing && "hover:bg-accent")}
    >
      <ShareAvatar name={name} dimmed={removing} />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-sm font-medium text-foreground",
            removing && "text-muted-foreground line-through",
          )}
        >
          {name}
          {isYou ? <span className="font-normal text-muted-foreground"> (You)</span> : null}
        </p>
        {email ? (
          <p className={cn("truncate text-[12px] leading-4 text-muted-foreground", removing && "line-through")}>
            {email}
          </p>
        ) : null}
      </div>

      {adding ? (
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-emerald-600">
            Adding
          </span>
          {canManage && onUndo ? (
            <button
              type="button"
              onClick={onUndo}
              className="text-[12px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:underline"
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : removing ? (
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-destructive">
            Removing
          </span>
          {canManage && onUndo ? (
            <button
              type="button"
              onClick={onUndo}
              className="text-[12px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:underline"
            >
              Undo
            </button>
          ) : null}
        </div>
      ) : (
        <div className="relative flex shrink-0 items-center justify-end">
          <span
            className={cn(
              "text-xs transition-opacity",
              state === "owner" ? "font-medium text-foreground/75" : "text-muted-foreground",
              onRemove ? "group-hover:opacity-0" : undefined,
            )}
          >
            {roleLabel}
          </span>
          {onRemove ? (
            <button
              type="button"
              aria-label={`Remove ${name}`}
              onClick={onRemove}
              className="absolute right-0 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-[opacity,color] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
            >
              <XIcon size={14} />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function AddablePersonRow({ name, email, onAdd }: { name: string; email: string | null; onAdd: () => void }) {
  return (
    <button
      type="button"
      onClick={onAdd}
      className="group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors animate-in fade-in-0 duration-200 ease-out hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ShareAvatar name={name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        {email ? <span className="block truncate text-[12px] leading-4 text-muted-foreground">{email}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground ring-1 ring-inset ring-border transition-colors group-hover:text-foreground group-hover:ring-foreground/30 group-focus-visible:text-foreground group-focus-visible:ring-foreground/30">
        <PlusIcon size={12} weight="bold" />
        Add
      </span>
    </button>
  );
}

export function AutomationShareDialog({
  taskId,
  taskName,
  ownerUserId,
  canShare,
  lease,
  open,
  onOpenChange,
}: AutomationShareDialogProps) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Record<string, PendingChange>>({});

  const sharesQuery = useQuery({
    queryKey: SHARES_QUERY_KEY(taskId),
    queryFn: () => api.scheduledTasks.listShares(taskId),
    enabled: open,
  });

  const usersQuery = useQuery({
    queryKey: ["users-for-automation-share"],
    queryFn: () => api.users.list(),
    enabled: open,
    staleTime: 60_000,
  });

  const sessionQuery = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => api.auth.session(),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!open) {
      setQuery("");
      setPending({});
    }
  }, [open]);

  const shares = sharesQuery.data?.shares ?? [];
  const serverGranted = useMemo(() => new Set(shares.map((share) => share.userId)), [shares]);

  const allUsers = usersQuery.data?.users ?? [];
  const userById = useMemo(() => new Map(allUsers.map((user) => [user.id, user])), [allUsers]);
  const currentUserId = sessionQuery.data?.userId ?? null;
  const owner = ownerUserId ? (userById.get(ownerUserId) ?? null) : null;

  const normalizedQuery = query.trim().toLowerCase();
  const pendingCount = Object.keys(pending).length;
  const isDirty = pendingCount > 0;

  const stateFor = (userId: string): AccessState => {
    if (userId === ownerUserId) return "owner";
    if (userById.get(userId)?.auth_role === "admin") return "admin";
    const change = pending[userId];
    if (change === "grant") return "adding";
    if (change === "revoke") return "removing";
    if (serverGranted.has(userId)) return "editor";
    return "addable";
  };

  const adminCount = useMemo(
    () => allUsers.filter((user) => user.auth_role === "admin" && user.id !== ownerUserId).length,
    [allUsers, ownerUserId],
  );

  const memberCount = useMemo(
    () => allUsers.filter((user) => user.auth_role !== "admin" && user.id !== ownerUserId).length,
    [allUsers, ownerUserId],
  );

  const editors = useMemo(() => {
    const ids = new Set<string>(serverGranted);
    for (const [userId, change] of Object.entries(pending)) {
      if (change === "grant") ids.add(userId);
    }
    return [...ids]
      .filter((id) => id !== ownerUserId && userById.get(id)?.auth_role !== "admin")
      .map((id) => userById.get(id))
      .filter((user): user is User => Boolean(user))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [serverGranted, pending, ownerUserId, userById]);

  const searchMatches = useMemo(() => {
    if (!normalizedQuery) return [];
    const computeState = (userId: string): AccessState => {
      if (userId === ownerUserId) return "owner";
      if (userById.get(userId)?.auth_role === "admin") return "admin";
      const change = pending[userId];
      if (change === "grant") return "adding";
      if (change === "revoke") return "removing";
      if (serverGranted.has(userId)) return "editor";
      return "addable";
    };
    return [...allUsers]
      .filter(
        (user) =>
          user.name.toLowerCase().includes(normalizedQuery) ||
          (user.email ?? "").toLowerCase().includes(normalizedQuery),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((user) => ({ user, state: computeState(user.id) }));
  }, [allUsers, normalizedQuery, pending, serverGranted, ownerUserId, userById]);

  const showSearch = canShare && memberCount > 0;

  const stageAdd = (userId: string) => {
    setPending((prev) => {
      const next = { ...prev };
      if (serverGranted.has(userId)) {
        delete next[userId];
      } else {
        next[userId] = "grant";
      }
      return next;
    });
    setQuery("");
  };

  const stageRemove = (userId: string) => {
    setPending((prev) => {
      const next = { ...prev };
      if (serverGranted.has(userId)) {
        next[userId] = "revoke";
      } else {
        delete next[userId];
      }
      return next;
    });
  };

  const undoChange = (userId: string) => {
    setPending((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const entries = Object.entries(pending);
      const results = await Promise.allSettled(
        entries.map(([userId, change]) =>
          change === "grant"
            ? api.scheduledTasks.grantShare(taskId, userId, lease ?? undefined)
            : api.scheduledTasks.revokeShare(taskId, userId, lease ?? undefined),
        ),
      );
      const failedUserIds = entries
        .filter((_, index) => results[index].status === "rejected")
        .map(([userId]) => userId);
      const firstError = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
      return { failedUserIds, firstError: firstError?.reason as unknown };
    },
    onSuccess: ({ failedUserIds, firstError }) => {
      setPending((prev) => {
        const next: Record<string, PendingChange> = {};
        for (const userId of failedUserIds) {
          if (prev[userId]) next[userId] = prev[userId];
        }
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY(taskId) });
      void invalidateAutomationQueries(queryClient, [taskId]);
      if (failedUserIds.length === 0) {
        toast.success("Sharing updated");
      } else {
        toast.error(firstError instanceof Error ? firstError.message : "Some changes couldn't be saved");
      }
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Couldn't save sharing"),
  });

  const isSaving = saveMutation.isPending;
  const isLoading = sharesQuery.isLoading || usersQuery.isLoading;

  const rosterRef = useRef<HTMLDivElement>(null);
  const [rosterScroll, setRosterScroll] = useState({ atTop: true, atBottom: true });
  const syncRosterScroll = useCallback(() => {
    const el = rosterRef.current;
    if (!el) return;
    const atTop = el.scrollTop <= 1;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
    setRosterScroll((prev) => (prev.atTop === atTop && prev.atBottom === atBottom ? prev : { atTop, atBottom }));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure the scroll fades whenever the visible roster changes (open, search, add/remove), not only when syncRosterScroll's identity changes
  useEffect(() => {
    const id = requestAnimationFrame(syncRosterScroll);
    return () => cancelAnimationFrame(id);
  }, [syncRosterScroll, open, normalizedQuery, editors.length, searchMatches.length, pendingCount]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex flex-col gap-0 p-0 sm:max-w-md"
        onInteractOutside={(event) => {
          if (isDirty) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (isDirty) event.preventDefault();
        }}
      >
        <DialogHeader className="flex-row items-center gap-3.5 space-y-0 p-5 pb-3">
          <span
            className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-foreground/5 text-foreground"
            aria-hidden="true"
          >
            <ShareNetworkIcon size={22} />
          </span>
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-[17px] font-semibold leading-6 tracking-[-0.01em]">
              Share automation
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-5">
              Anyone you add can run and edit this automation.
            </DialogDescription>
          </div>
        </DialogHeader>

        {showSearch ? (
          <div className="px-5 pb-2">
            <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 transition-shadow focus-within:ring-2 focus-within:ring-ring/40">
              <MagnifyingGlassIcon size={15} className="shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Add people…"
                aria-label="Add people"
                className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon size={14} />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="px-5 pb-1 pt-1">
          <div className="relative">
            <div ref={rosterRef} onScroll={syncRosterScroll} className="max-h-[204px] overflow-y-auto pr-0.5">
              {isLoading ? (
                <div className="flex h-[120px] items-center justify-center text-muted-foreground">
                  <SpinnerGapIcon size={18} className="animate-spin" />
                </div>
              ) : normalizedQuery ? (
                searchMatches.length === 0 ? (
                  <p className="px-2 pt-2 text-[12px] leading-4 text-muted-foreground">
                    No people match “{query.trim()}”.
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {searchMatches.map(({ user, state }) =>
                      state === "addable" ? (
                        <AddablePersonRow
                          key={user.id}
                          name={user.name}
                          email={user.email}
                          onAdd={() => stageAdd(user.id)}
                        />
                      ) : (
                        <AccessRow
                          key={user.id}
                          name={user.name}
                          email={user.email}
                          state={state}
                          isYou={user.id === currentUserId}
                          canManage={canShare}
                          onRemove={state === "editor" && canShare ? () => stageRemove(user.id) : undefined}
                          onUndo={
                            (state === "adding" || state === "removing") && canShare
                              ? () => undoChange(user.id)
                              : undefined
                          }
                        />
                      ),
                    )}
                  </div>
                )
              ) : (
                <>
                  <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    People with access
                  </p>
                  <div className="space-y-0.5">
                    {owner ? (
                      <AccessRow
                        name={owner.name}
                        email={owner.email}
                        state="owner"
                        isYou={owner.id === currentUserId}
                      />
                    ) : null}
                    {editors.map((user) => {
                      const state = stateFor(user.id);
                      return (
                        <AccessRow
                          key={user.id}
                          name={user.name}
                          email={user.email}
                          state={state}
                          isYou={user.id === currentUserId}
                          canManage={canShare}
                          onRemove={state === "editor" && canShare ? () => stageRemove(user.id) : undefined}
                          onUndo={
                            (state === "adding" || state === "removing") && canShare
                              ? () => undoChange(user.id)
                              : undefined
                          }
                        />
                      );
                    })}
                  </div>
                  {adminCount > 0 ? (
                    <p className="px-2 pt-2 text-[12px] leading-4 text-muted-foreground">
                      {adminCount === 1 ? "1 workspace admin" : `${adminCount} workspace admins`} also{" "}
                      {adminCount === 1 ? "has" : "have"} full access.
                    </p>
                  ) : null}
                  {!canShare ? (
                    <p className="px-2 pt-2 text-[11px] text-muted-foreground">
                      You don't have permission to change sharing.
                    </p>
                  ) : null}
                </>
              )}
            </div>
            {/* Seamless scroll gradients: content dissolves into the dialog
                surface at the top/bottom edges when there is more to scroll,
                so a longer roster fades toward the CTA rail instead of ending
                on a hard line. They vanish once you reach an edge. */}
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 top-0 h-5 transition-opacity duration-150",
                rosterScroll.atTop ? "opacity-0" : "opacity-100",
              )}
              style={{ background: "linear-gradient(to bottom, var(--background), transparent)" }}
            />
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 bottom-0 h-9 transition-opacity duration-150",
                rosterScroll.atBottom ? "opacity-0" : "opacity-100",
              )}
              style={{ background: "linear-gradient(to top, var(--background), transparent)" }}
            />
          </div>
        </div>

        {/* Action rail — present only when there are staged changes. At rest the
            dialog just ends after the roster with a little breathing room; there
            is no filler line and no empty band. The content above fades into the
            rail via the scroll gradient, so there is no stroke. */}
        <div className={cn("flex items-center justify-end gap-2 px-5", isDirty && canShare ? "h-[52px]" : "h-4")}>
          {isDirty && canShare ? (
            <>
              <Button
                variant="outline"
                onClick={() => setPending({})}
                disabled={isSaving}
                className="h-9 min-w-[116px] rounded-[8px] text-[13px] shadow-none"
              >
                Discard
              </Button>
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={isSaving}
                className="h-9 min-w-[116px] gap-1.5 rounded-[8px] bg-foreground text-[13px] font-semibold text-background shadow-none hover:bg-foreground/90"
              >
                {isSaving ? <SpinnerGapIcon size={15} className="animate-spin" /> : null}
                {pendingCount === 1 ? "Save change" : "Save changes"}
              </Button>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
