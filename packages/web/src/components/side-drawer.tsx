/**
 * Side-drawer standard — the single source of truth for every right-hand drawer
 * in the dashboard (node config, entity detail, file detail, scheduled-task
 * detail, …). Drawers should NOT hand-roll their own width or resize logic; they
 * import from here so the whole product shares one structure, size, and feel.
 *
 * The rule:
 *   • Width — default 440px, draggable between 360 (min) and 720 (max), never
 *     past 90vw on small screens. 440 is wide enough for forms/editors without
 *     crowding the page behind it.
 *   • Anchoring — right side, full height.
 *   • Structure — a borderless header zone (title + close + any meta/controls),
 *     then scrollable body. Header padding is 16px (p-4); the close ✕ sits in the
 *     top-right corner (SheetContent's default). Body owns its own padding.
 *   • Resize — drag the left edge. Width is per-instance state (not persisted yet).
 *
 * Usage:
 *   const { width, startResize } = useDrawerWidth();
 *   <Sheet open={open} onOpenChange={...}>
 *     <ResizableSheetContent width={width} onResizeStart={startResize}>
 *       <SheetHeader className="p-4">…</SheetHeader>
 *       <div className="min-h-0 flex-1 overflow-y-auto">…</div>
 *     </ResizableSheetContent>
 *   </Sheet>
 */
import { SheetContent } from "@sketch/ui/components/sheet";
import { cn } from "@sketch/ui/lib/utils";
import type * as React from "react";
import { useCallback, useState } from "react";

/** The product-wide width rule for right drawers. */
export const SIDE_DRAWER_WIDTH = {
  default: 440,
  min: 360,
  max: 720,
  /** Hard cap relative to the viewport, so the drawer never swallows the page. */
  viewportMax: 0.9,
} as const;

/**
 * Resizable-width state for a side drawer. Returns the current width and a
 * mousedown handler to wire onto the drag handle (the handle itself ships with
 * `ResizableSheetContent`). Clamps to the standard min/max and the viewport cap.
 */
export function useDrawerWidth(initial: number = SIDE_DRAWER_WIDTH.default) {
  const [width, setWidth] = useState(initial);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const max = Math.min(SIDE_DRAWER_WIDTH.max, Math.round(window.innerWidth * SIDE_DRAWER_WIDTH.viewportMax));
    const onMove = (ev: MouseEvent) => {
      const next = window.innerWidth - ev.clientX;
      setWidth(Math.min(max, Math.max(SIDE_DRAWER_WIDTH.min, next)));
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
  }, []);

  return { width, startResize };
}

/**
 * The standard right-drawer surface: a `SheetContent` fixed to the resizable
 * width, capped at the viewport max, laid out as a flex column with no built-in
 * padding (the header/body control their own), plus the left-edge drag handle.
 * Forwards all other SheetContent props (e.g. `showCloseButton`).
 */
export function ResizableSheetContent({
  width,
  onResizeStart,
  className,
  children,
  ...props
}: React.ComponentProps<typeof SheetContent> & {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
}) {
  return (
    <SheetContent
      className={cn("flex w-full flex-col gap-0 p-0", className)}
      style={{ width: `${width}px`, maxWidth: `${SIDE_DRAWER_WIDTH.viewportMax * 100}vw` }}
      {...props}
    >
      <button
        type="button"
        aria-label="Resize drawer"
        onMouseDown={onResizeStart}
        className="absolute inset-y-0 left-0 z-50 w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-border"
      />
      {children}
    </SheetContent>
  );
}
