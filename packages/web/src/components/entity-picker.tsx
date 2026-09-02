/**
 * Reusable entity picker for ECR-03's "Pick a different existing" flow.
 *
 * Search box + filtered results. Hits the existing
 * `GET /api/entities?type=...&search=...` endpoint (no new route — see
 * ECR-03 §"Codebase-shape prerequisites" §3). Filters by the supplied
 * `entityType` so the picker never returns mismatched types — defence in
 * depth against the backend's TYPE_MISMATCH 422.
 */
import { OrgRow } from "@/components/org-row";
import { api } from "@/lib/api";
import type { EntityListItem } from "@/lib/api";
import { EntityAvatar } from "@/lib/entity-ui";
import { formatRelativeTime } from "@/lib/time";
import { Input } from "@sketch/ui/components/input";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

interface EntityPickerProps {
  entityType: string;
  /** Suppress this entity id from results (e.g. the suggested candidate). */
  excludeEntityId?: string;
  onPick: (entityId: string, entity: EntityListItem) => void;
  placeholder?: string;
}

export function EntityPicker({ entityType, excludeEntityId, onPick, placeholder }: EntityPickerProps) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search.trim()), 150);
    return () => clearTimeout(handle);
  }, [search]);

  const { data, isFetching } = useQuery({
    queryKey: ["entity-picker", entityType, debounced],
    queryFn: () =>
      api.entities.list({
        type: entityType,
        search: debounced,
        limit: 10,
      }),
    enabled: debounced.length > 0,
  });

  const results = (data?.entities ?? []).filter((e) => e.id !== excludeEntityId);

  return (
    <div className="flex flex-col gap-2" data-testid="entity-picker">
      <Input
        ref={inputRef}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={placeholder ?? `Search ${entityType}s…`}
        autoFocus
        aria-label="Entity search"
      />
      {debounced.length > 0 ? (
        <div className="rounded-md border bg-popover text-sm max-h-64 overflow-y-auto">
          {isFetching && results.length === 0 ? (
            <div className="px-3 py-2 text-muted-foreground">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-muted-foreground">No matches</div>
          ) : (
            results.map((entity) => (
              <EntityRow key={entity.id} entity={entity} onPick={() => onPick(entity.id, entity)} />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Candidate rows carry the Your Org row anatomy so bare names are tellable
 * apart before picking: email, mention volume, and recency ride under the
 * name — all from the list response the picker already fetches.
 */
function EntityRow({ entity, onPick }: { entity: EntityListItem; onPick: () => void }) {
  const contactPoints = entity.contactPoints ?? [];
  const email =
    contactPoints.find((point) => point.kind === "email" && point.isPrimary)?.value ??
    contactPoints.find((point) => point.kind === "email")?.value ??
    readEmail(entity.metadata);
  const parts: string[] = [];
  if (email) parts.push(email);
  if (entity.mentionCount > 0)
    parts.push(`${entity.mentionCount} ${entity.mentionCount === 1 ? "mention" : "mentions"}`);
  if (entity.lastMentionAt) parts.push(`last seen ${formatRelativeTime(entity.lastMentionAt)}`);
  return (
    <OrgRow
      avatar={<EntityAvatar entity={{ id: entity.id, name: entity.name, sourceType: entity.sourceType }} size="sm" />}
      primary={entity.name}
      secondary={parts.length > 0 ? parts.join(" · ") : null}
      onOpen={onPick}
      testId={`entity-picker-row-${entity.id}`}
    />
  );
}

function readEmail(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const value = metadata.email;
  return typeof value === "string" && value.length > 0 ? value : null;
}
