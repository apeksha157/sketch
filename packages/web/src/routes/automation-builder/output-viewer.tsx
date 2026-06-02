/**
 * Step output viewer — adapted from Canvas's UnifiedNodeDrawer OutputSection, but
 * fully themed with Sketch's tokens + font so it works in light AND dark mode.
 *
 * Keeps Canvas's structure (dark "OUTPUT" box → collapsible JSON tree → Tree/Raw
 * toggle → copy) and behaviour, but drops the variable-mapping machinery (path
 * picker, processed/variables modes, CSV) the linear v1 runtime doesn't need.
 */
import { BracketsCurlyIcon, CaretDownIcon, CaretRightIcon, CheckIcon, CodeIcon, CopyIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { useState } from "react";
import { STATUS_COLOR } from "./node-meta";
import type { StepRunResult } from "./types";

// Theme-aware JSON syntax classes (work on light + dark surfaces).
const SYNTAX = {
  key: "text-violet-600 dark:text-violet-300",
  string: "text-emerald-600 dark:text-emerald-400",
  number: "text-amber-600 dark:text-amber-400",
  bool: "text-sky-600 dark:text-sky-400",
  bracket: "text-muted-foreground",
  punct: "text-muted-foreground",
  preview: "text-muted-foreground",
} as const;

const INDENT = 14;
const ARRAY_CHUNK = 50;

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === "object";
}

function previewLabel(v: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(v)) return `[ ${v.length} item${v.length === 1 ? "" : "s"} ]`;
  const n = Object.keys(v).length;
  return `{ ${n} key${n === 1 ? "" : "s"} }`;
}

function primitiveClass(v: unknown): string {
  if (typeof v === "string") return SYNTAX.string;
  if (typeof v === "number") return SYNTAX.number;
  return SYNTAX.bool; // boolean | null
}

function CopyButton({ value, size = 12 }: { value: unknown; size?: number }) {
  const [copied, setCopied] = useState(false);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <button
      type="button"
      aria-label="Copy"
      className={cn(
        "ml-2 shrink-0 text-muted-foreground transition-colors hover:text-foreground",
        size <= 12 && "opacity-0 group-hover:opacity-100",
      )}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1000);
      }}
    >
      {copied ? <CheckIcon size={size} className="text-emerald-500" /> : <CopyIcon size={size} />}
    </button>
  );
}

function KeyLabel({ name }: { name: string | number }) {
  const isIndex = typeof name === "number";
  return (
    <>
      <span className={SYNTAX.key}>{isIndex ? name : `"${name}"`}</span>
      <span className={SYNTAX.punct}>: </span>
    </>
  );
}

function JsonNode({ name, value, depth }: { name?: string | number; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const padding = depth * INDENT;

  if (!isContainer(value)) {
    const display = typeof value === "string" ? `"${value}"` : String(value);
    return (
      <div className="group flex items-start" style={{ paddingLeft: padding }}>
        <span className="w-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          {name !== undefined && <KeyLabel name={name} />}
          <span className={primitiveClass(value)}>{display}</span>
        </div>
        <CopyButton value={value} />
      </div>
    );
  }

  const isArr = Array.isArray(value);
  const entries: [string | number, unknown][] = isArr
    ? value.map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const openBracket = isArr ? "[" : "{";
  const closeBracket = isArr ? "]" : "}";

  return (
    <div>
      <div className="group flex items-start" style={{ paddingLeft: padding }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-start text-left"
          aria-expanded={open}
        >
          <span className="mt-px w-4 shrink-0 text-muted-foreground">
            {open ? <CaretDownIcon size={11} weight="bold" /> : <CaretRightIcon size={11} weight="bold" />}
          </span>
          <span className="min-w-0 flex-1 break-words">
            {name !== undefined && <KeyLabel name={name} />}
            <span className={SYNTAX.bracket}>{openBracket}</span>
            {!open && (
              <>
                <span className={SYNTAX.preview}> {previewLabel(value)} </span>
                <span className={SYNTAX.bracket}>{closeBracket}</span>
              </>
            )}
          </span>
        </button>
        <CopyButton value={value} />
      </div>

      {open && <ChildList entries={entries} depth={depth} />}
      {open && (
        <div className="flex" style={{ paddingLeft: padding }}>
          <span className="w-4 shrink-0" aria-hidden />
          <span className={SYNTAX.bracket}>{closeBracket}</span>
        </div>
      )}
    </div>
  );
}

function ChildList({ entries, depth }: { entries: [string | number, unknown][]; depth: number }) {
  const [limit, setLimit] = useState(ARRAY_CHUNK);
  const shown = entries.slice(0, limit);
  const remaining = entries.length - limit;

  return (
    <>
      {shown.map(([k, v]) => (
        <JsonNode key={String(k)} name={k} value={v} depth={depth + 1} />
      ))}
      {remaining > 0 && (
        <div className="flex" style={{ paddingLeft: (depth + 1) * INDENT }}>
          <span className="w-4 shrink-0" aria-hidden />
          <button
            type="button"
            className="font-medium text-sky-600 hover:underline dark:text-sky-400"
            onClick={() => setLimit((l) => l + ARRAY_CHUNK)}
          >
            + Show {Math.min(ARRAY_CHUNK, remaining)} more
          </button>
        </div>
      )}
    </>
  );
}

function JsonTree({ data }: { data: unknown }) {
  if (isContainer(data)) {
    const entries: [string | number, unknown][] = Array.isArray(data)
      ? data.map((v, i) => [i, v])
      : Object.entries(data as Record<string, unknown>);
    return (
      <div>
        {entries.map(([k, v]) => (
          <JsonNode key={String(k)} name={k} value={v} depth={0} />
        ))}
      </div>
    );
  }
  return <JsonNode value={data} depth={0} />;
}

function ToggleButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-[26px] w-[30px] items-center justify-center transition-colors",
        active ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

type Coerced = { json: boolean; value: unknown; text: string };

function coerce(output: unknown): Coerced {
  if (isContainer(output)) return { json: true, value: output, text: JSON.stringify(output, null, 2) };
  if (typeof output === "string") {
    const t = output.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        const v = JSON.parse(t);
        if (isContainer(v)) return { json: true, value: v, text: JSON.stringify(v, null, 2) };
      } catch {
        // fall through to text
      }
    }
    return { json: false, value: output, text: output };
  }
  return { json: false, value: output, text: String(output) };
}

function OutputViewer({ output }: { output: unknown }) {
  const parsed = coerce(output);
  const [mode, setMode] = useState<"tree" | "raw">(parsed.json ? "tree" : "raw");

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/40">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="font-mono text-[11px] font-medium tracking-[0.06em] text-muted-foreground">OUTPUT</span>
        <div className="flex items-center gap-2">
          {parsed.json && (
            <div className="flex overflow-hidden rounded border border-border bg-muted">
              <ToggleButton active={mode === "tree"} onClick={() => setMode("tree")} label="Tree view">
                <BracketsCurlyIcon size={14} />
              </ToggleButton>
              <span className="w-px bg-border" aria-hidden />
              <ToggleButton active={mode === "raw"} onClick={() => setMode("raw")} label="Raw view">
                <CodeIcon size={14} />
              </ToggleButton>
            </div>
          )}
          <CopyButton value={parsed.text} size={14} />
        </div>
      </div>

      <div className="max-h-[360px] overflow-auto p-3 font-mono text-[12px] leading-relaxed text-foreground">
        {parsed.json && mode === "tree" ? (
          <JsonTree data={parsed.value} />
        ) : (
          <pre className="whitespace-pre-wrap break-words">{parsed.text}</pre>
        )}
      </div>
    </div>
  );
}

export function StepOutput({ run }: { run?: StepRunResult }) {
  if (!run) return <p className="text-sm text-muted-foreground">No run output yet.</p>;

  const hasOutput = run.output != null && run.output !== "";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-sm">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ backgroundColor: STATUS_COLOR[run.status] }} />
          {run.status}
        </span>
        {run.durationMs != null && <span className="text-muted-foreground">{run.durationMs} ms</span>}
      </div>

      {run.error ? (
        <pre className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {run.error}
        </pre>
      ) : hasOutput ? (
        <OutputViewer output={run.output} />
      ) : (
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <span className="text-xs text-muted-foreground">No output available yet. Run the node to see results.</span>
        </div>
      )}
    </div>
  );
}
