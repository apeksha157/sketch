/**
 * Snippet-first evidence rows shared by every decision surface (graph-verdict
 * sheet, reconcile sheet, birth inspect). The quote is the row's content; the
 * file name drops to the attribution line — same inversion as the drawer
 * timeline, so evidence reads identically wherever a decision is made.
 */
import { EntryList, formatRelative } from "@/components/entity-drawer/drawer-kit";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";

export interface EvidenceListItem {
  key: string;
  snippet: string | null;
  fileName: string;
  source: string | null;
  occurredAt: string | null;
  href?: string | null;
}

function attribution(item: EvidenceListItem): string {
  const parts: string[] = [];
  if (item.snippet) parts.push(item.fileName);
  if (item.source) parts.push(item.source.replace(/_/g, " "));
  if (item.occurredAt) parts.push(formatRelative(item.occurredAt));
  return parts.join(" · ");
}

export function EvidenceList({ items, testId }: { items: EvidenceListItem[]; testId?: string }) {
  return (
    <EntryList>
      {items.map((item) => (
        <li key={item.key} data-testid={testId ? `${testId}-${item.key}` : undefined}>
          <div className="flex w-full flex-col gap-0.5 px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <p
                className={cn(
                  "min-w-0 flex-1 text-[12.5px] leading-snug text-foreground",
                  item.snippet ? "line-clamp-2" : "truncate font-medium",
                )}
              >
                {item.snippet ?? item.fileName}
              </p>
              {item.href ? (
                <a
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${item.fileName}`}
                  className="shrink-0 pt-0.5 text-muted-foreground hover:text-foreground"
                >
                  <ArrowSquareOutIcon size={12} />
                </a>
              ) : null}
            </div>
            {attribution(item) ? (
              <p className="truncate text-[11px] text-muted-foreground">{attribution(item)}</p>
            ) : null}
          </div>
        </li>
      ))}
    </EntryList>
  );
}
