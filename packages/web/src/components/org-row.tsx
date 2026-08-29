/**
 * OrgRow — the row primitive for every Your Org list (people, entities,
 * products, the projects tree). It keeps avatar size, type scale, gaps, and
 * padding consistent as the directory grows. The density target is the
 * compact review row: quiet, one-line-first, small type.
 *
 * Slots:
 * - `avatar` — always an {@link EntityAvatar} at `sm`, the one shared size.
 * - `primary` — the primary line (name), with optional inline `primaryChips`.
 * - `inlineSuffix` — a muted continuation on the *same* line as the primary
 *   (the review row's "→ suggestion"); mutually exclusive in practice with
 *   `secondary`.
 * - `secondary` — a muted line *below* the primary (people's role · subtype).
 * - `middle` — an optional fixed-width middle column (the contact column).
 * - `meta` — right-aligned fixed-width columns (counts, dates, status, type).
 * - `trailing` — arbitrary non-interactive trailing content.
 * - `caret` — an optional trailing affordance caret.
 * - `footer` — rendered inside the bordered cell, under the interactive area.
 * - `leading` — rendered before the row button, outside its click target
 *   (the tree's caret / drag grip).
 * - `containerProps` — spread onto the outer cell (drag-and-drop handlers,
 *   indent padding).
 */
import { CaretRightIcon, SparkleIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { cn } from "@sketch/ui/lib/utils";
import type { HTMLAttributes, ReactNode } from "react";

/** The violet "AI discovered" chip — one look for every list. */
export function AiBadge() {
  return (
    <Badge
      variant="secondary"
      className="gap-0.5 bg-violet-100 px-1 py-0 text-[9px] text-violet-700 dark:bg-violet-900 dark:text-violet-300"
    >
      <SparkleIcon size={8} weight="fill" />
      AI
    </Badge>
  );
}

/**
 * The column header strip above an OrgRow list. `className` on a column sets
 * its width and alignment; the first column usually takes `min-w-0 flex-1`.
 */
export function OrgListHeader({ columns }: { columns: { label: string; className: string }[] }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border bg-muted/30 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {columns.map((column) => (
        <span key={column.label} className={column.className}>
          {column.label}
        </span>
      ))}
    </div>
  );
}

export interface OrgRowProps {
  avatar: ReactNode;
  primary: ReactNode;
  primaryChips?: ReactNode;
  inlineSuffix?: ReactNode;
  secondary?: ReactNode;
  middle?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  caret?: boolean;
  footer?: ReactNode;
  leading?: ReactNode;
  containerProps?: HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  onOpen: () => void;
  className?: string;
  testId?: string;
}

export function OrgRow({
  avatar,
  primary,
  primaryChips,
  inlineSuffix,
  secondary,
  middle,
  meta,
  trailing,
  caret,
  footer,
  leading,
  containerProps,
  onOpen,
  className,
  testId,
}: OrgRowProps) {
  return (
    <div
      {...containerProps}
      className={cn("group border-b border-border last:border-b-0", className, containerProps?.className)}
      data-testid={testId}
    >
      <div className="flex items-center">
        {leading}
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left hover:bg-muted/30"
        >
          {avatar}
          <div className="flex min-w-0 flex-1 flex-col justify-center">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={cn("truncate text-[12.5px] font-medium", inlineSuffix ? "shrink-0" : "min-w-0")}>
                {primary}
              </span>
              {primaryChips}
              {inlineSuffix ? (
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{inlineSuffix}</span>
              ) : null}
            </div>
            {secondary ? <p className="truncate text-[11px] text-muted-foreground">{secondary}</p> : null}
          </div>
          {middle}
          {meta}
          {trailing}
          {caret ? (
            <CaretRightIcon
              size={12}
              aria-hidden
              className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground"
            />
          ) : null}
        </button>
      </div>
      {footer}
    </div>
  );
}
