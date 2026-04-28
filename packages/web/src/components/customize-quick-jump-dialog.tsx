/**
 * CustomizeQuickJumpDialog — pick + reorder up to 4 dashboard shortcuts to show
 * on the home page's Quick jump section. Triggered by the "Edit" button or by
 * clicking an empty "Add" slot. Persists hrefs to localStorage via the parent.
 */
import { type NavItem, getDashboardNav } from "@/lib/dashboard-nav";
import { DotsSixVerticalIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { cn } from "@sketch/ui/lib/utils";
import type React from "react";
import { useEffect, useState } from "react";

const MAX_SHORTCUTS = 4;
/** Routes excluded from the picker — you can't shortcut to a page you're already on. */
const HIDDEN_HREFS = new Set(["/home"]);

export function CustomizeQuickJumpDialog({
  open,
  initialHrefs,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  initialHrefs: string[];
  onOpenChange: (open: boolean) => void;
  onSave: (hrefs: string[]) => void;
}) {
  const allNav = getDashboardNav(16);
  const [selected, setSelected] = useState<string[]>(initialHrefs);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  // Reset to initial state every time the dialog opens — discards uncommitted edits.
  useEffect(() => {
    if (open) {
      setSelected(initialHrefs);
      setDraggedIndex(null);
    }
  }, [open, initialHrefs]);

  const navByHref = new Map(allNav.map((n) => [n.href, n] as const));
  const selectedItems = selected.map((href) => navByHref.get(href)).filter((x): x is NavItem => x != null);
  const available = allNav.filter((n) => !selected.includes(n.href) && !HIDDEN_HREFS.has(n.href));

  const canAddMore = selected.length < MAX_SHORTCUTS;

  const handleAdd = (href: string) => {
    if (!canAddMore) return;
    setSelected([...selected, href]);
  };
  const handleRemove = (href: string) => {
    setSelected(selected.filter((h) => h !== href));
  };

  const handleDragStart = (idx: number) => setDraggedIndex(idx);
  const handleDragOver = (e: React.DragEvent, overIdx: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === overIdx) return;
    const next = [...selected];
    const [moved] = next.splice(draggedIndex, 1);
    if (moved !== undefined) next.splice(overIdx, 0, moved);
    setSelected(next);
    setDraggedIndex(overIdx);
  };
  const handleDragEnd = () => setDraggedIndex(null);

  const handleSave = () => {
    onSave(selected);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Customize Quick jump</DialogTitle>
          <DialogDescription>Pick up to 4 shortcuts for your home page. Drag to reorder.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">
              Selected · {selected.length} of {MAX_SHORTCUTS}
            </p>
            {selectedItems.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No shortcuts yet — pick from below.</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {selectedItems.map((item, idx) => (
                  <li
                    key={item.href}
                    draggable
                    onDragStart={() => handleDragStart(idx)}
                    onDragOver={(e) => handleDragOver(e, idx)}
                    onDragEnd={handleDragEnd}
                    className={cn(
                      "flex cursor-move items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 transition-opacity",
                      draggedIndex === idx ? "opacity-40" : "opacity-100",
                    )}
                  >
                    <DotsSixVerticalIcon size={14} className="text-muted-foreground" />
                    <span className="text-muted-foreground">{item.icon}</span>
                    <span className="flex-1 text-sm">{item.label}</span>
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-[#8B7A00] dark:hover:text-[#FEED01]"
                      onClick={() => handleRemove(item.href)}
                      aria-label={`Remove ${item.label}`}
                    >
                      <XIcon size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">Available</p>
            {available.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">All routes added.</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {available.map((item) => (
                  <li
                    key={item.href}
                    className="flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5"
                  >
                    <span className="text-muted-foreground">{item.icon}</span>
                    <span className="flex-1 text-sm">{item.label}</span>
                    <button
                      type="button"
                      disabled={!canAddMore}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-[#8B7A00] disabled:cursor-not-allowed disabled:opacity-30 dark:hover:text-[#FEED01]"
                      onClick={() => handleAdd(item.href)}
                      aria-label={`Add ${item.label}`}
                    >
                      <PlusIcon size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
