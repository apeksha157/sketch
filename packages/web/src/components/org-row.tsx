/**
 * OrgRow — the row primitive for every Your Org list (people, entities,
 * products, the projects tree). It keeps avatar size, type scale, gaps, and
 * padding consistent as the directory grows. The density target is the
 * compact review row: quiet, one-line-first, small type.
 *
 * Slots:
 * - `avatar` — an {@link EntityAvatar} at `sm`, the one shared size. Rows
 *   without an entity (graph-verdict proposals) lead with a mono tag instead,
 *   and select-mode rows prepend a checkbox in this slot.
 * - `primary` — the primary line (name), with optional inline `primaryChips`.
 * - `inlineSuffix` — a muted continuation on the *same* line as the primary
 *   (the review row's "→ suggestion"); mutually exclusive in practice with
 *   `secondary`.
 * - `secondary` — a muted line *below* the primary (people's role · subtype).
 * - `middle` — an optional fixed-width middle column (the contact column).
 * - `meta` — right-aligned fixed-width columns (counts, dates, status, type).
 * - `trailing` — arbitrary non-interactive trailing content.
 * - `caret` — an optional trailing affordance caret.
 * - `actions` — interactive trailing content (CompactAction verbs) rendered as
 *   a sibling of the row button: buttons can't nest inside buttons, so this is
 *   the one sanctioned place for in-row verbs.
 * - `footer` — rendered inside the bordered cell, under the interactive area.
 * - `leading` — rendered before the row button, outside its click target
 *   (the tree's caret / drag grip).
 * - `containerProps` — spread onto the outer cell (drag-and-drop handlers,
 *   indent padding).
 */
import { SourceTag } from "@/components/entity-drawer/drawer-kit";
import { CaretRightIcon, SparkleIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import type { HTMLAttributes, ReactNode } from "react";

/**
 * The "AI discovered" tag — one look for every list. Styled like the app's
 * other mono metadata tags (SourceTag), not a colored pill: it appears on most
 * rows, so it has to read as quiet provenance, not an alert.
 */
export function AiBadge() {
  return (
    <SourceTag title="AI discovered" className="inline-flex items-center gap-0.5 tracking-wide">
      <SparkleIcon size={8} weight="fill" />
      AI
    </SourceTag>
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
  avatar?: ReactNode;
  primary: ReactNode;
  primaryChips?: ReactNode;
  inlineSuffix?: ReactNode;
  secondary?: ReactNode;
  middle?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  caret?: boolean;
  actions?: ReactNode;
  footer?: ReactNode;
  leading?: ReactNode;
  containerProps?: HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  onOpen: () => void;
  disabled?: boolean;
  className?: string;
  rowClassName?: string;
  testId?: string;
  buttonTestId?: string;
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
  actions,
  footer,
  leading,
  containerProps,
  onOpen,
  disabled,
  className,
  rowClassName,
  testId,
  buttonTestId,
}: OrgRowProps) {
  return (
    <div
      {...containerProps}
      className={cn("group border-b border-border last:border-b-0", className, containerProps?.className)}
      data-testid={testId}
    >
      <div className={cn("flex items-center", rowClassName)}>
        {leading}
        <button
          type="button"
          onClick={onOpen}
          disabled={disabled}
          data-testid={buttonTestId}
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
        {actions}
      </div>
      {footer}
    </div>
  );
}
