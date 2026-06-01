/**
 * Inline artifact card — §4.17.
 *
 * Rendered inside a Sketch message when Sketch produces structured output —
 * a new skill, a scheduled task, a file, etc. The primary action installs/saves
 * the artifact; secondary opens it in its full editor (e.g. /skills/new).
 *
 * Hierarchy: eyebrow (10 mono) → title (20 medium) → description (14) →
 * meta line (10 mono dotted) → CTAs. Title is the visual anchor; CTAs sit at
 * the foot, evenly weighted as the second-loudest band on the card.
 */
import type { IconProps } from "@/components/sketch/icons";
import { cn } from "@sketch/ui/lib/utils";
import { type ComponentType, Fragment } from "react";

export interface InlineArtifactProps {
  /** Uppercase eyebrow, e.g. "NEW SKILL" or "SCHEDULED TASK". */
  kind: string;
  title: string;
  description: string;
  icon: ComponentType<IconProps>;
  tags?: string[];
  primaryAction?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
}

export function InlineArtifact({
  kind,
  title,
  description,
  icon: Icon,
  tags,
  primaryAction,
  secondaryAction,
}: InlineArtifactProps) {
  return (
    <div
      className={cn("mt-[12px] rounded-[12px] border bg-card p-[20px]", "border-border")}
      style={{ borderWidth: "0.5px" }}
    >
      <span className="block font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.08em" }}>
        {kind}
      </span>

      <div className="mt-[10px] flex items-center gap-[10px]">
        <span
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[6px] bg-brand-yellow text-brand-brown"
          aria-hidden
        >
          <Icon size={14} />
        </span>
        <h3 className="min-w-0 text-[17px] font-medium text-foreground leading-tight">{title}</h3>
      </div>

      <p className="mt-[12px] text-[13.5px] text-foreground/85" style={{ lineHeight: 1.6 }}>
        {description}
      </p>

      {tags && tags.length > 0 && (
        <div className="mt-[14px] flex flex-wrap items-center gap-[8px]">
          {tags.map((tag, i) => (
            <Fragment key={tag}>
              {i > 0 && (
                <span className="text-muted-foreground/40" aria-hidden>
                  ·
                </span>
              )}
              <span
                className="font-mono text-[10px] uppercase text-muted-foreground"
                style={{ letterSpacing: "0.08em" }}
              >
                {tag}
              </span>
            </Fragment>
          ))}
        </div>
      )}

      {(primaryAction || secondaryAction) && (
        <div className="mt-[18px] flex flex-wrap gap-[10px]">
          {primaryAction && (
            <button
              type="button"
              onClick={primaryAction.onClick}
              className={cn(
                "rounded-[12px] bg-brand-yellow px-[24px] py-[13px]",
                "font-mono text-[13px] font-bold uppercase tracking-[0.08em]",
                "text-[#0a0a0a]",
                "transition-opacity duration-150 ease-out hover:opacity-90 cursor-pointer",
              )}
            >
              {primaryAction.label}
            </button>
          )}
          {secondaryAction && (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className={cn(
                "rounded-[12px] border bg-transparent px-[24px] py-[13px]",
                "font-mono text-[13px] font-bold uppercase tracking-[0.08em]",
                "border-foreground/15 text-muted-foreground",
                "transition-[background-color,border-color,color] duration-150 ease-out cursor-pointer",
                "hover:border-foreground/30 hover:text-foreground hover:bg-foreground/[0.03]",
              )}
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
