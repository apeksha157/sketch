import { ScopeCheckbox } from "@/components/scope-picker";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { Input } from "@sketch/ui/components/input";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { RadioGroup } from "radix-ui";
import { useState } from "react";

export type SharingMode = "personal" | "members" | "organization";

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
  members: { id: string; name?: string | null; email?: string | null }[];
  orgName?: string;
  saving?: boolean;
  isLoading?: boolean;
  isError?: boolean;
  onRetry: () => void;
  canShareOrganization?: boolean;
  memberLimit?: number;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const visible = members.filter(
    (member) => !query || `${member.name ?? ""} ${member.email ?? ""}`.toLowerCase().includes(query),
  );
  const choices = [
    { value: "personal", label: "Private", name: "Private" },
    { value: "members", label: "Members", name: "Selected members" },
    { value: "organization", label: "Organization", name: "Entire organization" },
  ] as const;

  return (
    <>
      <RadioGroup.Root
        value={mode}
        onValueChange={(value) => onModeChange(value as SharingMode)}
        aria-label="Who can use this account?"
        disabled={saving}
        className="flex gap-1 rounded-lg border border-border bg-muted/50 p-1"
      >
        {choices.map((choice) => (
          <RadioGroup.Item
            key={choice.value}
            value={choice.value}
            aria-label={choice.name}
            disabled={choice.value === "organization" && !canShareOrganization}
            className="h-9 flex-1 rounded-md border border-transparent px-1.5 text-sm font-medium text-muted-foreground outline-none transition-colors motion-reduce:transition-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/50 data-[state=checked]:border-border data-[state=checked]:bg-background data-[state=checked]:text-foreground dark:data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {choice.label}
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      {!canShareOrganization && (
        <p className="text-sm text-muted-foreground">Only admins can share with the entire organization.</p>
      )}
      {mode === "personal" && (
        <p className="text-sm leading-6 text-muted-foreground">
          Only you can use this account. It won’t be shared with anyone else.
        </p>
      )}
      {mode === "organization" && (
        <p className="text-sm leading-6 text-muted-foreground">
          Everyone in {orgName || "your organization"} can use this account, including people who join later.
        </p>
      )}
      {mode === "members" && (
        <div className="space-y-3">
          <p className="text-sm leading-6 text-muted-foreground">
            You and the members you select can use this account.
          </p>
          <div className="relative">
            <MagnifyingGlassIcon
              size={16}
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search members"
              placeholder="Search by name or email"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-10 rounded-lg pl-9 text-sm shadow-none focus-visible:border-muted-foreground focus-visible:ring-foreground/20 focus-visible:ring-2"
              disabled={saving}
            />
          </div>
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
            <div className="max-h-48 space-y-1 overflow-y-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:var(--muted-foreground)_transparent]">
              {visible.map((member) => (
                <label
                  key={member.id}
                  className={`flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors motion-reduce:transition-none hover:bg-accent/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-foreground/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 ${selected.includes(member.id) ? "bg-muted" : ""} ${saving ? "pointer-events-none" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={selected.includes(member.id)}
                    aria-label={member.name || member.email || member.id}
                    disabled={saving || (!selected.includes(member.id) && selected.length >= memberLimit)}
                    onChange={() =>
                      onSelectedChange(
                        selected.includes(member.id)
                          ? selected.filter((id) => id !== member.id)
                          : [...selected, member.id],
                      )
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium">
                      {member.name || member.email || member.id}
                    </span>
                    {member.name && member.email && (
                      <span title={member.email} className="block truncate text-sm text-muted-foreground">
                        {member.email}
                      </span>
                    )}
                  </span>
                  <span
                    aria-hidden
                    className={`flex size-5 shrink-0 items-center justify-center [&>span]:size-4.5 [&>span]:rounded-sm ${selected.includes(member.id) ? "" : "[&>span]:border-muted-foreground"}`}
                  >
                    <ScopeCheckbox checked={selected.includes(member.id)} />
                  </span>
                </label>
              ))}
              {visible.length === 0 && (
                <p className="px-3 py-5 text-sm text-muted-foreground">
                  {query
                    ? "No members match your search."
                    : "No other members yet. Invite someone to your organization to share this account."}
                </p>
              )}
            </div>
          )}
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {selected.length === 0
              ? "Select at least one member to share."
              : `${selected.length} ${selected.length === 1 ? "member" : "members"} selected`}
          </p>
        </div>
      )}
    </>
  );
}
