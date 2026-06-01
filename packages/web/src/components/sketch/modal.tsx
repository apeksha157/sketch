/**
 * Modal shell — §4.15. Centered overlay with backdrop.
 *
 * Routes call into this from CTAs (top-up credits, reconnect channel, confirm
 * dismiss). The body content of each named modal is a separate work item;
 * this primitive just provides the shape and dismiss wiring.
 */
import { Dialog, DialogContent } from "@sketch/ui/components/dialog";
import { cn } from "@sketch/ui/lib/utils";
import type { ReactNode } from "react";

export interface SketchModalProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Accessible name for the dialog. */
  title: string;
  children: ReactNode;
  className?: string;
}

export function SketchModal({ open, onOpenChange, title, children, className }: SketchModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        aria-label={title}
        className={cn("max-w-[440px] rounded-[12px] bg-card border-border p-[24px]", className)}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
