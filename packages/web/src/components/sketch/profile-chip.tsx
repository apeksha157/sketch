/**
 * Sidebar profile chip + account menu.
 *
 * Trigger reads as: 32×32 avatar with initials, name + email stack, caret on the
 * right. Open dropdown leads with a card-styled header (avatar + name + email +
 * role pill), followed by clearly grouped actions: account (Usage / Pricing),
 * appearance (theme cycle), and sign out — separated by dividers.
 *
 * Sized and spaced to match the existing dashboard's account block on
 * /old/home/member.
 */
import { ChevronUpIcon } from "@/components/sketch/icons";
import { ChartBarIcon, CreditCardIcon, MoonIcon, SignOutIcon, SunIcon } from "@phosphor-icons/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { cn } from "@sketch/ui/lib/utils";

export interface ProfileChipProps {
  name: string;
  /** When true, shows the brown-on-yellow Admin pill (§3.3, §4.12). */
  isAdmin?: boolean;
  /** Email or other identifier — shown on the second line + as menu sub-label. */
  identifier?: string;
  onUsage?: () => void;
  onPricing?: () => void;
  onSignOut?: () => void;
}

function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface InternalProps extends ProfileChipProps {
  collapsed?: boolean;
  className?: string;
}

export function ProfileChip({
  name,
  isAdmin,
  identifier,
  onUsage,
  onPricing,
  onSignOut,
  collapsed,
  className,
}: InternalProps) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const initials = getInitials(name);
  const Avatar = (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary",
        collapsed ? "h-[28px] w-[28px]" : "h-[32px] w-[32px]",
      )}
      style={{ fontSize: collapsed ? 11 : 12, fontWeight: 600, lineHeight: 1 }}
      aria-hidden
    >
      {initials}
    </span>
  );

  return (
    <div
      className={cn(
        "border-t border-border",
        collapsed ? "pt-[10px] pb-[2px] flex items-center justify-center" : "pt-[10px] pb-[2px]",
        className,
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center rounded-[8px] transition-colors duration-100 ease-out cursor-pointer outline-none",
              collapsed ? "p-0 justify-center hover:opacity-90" : "px-[8px] py-[8px] gap-[10px] hover:bg-accent",
            )}
            aria-label={`Account menu, signed in as ${name}`}
          >
            {Avatar}
            {!collapsed && (
              <>
                <div className="flex min-w-0 flex-1 flex-col items-start text-left leading-none">
                  <div className="flex w-full items-center gap-[6px]">
                    <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
                    {isAdmin && (
                      <span
                        className="inline-flex shrink-0 items-center rounded-[3px] bg-muted px-[5px] py-[1px] text-[10px] font-semibold text-muted-foreground"
                        style={{ letterSpacing: 0 }}
                      >
                        ADMIN
                      </span>
                    )}
                  </div>
                  {identifier && (
                    <span className="mt-[3px] block w-full truncate text-left text-[11px] text-muted-foreground">
                      {identifier}
                    </span>
                  )}
                </div>
                <ChevronUpIcon size={14} className="text-muted-foreground" aria-hidden />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align={collapsed ? "center" : "start"} sideOffset={8} className="w-[260px] p-0">
          {/* Header — mirrors the chip but inside the menu */}
          <div className="flex items-center gap-[10px] px-[12px] py-[12px]">
            {Avatar}
            <div className="flex min-w-0 flex-1 flex-col items-start text-left leading-none">
              <div className="flex items-center gap-[6px]">
                <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
                {isAdmin && (
                  <span className="inline-flex shrink-0 items-center rounded-[3px] bg-muted px-[5px] py-[1px] text-[10px] font-semibold text-muted-foreground">
                    ADMIN
                  </span>
                )}
              </div>
              {identifier && (
                <span className="mt-[4px] block w-full truncate text-left text-[11px] text-muted-foreground">
                  {identifier}
                </span>
              )}
            </div>
          </div>
          <DropdownMenuSeparator className="my-0" />
          <div className="py-[4px]">
            <DropdownMenuItem onSelect={onUsage} className="gap-[10px] px-[12px] py-[7px] text-[13px]">
              <ChartBarIcon size={16} className="text-muted-foreground" aria-hidden />
              <span>Usage</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onPricing} className="gap-[10px] px-[12px] py-[7px] text-[13px]">
              <CreditCardIcon size={16} className="text-muted-foreground" aria-hidden />
              <span>Pricing</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setTheme(isDark ? "light" : "dark");
              }}
              className="gap-[10px] px-[12px] py-[7px] text-[13px]"
            >
              {isDark ? (
                <SunIcon size={16} className="text-muted-foreground" aria-hidden />
              ) : (
                <MoonIcon size={16} className="text-muted-foreground" aria-hidden />
              )}
              <span className="flex-1">{isDark ? "Light mode" : "Dark mode"}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{theme}</span>
            </DropdownMenuItem>
          </div>
          <DropdownMenuSeparator className="my-0" />
          <div className="py-[4px]">
            <DropdownMenuItem
              onSelect={onSignOut}
              className="gap-[10px] px-[12px] py-[7px] text-[13px] text-destructive focus:text-destructive"
            >
              <SignOutIcon size={16} aria-hidden />
              <span>Sign out</span>
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
