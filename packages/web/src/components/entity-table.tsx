/**
 * The shared bordered entity table (column header + rows) and the single row
 * component. The Your Org tabs, projects tree, and org-wide search all render
 * entities through these so the columns never drift apart. Rows render through
 * {@link OrgRow}, the one row primitive for the surface — same avatar size,
 * type scale, and density as the People directory.
 *
 * There is no Status column: nearly every listed entity is "confirmed", and
 * the drawer carries the exceptional states.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import { humanSourceType } from "@/components/entity-review/entity-format";
import { AiBadge, OrgListHeader, OrgRow } from "@/components/org-row";
import type { EntityListItem } from "@/lib/api";
import { EntityAvatar, entityDisplayLabel } from "@/lib/entity-ui";
import { formatRelativeTime } from "@/lib/time";
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

export const ENTITY_TABLE_COLUMNS = [
  { label: "Name", className: "min-w-0 flex-1" },
  { label: "Type", className: "w-32 text-center" },
  { label: "Mentions", className: "w-14 text-center" },
  { label: "Active", className: "w-16 text-right" },
];

export function EntityTable({ entities, onSelect }: { entities: EntityListItem[]; onSelect: (id: string) => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border" data-testid="entities-table">
      <OrgListHeader columns={ENTITY_TABLE_COLUMNS} />
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
  const source = sourceFromType(entity.sourceType);
  const context = entityContext(entity);

  return (
    <OrgRow
      testId={`entity-row-${entity.id}`}
      onOpen={() => onSelect(entity.id)}
      className={cn(highlighted && "bg-muted/60", dimmed && "opacity-50")}
      leading={leading}
      containerProps={{
        ...containerProps,
        style: depth > 0 ? { paddingLeft: depth * 20, ...containerProps?.style } : containerProps?.style,
      }}
      avatar={<EntityAvatar entity={{ id: entity.id, name: entity.name, sourceType: entity.sourceType }} size="sm" />}
      primary={entityDisplayLabel(entity)}
      primaryChips={isAiDiscovered(entity) ? <AiBadge /> : null}
      secondary={context ?? (entity.aliases.length > 0 ? `aka ${entity.aliases.join(", ")}` : null)}
      meta={
        <>
          <span className="flex w-32 items-center justify-center gap-1.5">
            {source && <ConnectorLogo type={source} size={12} className="shrink-0 text-muted-foreground" />}
            <Badge variant="outline" className="text-[9px] uppercase tracking-wider text-muted-foreground">
              {humanSourceType(entity.sourceType)}
            </Badge>
          </span>
          <span className="w-14 text-center font-mono text-xs text-muted-foreground">
            {entity.mentionCount > 0 ? entity.mentionCount : "-"}
          </span>
          <span className="w-16 text-right text-xs text-muted-foreground">
            {entity.lastMentionAt ? formatRelativeTime(entity.lastMentionAt) : "-"}
          </span>
        </>
      }
    />
  );
}
