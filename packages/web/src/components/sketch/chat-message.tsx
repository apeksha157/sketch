/**
 * Chat message bubbles + streaming caret — §4.17.
 *
 * User messages are right-aligned bubbles. Sketch messages are left-aligned with
 * a 24×24 yellow logo avatar and no bubble background — the avatar carries the
 * identity and the text reads as a quiet response.
 */
import { cn } from "@sketch/ui/lib/utils";
import type { ReactNode } from "react";

export function UserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[78%] rounded-[12px] bg-card border border-border",
          "px-[13px] py-[10px] text-[13px] text-foreground",
        )}
        style={{ borderRadius: "12px 12px 4px 12px", lineHeight: 1.45 }}
      >
        {children}
      </div>
    </div>
  );
}

export function SketchMessage({ children, streaming }: { children: ReactNode; streaming?: boolean }) {
  return (
    <div className="flex items-start gap-[12px]">
      <span
        className="mt-[1px] flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[6px] bg-brand-yellow text-brand-brown"
        style={{ fontSize: 13, fontWeight: 500, lineHeight: 1 }}
        aria-label="Sketch"
      >
        S
      </span>
      <div className="min-w-0 flex-1 text-[13px] text-foreground" style={{ lineHeight: 1.5 }}>
        {children}
        {streaming && <StreamingCaret />}
      </div>
    </div>
  );
}

function StreamingCaret() {
  return (
    <span className="ml-[2px] inline-block align-[-2px] bg-brand-yellow" style={{ width: 6, height: 14 }} aria-hidden />
  );
}
