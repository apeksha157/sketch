/**
 * SketchShell — the layout wrapper used by every spec route.
 *
 * Renders the new sidebar (§4.1) on the left and the main pane on the right.
 * Banner is an optional slot that sits at the top of the main pane (not over
 * the sidebar), and content fills the remaining space inside a scroll
 * container.
 */
import { SketchSidebar, type SketchSidebarProps } from "@/components/sketch/sidebar";
import { SidebarStateProvider } from "@/components/sketch/sidebar-context";
import { TrialTicker } from "@/components/trial-banner";
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
  return (
    <SidebarStateProvider forceCollapsed={forceCollapsed}>
      <div className="flex h-screen w-full bg-background text-foreground">
        <SketchSidebar {...sidebarProps} />
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Sticky trial-ticker strip — mirrors DashboardLayout so the greeting
           * sits at the same vertical position as every other dashboard page.
           * TrialTicker collapses to null when state === "none", but the
           * px-3 py-2 wrapper reserves the same chrome height either way. */}
          <div className="sticky top-0 z-20 bg-background px-3 py-2">
            <TrialTicker />
          </div>
          {banner}
          {/* Block-mode scroll container (not flex) so children with
           * `mx-auto max-w-4xl` actually stretch to the parent width instead
           * of shrinking to their content. */}
          <div className={cn("relative min-h-0 flex-1 overflow-y-auto", mainClassName)}>{children}</div>
        </main>
      </div>
    </SidebarStateProvider>
  );
}
