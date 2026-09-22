/**
 * AutomationShareDialog — who has access to an automation, and their role.
 *
 * Two views inside one fixed-height body, so nothing ever resizes the modal:
 *  - At rest you see only who HAS access (owner, editors, an admins note). There
 *    is no standing list of addable people — a wall of "add me" rows reads as
 *    pushy and buries the point of the dialog.
 *  - The search field IS the add mechanism. Typing swaps the body to a flat list
 *    of just the people matching the query, each showing its status: a teammate
 *    without access gets "+ Add"; anyone who already has access shows their role.
 *    Adding someone clears the query and drops you back to the roster, where the
 *    new editor has just appeared. The × in the field clears it the same way.
 *
 * There is no floating picker, so a stray click can never dismiss the dialog.
 *
 * Roles are labels, not a per-person choice: the backend share model is binary
 * (granted = Editor), so there is no viewer/editor dropdown here. Granting and
 * revoking are optimistic; a removed row plays a brief exit animation before the
 * revoke fires. The grant/revoke endpoints are idempotent per the API contract.
 */
import { type User, api } from "@/lib/api";
import { invalidateAutomationQueries } from "@/lib/automation-refresh";
import { MagnifyingGlassIcon, PlusIcon, ShareNetworkIcon, SpinnerGapIcon, XIcon } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { cn, getInitials } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

interface AutomationShareDialogProps {
  taskId: string;
  taskName: string;
  ownerUserId: string | null | undefined;
  canShare: boolean;
  lastEditedByName?: string | null;
  lastEditedAt?: string | null;
  lease?: { clientSessionId: string; generation: number } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatShareEditedAt(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = Date.now() - date.getTime();
  const day = 86_400_000;
  if (diffMs >= 0 && diffMs < day && date.getDate() === new Date().getDate()) return "today";
  if (diffMs >= 0 && diffMs < 2 * day) return "yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

type AccessStatus = "owner" | "admin" | "editor" | "addable";

const SHARES_QUERY_KEY = (taskId: string) => ["automation-shares", taskId] as const;
const REMOVE_ANIMATION_MS = 180;

function ShareAvatar({ name }: { name: string }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] text-[11px] font-medium uppercase leading-none text-foreground/75 ring-1 ring-inset ring-border/50">
      {getInitials(name)}
    </span>
  );
}

function AccessRow({
  name,
  email,
  roleLabel,
  roleStrong,
  isYou,
  removing,
  onRemove,
}: {
  name: string;
  email: string | null;
  roleLabel: string;
  roleStrong?: boolean;
  isYou?: boolean;
  removing?: boolean;
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-lg px-2 py-2",
        onRemove ? "hover:bg-accent" : undefined,
        removing
          ? "pointer-events-none animate-out fade-out-0 zoom-out-95 duration-200 ease-out"
          : "animate-in fade-in-0 slide-in-from-top-1 duration-300 ease-out",
      )}
    >
      <ShareAvatar name={name} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {name}
          {isYou ? <span className="font-normal text-muted-foreground"> (You)</span> : null}
        </p>
        {email ? <p className="truncate text-[12px] leading-4 text-muted-foreground">{email}</p> : null}
      </div>
      <div className="relative flex shrink-0 items-center justify-end">
        <span
          className={cn(
            "text-xs transition-opacity",
            roleStrong ? "font-medium text-foreground/75" : "text-muted-foreground",
            removing ? "opacity-0" : onRemove ? "group-hover:opacity-0" : undefined,
          )}
        >
          {roleLabel}
        </span>
        {onRemove ? (
          <button
            type="button"
            aria-label={`Remove ${name}`}
            onClick={onRemove}
            className={cn(
              "absolute right-0 flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-[opacity,color] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
              removing ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          >
            <XIcon size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AddablePersonRow({
  name,
  email,
  onAdd,
}: {
  name: string;
  email: string | null;
  onAdd: () => void;
}) {
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
  lastEditedByName,
  lastEditedAt,
  lease,
  open,
  onOpenChange,
}: AutomationShareDialogProps) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());

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
      setOptimistic({});
      setRemovingIds(new Set());
    }
  }, [open]);

  const shares = sharesQuery.data?.shares ?? [];
  const grantedUserIds = useMemo(() => {
    const granted = new Set(shares.map((share) => share.userId));
    for (const [userId, isGranted] of Object.entries(optimistic)) {
      if (isGranted) {
        granted.add(userId);
      } else {
        granted.delete(userId);
      }
    }
    return granted;
  }, [optimistic, shares]);

  const allUsers = usersQuery.data?.users ?? [];
  const userById = useMemo(() => new Map(allUsers.map((user) => [user.id, user])), [allUsers]);
  const currentUserId = sessionQuery.data?.userId ?? null;
  const owner = ownerUserId ? (userById.get(ownerUserId) ?? null) : null;

  const normalizedQuery = query.trim().toLowerCase();

  const adminCount = useMemo(
    () => allUsers.filter((user) => user.auth_role === "admin" && user.id !== ownerUserId).length,
    [allUsers, ownerUserId],
  );

  const memberCount = useMemo(
    () => allUsers.filter((user) => user.auth_role !== "admin" && user.id !== ownerUserId).length,
    [allUsers, ownerUserId],
  );

  const editors = useMemo(
    () =>
      [...grantedUserIds]
        .filter((id) => id !== ownerUserId && userById.get(id)?.auth_role !== "admin")
        .map((id) => userById.get(id))
        .filter((user): user is User => Boolean(user))
        .sort((left, right) => left.name.localeCompare(right.name)),
    [grantedUserIds, ownerUserId, userById],
  );

  const searchMatches = useMemo(() => {
    if (!normalizedQuery) {
      return [];
    }
    return [...allUsers]
      .filter(
        (user) =>
          user.name.toLowerCase().includes(normalizedQuery) ||
          (user.email ?? "").toLowerCase().includes(normalizedQuery),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((user) => {
        const status: AccessStatus =
          user.id === ownerUserId
            ? "owner"
            : user.auth_role === "admin"
              ? "admin"
              : grantedUserIds.has(user.id)
                ? "editor"
                : "addable";
        return { user, status };
      });
  }, [allUsers, normalizedQuery, grantedUserIds, ownerUserId]);

  const showSearch = canShare && memberCount > 0;

  const toggleMutation = useMutation({
    mutationFn: ({ userId, grant }: { userId: string; grant: boolean }) =>
      grant
        ? api.scheduledTasks.grantShare(taskId, userId, lease ?? undefined)
        : api.scheduledTasks.revokeShare(taskId, userId, lease ?? undefined),
    onMutate: async ({ userId, grant }) => {
      await queryClient.cancelQueries({ queryKey: SHARES_QUERY_KEY(taskId) });
      setOptimistic((previous) => ({ ...previous, [userId]: grant }));
      return { userId };
    },
    onError: (error, variables) => {
      setOptimistic((previous) => {
        const next = { ...previous };
        delete next[variables.userId];
        return next;
      });
      toast.error(error instanceof Error ? error.message : "Failed to update sharing");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY(taskId) });
      void invalidateAutomationQueries(queryClient, [taskId]);
    },
  });

  const isLoading = sharesQuery.isLoading || usersQuery.isLoading;

  const addUser = (userId: string) => {
    toggleMutation.mutate({ userId, grant: true });
    setQuery("");
  };

  const removeUser = (userId: string) => {
    setRemovingIds((previous) => new Set(previous).add(userId));
    window.setTimeout(() => {
      toggleMutation.mutate({ userId, grant: false });
      setRemovingIds((previous) => {
        const next = new Set(previous);
        next.delete(userId);
        return next;
      });
    }, REMOVE_ANIMATION_MS);
  };

  const roleLabelFor = (status: AccessStatus) =>
    status === "owner" ? "Owner" : status === "admin" ? "Admin" : "Editor";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="p-5 pb-3">
          <div className="grid size-10 place-items-center rounded-[12px] bg-muted text-foreground" aria-hidden="true">
            <ShareNetworkIcon size={20} />
          </div>
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

        <div className="px-5 pb-5 pt-1">
          <div className="h-[204px] overflow-y-auto pr-0.5">
            {isLoading ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <SpinnerGapIcon size={18} className="animate-spin" />
              </div>
            ) : normalizedQuery ? (
              searchMatches.length === 0 ? (
                <p className="px-2 pt-2 text-[12px] leading-4 text-muted-foreground">
                  No people match “{query.trim()}”.
                </p>
              ) : (
                <div className="space-y-0.5">
                  {searchMatches.map(({ user, status }) =>
                    status === "addable" ? (
                      <AddablePersonRow
                        key={user.id}
                        name={user.name}
                        email={user.email}
                        onAdd={() => addUser(user.id)}
                      />
                    ) : (
                      <AccessRow
                        key={user.id}
                        name={user.name}
                        email={user.email}
                        roleLabel={roleLabelFor(status)}
                        roleStrong={status === "owner"}
                        isYou={user.id === currentUserId}
                        removing={removingIds.has(user.id)}
                        onRemove={status === "editor" && canShare ? () => removeUser(user.id) : undefined}
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
                      roleLabel="Owner"
                      roleStrong
                      isYou={owner.id === currentUserId}
                    />
                  ) : null}
                  {editors.map((user) => (
                    <AccessRow
                      key={user.id}
                      name={user.name}
                      email={user.email}
                      roleLabel="Editor"
                      isYou={user.id === currentUserId}
                      removing={removingIds.has(user.id)}
                      onRemove={canShare ? () => removeUser(user.id) : undefined}
                    />
                  ))}
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
        </div>
        {lastEditedByName?.trim() ? (
          <div className="border-t border-border/60 px-5 py-3">
            <p className="text-[11px] leading-4 text-muted-foreground">
              Last edited by <span className="font-medium text-foreground/80">{lastEditedByName.trim()}</span>
              {lastEditedAt && formatShareEditedAt(lastEditedAt) ? ` · ${formatShareEditedAt(lastEditedAt)}` : ""}
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
