/**
 * Inline artifact card — §4.17.
 *
 * Rendered inside a Sketch message when Sketch produces structured output —
 * a new skill, a scheduled task, a file, etc. The primary action installs/saves
 * the artifact; secondary opens it in its full editor (e.g. /skills/new).
 */
import type { IconProps } from "@/components/sketch/icons";
import { cn } from "@sketch/ui/lib/utils";
import type { ComponentType } from "react";

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
      className={cn(
        "mt-[8px] flex flex-col gap-[12px] rounded-[10px] border bg-[#fafaf8] dark:bg-white/[0.03] p-[14px]",
        "border-border",
      )}
      style={{ borderWidth: "0.5px" }}
    >
      <div className="flex items-center gap-[12px]">
        <span
          className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[6px] bg-brand-yellow text-brand-brown"
          aria-hidden
        >
          <Icon size={15} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.07em" }}>
            {kind}
          </span>
          <span className="truncate text-[13px] font-medium text-foreground">{title}</span>
        </div>
      </div>
      <p className="text-[12px] text-muted-foreground" style={{ lineHeight: 1.5 }}>
        {description}
      </p>
      {tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-[10px]">
          {tags.map((tag) => (
            <span key={tag} className="rounded-[4px] bg-card px-[8px] py-[2px] text-[11px] text-muted-foreground">
              {tag}
            </span>
          ))}
        </div>
      )}
      {(primaryAction || secondaryAction) && (
        <div className="flex flex-wrap gap-[8px]">
          {primaryAction && (
            <button
              type="button"
              onClick={primaryAction.onClick}
              className={cn(
                "rounded-[6px] border border-brand-brown bg-brand-yellow px-[14px] py-[7px]",
                "text-[12px] font-medium text-brand-brown hover:bg-brand-yellow/90 transition-colors duration-100 ease-out cursor-pointer",
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
                "rounded-[6px] border bg-transparent px-[14px] py-[7px]",
                "border-border text-[12px] font-medium text-foreground",
                "hover:bg-accent transition-colors duration-100 ease-out cursor-pointer",
              )}
              style={{ borderWidth: "0.5px" }}
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
