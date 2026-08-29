/**
 * The shared bordered entity table (column header + rows) and the single row
 * component. Extracted from the retired Files → Entities explorer; the Your
 * Org tabs, projects tree, and org-wide search all render entities through
 * these so the columns never drift apart.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import { humanSourceType } from "@/components/entity-review/entity-format";
import type { EntityListItem } from "@/lib/api";
import { formatRelativeTime } from "@/routes/files/file-list";
import { CubeIcon, UserIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { cn } from "@sketch/ui/lib/utils";
import type { HTMLAttributes, ReactNode } from "react";

/** Derive the connector source from entity sourceType (e.g., "clickup_space" → "clickup"). */
function sourceFromType(sourceType: string): string | null {
  if (sourceType.startsWith("clickup_")) return "clickup";
  if (sourceType.startsWith("notion_")) return "notion";
  if (sourceType.startsWith("linear_")) return "linear";
  if (sourceType.startsWith("google_drive")) return "google_drive";
  return null;
}

function entityContext(entity: EntityListItem): string | null {
  if (entity.sourceType === "person") {
    if (entity.subtype === "internal") return "Internal";
    return "External";
  }
  const m = entity.metadata;
  if (!m) return null;
  if (m.workspaceName) {
    if (m.spaceName) return `${m.workspaceName} / ${m.spaceName}`;
    return m.workspaceName as string;
  }
  if (entity.sourceType === "clickup_workspace") return null;
  if (m.path) return m.path as string;
  if (m.parentPage) return m.parentPage as string;
  if (entity.sourceType === "company" && entity.subtype) {
    return entity.subtype.charAt(0).toUpperCase() + entity.subtype.slice(1);
  }
  return null;
}

function isAiDiscovered(entity: EntityListItem): boolean {
  return entity.metadata?.origin === "ai";
}

export function EntityTable({ entities, onSelect }: { entities: EntityListItem[]; onSelect: (id: string) => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border" data-testid="entities-table">
      <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <span className="min-w-0 flex-1">Name</span>
        <span className="w-32 text-center">Type</span>
        <span className="w-16 text-center">Mentions</span>
        <span className="w-20 text-center">Status</span>
        <span className="w-24 text-right">Last Active</span>
      </div>
      {entities.map((entity) => (
        <EntityRow key={entity.id} entity={entity} onSelect={onSelect} />
      ))}
    </div>
  );
}

export function EntityRow({
  entity,
  onSelect,
  depth = 0,
  leading,
  highlighted = false,
  dimmed = false,
  containerProps,
}: {
  entity: EntityListItem;
  onSelect: (id: string) => void;
  /** Tree indent level; shifts the whole row right by 20px per level. */
  depth?: number;
  /** Rendered before the row button — caret / drag grip slots. Must not contain the row's own click target. */
  leading?: ReactNode;
  highlighted?: boolean;
  dimmed?: boolean;
  containerProps?: HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
}) {
  const isPerson = entity.sourceType === "person";
  const source = sourceFromType(entity.sourceType);
  const context = entityContext(entity);

  return (
    <div
      {...containerProps}
      className={cn(
        "flex items-center border-b border-border last:border-b-0",
        highlighted && "bg-muted/60",
        dimmed && "opacity-50",
        containerProps?.className,
      )}
      style={depth > 0 ? { paddingLeft: depth * 20 } : undefined}
      data-testid={`entity-row-${entity.id}`}
    >
      {leading}
      <button
        type="button"
        onClick={() => onSelect(entity.id)}
        className="flex w-full min-w-0 flex-1 cursor-pointer items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/30"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isPerson ? (
            <UserIcon size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <CubeIcon size={14} className="shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{entity.name}</p>
            {context ? (
              <p className="truncate text-[11px] text-muted-foreground">{context}</p>
            ) : (
              entity.aliases.length > 0 && (
                <p className="truncate text-[11px] text-muted-foreground">aka {entity.aliases.join(", ")}</p>
              )
            )}
          </div>
        </div>

        <div className="flex w-32 items-center justify-center gap-1.5">
          {source && <ConnectorLogo type={source} size={14} className="shrink-0 text-muted-foreground" />}
          <Badge variant="outline" className="text-[10px]">
            {humanSourceType(entity.sourceType)}
          </Badge>
          {isAiDiscovered(entity) && (
            <Badge
              variant="secondary"
              className="text-[9px] px-1 py-0 bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300"
            >
              AI
            </Badge>
          )}
        </div>

        <span className="w-16 text-center text-xs font-mono text-muted-foreground">
          {entity.mentionCount > 0 ? entity.mentionCount : "-"}
        </span>

        <div className="flex w-20 items-center justify-center gap-1">
          <Badge
            variant={
              entity.status === "confirmed" ? "secondary" : entity.status === "tentative" ? "outline" : "destructive"
            }
            className="text-[10px]"
          >
            {entity.status}
          </Badge>
        </div>

        <div className="w-24 text-right">
          <span className="text-xs text-muted-foreground">
            {entity.lastMentionAt ? formatRelativeTime(entity.lastMentionAt) : "-"}
          </span>
        </div>
      </button>
    </div>
  );
}
