/**
 * Files — the "brain of the org." Memory, transcripts, docs, memos all live
 * here. Promoted from a single-row nav item to a multi-line card so it carries
 * visible weight in the sidebar and reads as a destination, not a route.
 *
 * Layout (expanded):
 *
 *   📁  Files                        →
 *       128 docs · 47 calls · 22 memos
 *
 * Collapsed: still a single icon button, same tooltip pattern as other nav
 * items.
 *
 * Edge cases handled (per feedback_edge_case_thinking):
 *   - No breakdown provided → fall back to "{total} files · {lastAdded}".
 *   - No data at all (cold start, total=0) → "Nothing here yet" subline so the
 *     row never lies about emptiness.
 *   - Long counts → tabular nums + truncation on the breakdown line.
 */
import { FilesIcon } from "@/components/sketch/icons";
import { useSidebarState } from "@/components/sketch/sidebar-context";
import { cn } from "@sketch/ui/lib/utils";
import { Link, useLocation } from "@tanstack/react-router";

export interface SidebarFilesCardProps {
  /** Total file count. 0 = cold-start variant. */
  total: number;
  /**
   * Optional structured breakdown. When provided, renders
   * "{docs} docs · {calls} calls · {memos} memos" on the subline. Zero-count
   * categories are skipped so the line never shows "0 calls".
   */
  breakdown?: {
    docs?: number;
    calls?: number;
    memos?: number;
  };
  /** Free-text relative timestamp for "last added" — used when no breakdown. */
  lastAddedRelative?: string;
}

const FORMATTER = new Intl.NumberFormat("en-US");

function formatBreakdown(breakdown: SidebarFilesCardProps["breakdown"]): string | null {
  if (!breakdown) return null;
  const parts: string[] = [];
  if (breakdown.docs && breakdown.docs > 0) parts.push(`${FORMATTER.format(breakdown.docs)} docs`);
  if (breakdown.calls && breakdown.calls > 0) parts.push(`${FORMATTER.format(breakdown.calls)} calls`);
  if (breakdown.memos && breakdown.memos > 0) parts.push(`${FORMATTER.format(breakdown.memos)} memos`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function SidebarFilesCard({ total, breakdown, lastAddedRelative }: SidebarFilesCardProps) {
  const { collapsed } = useSidebarState();
  const location = useLocation();
  const isActive = location.pathname.startsWith("/files");

  if (collapsed) {
    return (
      <span className="group/tooltip relative inline-flex mx-auto">
        <Link
          to="/files"
          aria-label={`Files — ${FORMATTER.format(total)} total`}
          className={cn(
            "flex h-[30px] w-[30px] items-center justify-center rounded-[6px]",
            isActive
              ? "text-foreground bg-foreground/[0.07]"
              : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
            "transition-colors duration-100 ease-out cursor-pointer",
          )}
          aria-current={isActive ? "page" : undefined}
        >
          <FilesIcon size={16} aria-hidden />
        </Link>
        <span
          role="tooltip"
          className={cn(
            "pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-[8px] z-50",
            "whitespace-nowrap rounded-[6px] px-[9px] py-[4px] text-[11px] font-medium",
            "bg-foreground text-background",
            "opacity-0 transition-opacity duration-[120ms] ease-out",
            "group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100",
          )}
        >
          Files · {FORMATTER.format(total)}
        </span>
      </span>
    );
  }

  const breakdownLine = formatBreakdown(breakdown);
  const subline =
    total === 0
      ? "Nothing here yet"
      : (breakdownLine ?? `${FORMATTER.format(total)} files${lastAddedRelative ? ` · ${lastAddedRelative}` : ""}`);

  return (
    <Link
      to="/files"
      aria-current={isActive ? "page" : undefined}
      aria-label={`Files — ${subline}`}
      className={cn(
        "group/files flex w-full flex-col gap-[3px] rounded-[8px] px-[10px] py-[9px] text-left",
        "transition-colors duration-100 ease-out cursor-pointer",
        // Subtle tint gives Files visible weight vs. the single-row nav items
        // above it, without competing with the credits / setup card below.
        isActive ? "bg-foreground/[0.07] text-foreground" : "bg-foreground/[0.025] hover:bg-foreground/[0.05]",
      )}
    >
      <span className="flex items-center gap-[10px]">
        <FilesIcon size={16} aria-hidden className={isActive ? "text-foreground" : "text-foreground/80"} />
        <span
          className={cn(
            "flex-1 text-[13px] leading-none",
            isActive ? "font-medium text-foreground" : "font-medium text-foreground",
          )}
        >
          Files
        </span>
      </span>
      <span className="ml-[26px] truncate text-[11px] tabular-nums leading-none text-muted-foreground">{subline}</span>
    </Link>
  );
}
