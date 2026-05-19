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
          "max-w-[78%] inline-flex items-center gap-[8px] rounded-[12px] border border-border",
          "bg-[#ebebea] dark:bg-white/[0.06]",
          "px-[16px] py-[10px] text-[14px] text-foreground",
        )}
        style={{ lineHeight: 1.5 }}
      >
        {children}
      </div>
    </div>
  );
}

export function SketchMessage({ children, streaming }: { children: ReactNode; streaming?: boolean }) {
  return (
    <div className="flex max-w-[78%] items-start gap-[12px]">
      <img
        src="/logos/sketch-icon-lightmode.png"
        alt=""
        aria-label="Sketch"
        className="mt-[2px] block h-[24px] w-[24px] shrink-0"
      />
      <div className="min-w-0 flex-1 text-[14px] text-foreground" style={{ lineHeight: 1.7 }}>
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
