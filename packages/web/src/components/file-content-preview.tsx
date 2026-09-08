/**
 * The one renderer for a file's stored text. Shared by the Files page sheet
 * and the entity timeline's inline expansion so both clamp, toggle and cap
 * height identically — a long email thread can never swallow its host.
 *
 * `heading={null}` drops the label for hosts that already say what the block
 * is (the timeline row's own line two).
 */
import { useState } from "react";

const CONTENT_PREVIEW_LIMIT = 2000;

export function FileContentPreview({ content, heading = "Content" }: { content: string; heading?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > CONTENT_PREVIEW_LIMIT;
  const displayContent = expanded || !isLong ? content : `${content.slice(0, CONTENT_PREVIEW_LIMIT)}…`;

  return (
    <div>
      {heading ? (
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{heading}</p>
      ) : null}
      <pre
        className={`mt-1 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap ${expanded ? "max-h-[70vh]" : "max-h-96"}`}
      >
        {displayContent}
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[11px] text-primary hover:underline"
        >
          {expanded ? "Show less" : `Show full content (${(content.length / 1000).toFixed(1)}k chars)`}
        </button>
      )}
    </div>
  );
}
