/**
 * BuilderSidecar — the chat rail that sits to the left of the builder canvas.
 * Same conversation that started on /chat/:id, continued inside the builder.
 *
 * Chat is the lead surface and is always present: in Sketch automations are only
 * authored through chat (no manual canvas creation), so unlike Canvas there is no
 * reason to collapse the rail. It stays persistent.
 *
 * Defaults to 400px — wide enough for messages to breathe (Slack thread sidebar
 * ~420, Linear rail similar) without crowding the canvas. The user can drag the
 * right edge to resize within [320, 600]px.
 *
 * Messages render without per-message avatars — the sidecar header already
 * carries the Sketch icon + thread title, so repeating the avatar on every
 * reply in a narrow rail becomes noise.
 */
import { ChatInput } from "@/components/sketch/chat-input";
import { cn } from "@sketch/ui/lib/utils";
import { type MouseEvent as ReactMouseEvent, type ReactNode, useRef, useState } from "react";

/** Resizable width bounds for the chat rail — drag its right edge. */
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 400;
const MAX_WIDTH = 600;

export interface BuilderSidecarProps {
  /** The automation's title — the single title for this view (the canvas no
   *  longer carries its own header, so this is where it lives). */
  title: string;
}

export function BuilderSidecar({ title }: BuilderSidecarProps) {
  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  function startResize(e: ReactMouseEvent) {
    e.preventDefault();
    const left = asideRef.current?.getBoundingClientRect().left ?? 0;
    const onMove = (ev: MouseEvent) => {
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX - left)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <aside
      ref={asideRef}
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-background"
      style={{ width, borderRightWidth: "0.5px" }}
    >
      <SidecarHeader title={title} />
      <div className="relative min-h-0 flex-1">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[24px] bg-gradient-to-b from-background to-transparent"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[24px] bg-gradient-to-t from-background to-transparent"
          aria-hidden
        />
        {/* pb clears the bottom fade so the last message sits fully above the
         *  gradient instead of being clipped by it. */}
        <div className="scrollbar-subtle absolute inset-0 overflow-y-auto px-[16px] pt-[14px] pb-[30px]">
          <div className="flex flex-col gap-[16px]">
            <SidecarUserMessage>
              I want to do a better job celebrating customer wins inside the team. Right now they just sit in a tab no
              one's looking at.
            </SidecarUserMessage>
            <SidecarSketchMessage>
              Which source has the most signal — Trustpilot, the App Store, Intercom, somewhere else?
            </SidecarSketchMessage>
            <SidecarUserMessage>
              Trustpilot. The five-star ones especially — those land hardest internally.
            </SidecarUserMessage>
            <SidecarSketchMessage>
              Got it. And where should they show up — a Slack channel, a weekly digest, somewhere quieter?
            </SidecarSketchMessage>
            <SidecarUserMessage>
              Slack. There's already a #design-wins channel that's basically tumbleweeds — want to bring it back to
              life.
            </SidecarUserMessage>
            <SidecarSketchMessage>
              Makes sense. Want every five-star review routed there, or only the ones that actually mention design?
            </SidecarSketchMessage>
            <SidecarUserMessage>
              Whenever we get a five-star Trustpilot review mentioning design, share it in #design-wins.
            </SidecarUserMessage>
            <SidecarSketchMessage>On it — let me sketch that out.</SidecarSketchMessage>
            <SidecarUserMessage>Also DM me when one fires, don't want to miss the moment.</SidecarUserMessage>
            <SidecarSketchMessage>All set — here's the draft. Tweak anything before I save it.</SidecarSketchMessage>
            <SidecarUserMessage>
              Actually — only reviews longer than two sentences. Don't want to flood it with one-liners.
            </SidecarUserMessage>
            <SidecarSketchMessage>Smart. Added a min-length filter on the trigger. Anything else?</SidecarSketchMessage>
            <SidecarUserMessage>And run it daily at 9am instead of instantly.</SidecarUserMessage>
            <SidecarSketchMessage>
              Batched it to a 9am daily run. Take another look at the canvas — you'll see both changes.
            </SidecarSketchMessage>
          </div>
        </div>
      </div>
      <div className="shrink-0 bg-background px-[14px] pt-[10px] pb-[14px]">
        <ChatInput placeholder="Reply to Sketch…" inputClassName="text-[13px]" />
      </div>

      {/* Drag the right edge to resize the rail within [320, 600]px. */}
      <button
        type="button"
        aria-label="Resize chat"
        onMouseDown={startResize}
        className="absolute inset-y-0 right-0 z-20 w-1.5 translate-x-1/2 cursor-col-resize bg-transparent transition-colors hover:bg-border"
      />
    </aside>
  );
}

function SidecarUserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[88%] rounded-[12px] border border-border",
          "bg-muted",
          "px-[14px] py-[8px] text-[13px] text-foreground",
        )}
        style={{ lineHeight: 1.55 }}
      >
        {children}
      </div>
    </div>
  );
}

function SidecarSketchMessage({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[90%] text-[13px] text-foreground" style={{ lineHeight: 1.6 }}>
      {children}
    </div>
  );
}

/**
 * Sidecar header — the single title for the whole view (the canvas dropped its
 * own header). Deliberately slim and borderless: no bottom rule, so there's no
 * stray horizontal line dead-ending into the chat/canvas divider, and the top
 * fade does the work of separating it from the messages.
 */
function SidecarHeader({ title }: { title: string }) {
  return (
    <div className="flex h-[44px] shrink-0 items-center px-[16px]">
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/85 leading-tight">{title}</h2>
    </div>
  );
}
