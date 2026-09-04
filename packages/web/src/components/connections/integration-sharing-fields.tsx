import { BuildingsIcon, LockSimpleIcon, MagnifyingGlassIcon, PlusIcon, UsersIcon, XIcon } from "@phosphor-icons/react";
import { Avatar, AvatarFallback } from "@sketch/ui/components/avatar";
import { Button } from "@sketch/ui/components/button";
import { Input } from "@sketch/ui/components/input";
import { Label } from "@sketch/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { getInitials } from "@sketch/ui/lib/utils";
import { Popover } from "radix-ui";
import { useId, useRef, useState } from "react";

export type SharingMode = "personal" | "members" | "organization";
type SharingMember = { id: string; name?: string | null; email?: string | null };

export function IntegrationSharingFields({
  mode,
  onModeChange,
  selected,
  onSelectedChange,
  members,
  orgName,
  saving = false,
  isLoading = false,
  isError = false,
  onRetry,
  canShareOrganization = true,
  memberLimit = Number.POSITIVE_INFINITY,
}: {
  mode: SharingMode;
  onModeChange: (mode: SharingMode) => void;
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
  members: SharingMember[];
  orgName?: string;
  saving?: boolean;
  isLoading?: boolean;
  isError?: boolean;
  onRetry: () => void;
  canShareOrganization?: boolean;
  memberLimit?: number;
}) {
  const accessId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const firstResult = useRef<HTMLButtonElement>(null);
  const focusResults = useRef(false);
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const query = search.trim().toLowerCase();
  const selectedIds = new Set(selected);
  const selectedMembers = members.filter((member) => selectedIds.has(member.id));
  const availableMembers = members.filter(
    (member) =>
      !selectedIds.has(member.id) &&
      (!query || `${member.name ?? ""} ${member.email ?? ""}`.toLowerCase().includes(query)),
  );
  const choices = [
    { value: "personal", label: "Private", description: "Only you can use this account.", icon: LockSimpleIcon },
    {
      value: "members",
      label: "Selected members",
      description: "You and the members you choose.",
      icon: UsersIcon,
    },
    {
      value: "organization",
      label: "Entire organization",
      description: `Everyone in ${orgName || "your organization"}, including new members.`,
      icon: BuildingsIcon,
    },
  ] as const;
  const currentChoice = choices.find((choice) => choice.value === mode) ?? choices[0];

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={accessId} className="font-normal text-muted-foreground">
          Who has access
        </Label>
        <Select
          value={mode}
          onValueChange={(value) => {
            onModeChange(value as SharingMode);
            setSearch("");
            setPickerOpen(false);
          }}
          disabled={saving}
        >
          <SelectTrigger
            id={accessId}
            className="h-11 rounded-lg bg-muted/50 px-3.5 shadow-none focus-visible:border-muted-foreground focus-visible:ring-foreground/20 focus-visible:ring-2"
          >
            <SelectValue>
              <span className="flex items-center gap-2.5">
                <currentChoice.icon size={18} aria-hidden className="shrink-0 text-muted-foreground" />
                {currentChoice.label}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="w-[var(--radix-select-trigger-width)] rounded-lg border-border bg-muted shadow-lg [&>div]:h-auto">
            {choices.map((choice) => (
              <SelectItem
                key={choice.value}
                value={choice.value}
                textValue={choice.label}
                disabled={choice.value === "organization" && !canShareOrganization}
                className="min-h-16 rounded-md py-3 pr-9 pl-3 focus:text-foreground data-[state=checked]:bg-accent [&>span:first-child]:left-auto [&>span:first-child]:right-3 [&>span:first-child]:top-1/2 [&>span:first-child]:-translate-y-1/2 [&>span:last-child]:min-w-0"
              >
                <span className="flex items-start gap-3">
                  <choice.icon size={20} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block font-medium">{choice.label}</span>
                    <span className="mt-0.5 block break-words text-sm leading-5 text-muted-foreground">
                      {choice.description}
                    </span>
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {mode !== "members" && <p className="text-sm leading-5 text-muted-foreground">{currentChoice.description}</p>}
        {!canShareOrganization && (
          <p className="text-sm text-muted-foreground">Only admins can share with the entire organization.</p>
        )}
      </div>
      {mode === "members" && (
        <div className="space-y-3">
          <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
            <Popover.Anchor asChild>
              <div className="relative">
                <MagnifyingGlassIcon
                  size={18}
                  aria-hidden
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  ref={searchInput}
                  aria-label="Add members"
                  placeholder="Add members"
                  autoComplete="off"
                  value={search}
                  onClick={() => setPickerOpen(true)}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPickerOpen(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      focusResults.current = true;
                      setPickerOpen(true);
                      firstResult.current?.focus();
                    }
                  }}
                  className="h-11 rounded-lg pl-10 text-sm shadow-none focus-visible:border-muted-foreground focus-visible:ring-foreground/20 focus-visible:ring-2"
                  disabled={saving || selected.length >= memberLimit}
                />
              </div>
            </Popover.Anchor>
            {!isLoading && !isError && (
              <Popover.Portal>
                <Popover.Content
                  aria-label="Available members"
                  align="start"
                  sideOffset={4}
                  onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    if (focusResults.current) firstResult.current?.focus();
                    focusResults.current = false;
                  }}
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    searchInput.current?.focus();
                  }}
                  onInteractOutside={(event) => {
                    if (event.target === searchInput.current) event.preventDefault();
                  }}
                  className="z-50 max-h-48 w-[var(--radix-popover-trigger-width)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-muted p-1 shadow-lg outline-none [scrollbar-width:thin]"
                >
                  {availableMembers.map((member, index) => (
                    <button
                      key={member.id}
                      ref={index === 0 ? firstResult : undefined}
                      type="button"
                      aria-label={`Add ${member.name || member.email || member.id}`}
                      disabled={saving || selected.length >= memberLimit}
                      onClick={() => {
                        onSelectedChange([...selected, member.id]);
                        setSearch("");
                        setPickerOpen(false);
                      }}
                      className="flex min-h-14 w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-foreground/50 disabled:opacity-50"
                    >
                      <MemberIdentity member={member} />
                      <PlusIcon size={16} aria-hidden className="shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                  {availableMembers.length === 0 && (
                    <p className="px-3 py-4 text-sm text-muted-foreground">
                      {query
                        ? "No members match your search."
                        : members.length === 0
                          ? "No other members yet. Invite someone to your organization to share this account."
                          : "All available members have been added."}
                    </p>
                  )}
                </Popover.Content>
              </Popover.Portal>
            )}
          </Popover.Root>
          {isLoading ? (
            <div aria-label="Loading members" className="space-y-2">
              {[1, 2, 3].map((id) => (
                <Skeleton key={id} className="h-12 w-full rounded-md" />
              ))}
            </div>
          ) : isError ? (
            <div role="alert" className="space-y-2 text-sm">
              <p>Members could not be loaded.</p>
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
              {selectedMembers.map((member) => (
                <div key={member.id} className="flex min-h-14 items-center gap-3 py-2">
                  <MemberIdentity member={member} />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${member.name || member.email || member.id}`}
                    disabled={saving}
                    onClick={() => onSelectedChange(selected.filter((id) => id !== member.id))}
                    className="size-8 shrink-0 rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-foreground/50 focus-visible:ring-2"
                  >
                    <XIcon size={16} />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <p
            className={
              selected.length > 0 && selected.length < memberLimit ? "sr-only" : "text-sm text-muted-foreground"
            }
            aria-live="polite"
          >
            {selected.length === 0
              ? "Select at least one member to share."
              : selected.length >= memberLimit
                ? `You can share with up to ${memberLimit} members.`
                : selected.length + (selected.length === 1 ? " member selected" : " members selected")}
          </p>
        </div>
      )}
    </>
  );
}

function MemberIdentity({ member }: { member: SharingMember }) {
  const name = member.name || member.email || member.id;
  return (
    <>
      <Avatar aria-hidden>
        <AvatarFallback>{getInitials(name)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" title={name}>
          {name}
        </span>
        {member.name && member.email && (
          <span title={member.email} className="block truncate text-sm text-muted-foreground">
            {member.email}
          </span>
        )}
      </span>
    </>
  );
}
