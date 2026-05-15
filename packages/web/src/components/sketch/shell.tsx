/**
 * SketchShell — the layout wrapper used by every spec route.
 *
 * Renders the new sidebar (§4.1) on the left and the main pane on the right.
 *
 * Top chrome (trial ticker + optional banner) lives in a single sticky region
 * at the top of the main pane so:
 *   - both stay pinned while content scrolls underneath
 *   - when the trial ticker has nothing to render, no empty padded row is
 *     reserved above the banner — the banner sits flush to the top edge.
 */
import { SketchSidebar, type SketchSidebarProps } from "@/components/sketch/sidebar";
import { SidebarStateProvider } from "@/components/sketch/sidebar-context";
import { TrialTicker } from "@/components/trial-banner";
import { useTrialBanner } from "@/lib/use-trial-banner";
import { cn } from "@sketch/ui/lib/utils";
import type { ReactNode } from "react";

interface SketchShellProps extends SketchSidebarProps {
  /** Optional top banner rendered at the top of the main pane. */
  banner?: ReactNode;
  /** Main pane content. */
  children: ReactNode;
  /** Forces the sidebar collapsed for this page (used by /home/default-collapsed demo). */
  forceCollapsed?: boolean;
  /** Optional extra classes on the main scroll container. */
  mainClassName?: string;
}

export function SketchShell({ banner, children, forceCollapsed, mainClassName, ...sidebarProps }: SketchShellProps) {
  const trialVisible = useTrialTickerVisible();

  return (
    <SidebarStateProvider forceCollapsed={forceCollapsed}>
      <div className="flex h-screen w-full bg-background text-foreground">
        <SketchSidebar {...sidebarProps} />
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Sticky top chrome — trial ticker (when present) stacked above the
           * banner (when present). Wrapping both in one sticky container keeps
           * them visually fused as a single header region; when the trial
           * ticker is null, the padded chrome row disappears entirely so the
           * banner sits flush to the viewport's top edge. */}
          <div className="sticky top-0 z-20 bg-background">
            {trialVisible && (
              <div className="px-3 py-2">
                <TrialTicker />
              </div>
            )}
            {banner}
          </div>
          {/* Block-mode scroll container (not flex) so children with
           * `mx-auto max-w-4xl` actually stretch to the parent width instead
           * of shrinking to their content. */}
          <div className={cn("relative min-h-0 flex-1 overflow-y-auto", mainClassName)}>{children}</div>
        </main>
      </div>
    </SidebarStateProvider>
  );
}

/**
 * Mirrors the visibility logic inside TrialTickerBanner so the shell can skip
 * rendering the padded sticky row when the ticker has nothing to show.
 *
 * Includes the same `?trial=<n>` preview override that TrialTicker reads, so
 * the demo URL parameter behaves consistently — the shell, like the ticker,
 * shows chrome when a preview is active.
 */
function useTrialTickerVisible(): boolean {
  const trial = useTrialBanner();
  // Preview override — same shape as usePreviewOverride() inside trial-banner.tsx.
  // Duplicated here (rather than imported) because the helper isn't exported,
  // and the logic is two lines of URL parsing.
  if (typeof window !== "undefined") {
    const raw = new URLSearchParams(window.location.search).get("trial");
    if (raw === "none") return false;
    if (raw !== null) {
      const days = Number.parseInt(raw, 10);
      if (!Number.isNaN(days) && days >= 0 && days <= 15) return true;
    }
  }
  if (trial.state === "none") return false;
  if (trial.state === "celebration" && trial.dismissed) return false;
  return true;
}
