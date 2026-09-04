import { ScopeCheckbox } from "@/components/scope-picker";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { Input } from "@sketch/ui/components/input";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { RadioGroup } from "radix-ui";
import { useId, useState } from "react";

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
  const modeId = useId();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const visible = members.filter(
    (member) => !query || `${member.name ?? ""} ${member.email ?? ""}`.toLowerCase().includes(query),
  );
  const choices = [
    { value: "personal", label: "Only you", description: "Keep this account private." },
    { value: "members", label: "Selected members", description: "Choose people from your organization." },
    {
      value: "organization",
      label: "Entire organization",
      description: canShareOrganization
        ? `Everyone in ${orgName || "your organization"}, including new members.`
        : "Only admins can share with the entire organization.",
    },
  ] as const;
  return (
    <>
      <div className="space-y-2">
        <p id={`${modeId}-label`} className="text-sm font-medium">
          Who can use this account?
        </p>
        <RadioGroup.Root
          value={mode}
          onValueChange={(value) => onModeChange(value as SharingMode)}
          aria-labelledby={`${modeId}-label`}
          disabled={saving}
          className="space-y-1"
        >
          {choices.map((choice) => (
            <label
              key={choice.value}
              htmlFor={`${modeId}-${choice.value}`}
              className={`flex cursor-pointer items-start gap-3 rounded-md p-3 transition-colors motion-reduce:transition-none ${mode === choice.value ? "bg-muted/60" : "hover:bg-muted/30"} ${saving ? "pointer-events-none opacity-60" : ""}`}
            >
              <RadioGroup.Item
                id={`${modeId}-${choice.value}`}
                value={choice.value}
                aria-label={choice.label}
                disabled={choice.value === "organization" && !canShareOrganization}
                className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[state=checked]:border-foreground"
              >
                <RadioGroup.Indicator className="size-2 rounded-full bg-foreground" />
              </RadioGroup.Item>
              <span className="min-w-0 space-y-0.5">
                <span className="block text-sm font-medium">{choice.label}</span>
                <span className="block text-sm text-muted-foreground">{choice.description}</span>
              </span>
            </label>
          ))}
        </RadioGroup.Root>
      </div>
      {mode === "members" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Members</p>
            <span className="text-sm text-muted-foreground" aria-live="polite">
              {selected.length} selected
            </span>
          </div>
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
              className="h-10 pl-9"
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
            <div className="max-h-52 overflow-y-auto rounded-lg border border-border">
              {visible.map((member) => (
                <label
                  key={member.id}
                  className={`flex min-h-14 w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors motion-reduce:transition-none hover:bg-muted/50 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring ${selected.includes(member.id) ? "bg-muted/40" : ""} ${saving ? "pointer-events-none opacity-60" : ""}`}
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
                  <span
                    aria-hidden
                    className={selected.includes(member.id) ? undefined : "[&>span]:border-muted-foreground"}
                  >
                    <ScopeCheckbox checked={selected.includes(member.id)} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium">
                      {member.name || member.email || member.id}
                    </span>
                    {member.name && member.email && (
                      <span className="block break-all text-sm text-muted-foreground">{member.email}</span>
                    )}
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
          {selected.length === 0 && (
            <p className="text-sm text-muted-foreground">Select at least one member, or choose Only you.</p>
          )}
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        Shared actions run as this account. You keep control of its access.
      </p>
    </>
  );
}
