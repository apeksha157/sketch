/**
 * Chat message bubbles + streaming affordance — §4.17.
 *
 * User messages are right-aligned bubbles. Sketch messages are left-aligned with
 * a 24×24 logo avatar and no bubble background — the avatar carries the
 * identity and the text reads as a quiet response.
 *
 * Streaming state is signalled through the avatar itself: a gentle pulse +
 * subtle scale loop on the icon, no separate dots or caret. The avatar
 * already establishes "this is from Sketch" — making it breathe while text
 * streams just intensifies that signal without adding chrome to the message
 * body. (We can't independently animate the rays around the "S" because the
 * logo ships as PNG; pulsing the whole image is the closest approximation.)
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
        src="/logos/sketch-icon-light.png"
        alt=""
        aria-label={streaming ? "Sketch is thinking" : "Sketch"}
        className={cn("mt-[2px] block h-[24px] w-[24px] shrink-0", streaming && "sketch-icon-thinking")}
      />
      <div className="min-w-0 flex-1 text-[14px] text-foreground" style={{ lineHeight: 1.7 }}>
        {children}
      </div>
    </div>
  );
}
