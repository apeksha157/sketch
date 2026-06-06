import { ResizableSheetContent, useDrawerWidth } from "@/components/side-drawer";
/**
 * Node config drawer. Click a node on the canvas to open it. Shows the per-step
 * config (Input tab) and the last run result (Output tab). Prototype: fields are
 * editable in-place but nothing persists yet — the wiring step adds the PUT calls.
 */
import { CheckCircleIcon, CircleDashedIcon, SpinnerGapIcon, XCircleIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Input } from "@sketch/ui/components/input";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@sketch/ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sketch/ui/components/tabs";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { cn } from "@sketch/ui/lib/utils";
import { Suspense, lazy } from "react";
import { TYPE_LABEL, appLabel, stepConnections } from "./node-meta";
import { StepOutput } from "./output-viewer";
import { RunButton, formatDuration } from "./run-controls";
import type { AutomationStep, RunStatus, StepNodeData, StepRunResult } from "./types";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

const EDITOR_LINE_HEIGHT = 20;

const STATUS_VERB: Record<RunStatus, string> = {
  success: "Succeeded",
  failed: "Failed",
  running: "Running",
  idle: "Not run yet",
};

/**
 * Tab in the product mono (IBM Plex Mono) — UPPERCASE, like every other mono
 * label (PROMPT, USES, SCRIPT). No underline indicator: the selected tab is
 * marked by weight + contrast (semibold, full foreground) against the muted
 * inactive tabs — no brand gold.
 */
const TAB_TRIGGER =
  "rounded-none border-0 bg-transparent px-0 py-1.5 font-mono text-[13px] font-medium uppercase tracking-[0.08em] text-muted-foreground shadow-none transition-colors data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none";

/**
 * The editor fills whatever vertical space the drawer gives it (rather than a
 * fixed, internally-scrolling box that leaves the panel half-empty). It only
 * scrolls when the content actually exceeds the available height.
 *
 * `prose` mode is for natural-language prompts: it strips the code chrome (the
 * line-number gutter, the current-line highlight band, syntax colouring) so the
 * prompt reads as a writing surface, not source code. Action scripts leave it
 * off and keep the real editor furniture. Both get interior padding so text
 * never kisses the border.
 */
function CodeBlock({
  value,
  language,
  monacoTheme,
  prose = false,
}: {
  value: string;
  language: string;
  monacoTheme: string;
  prose?: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-card/40">
      <Suspense fallback={<div className="p-3 text-xs text-muted-foreground">Loading editor…</div>}>
        <MonacoEditor
          loading={null}
          height="100%"
          value={value}
          language={language}
          theme={monacoTheme}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: EDITOR_LINE_HEIGHT,
            // Use the product mono (IBM Plex Mono) instead of the editor's default
            // "Monaco"/"Menlo" stack, so code matches the rest of the app's type.
            fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
            // Prompts: no gutter, no line-highlight band — just text. Scripts keep
            // the numbered gutter so line references make sense.
            lineNumbers: prose ? "off" : "on",
            lineNumbersMinChars: prose ? 0 : 3,
            lineDecorationsWidth: prose ? 16 : 8,
            glyphMargin: false,
            folding: !prose,
            renderLineHighlight: "none",
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            // Top/bottom breathing room inside the box (Monaco draws content flush
            // to the edge otherwise).
            padding: { top: 14, bottom: 14 },
            scrollbar: { horizontal: "hidden", verticalScrollbarSize: 8, useShadows: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            readOnly: false,
          }}
        />
      </Suspense>
    </div>
  );
}

/**
 * Section label — small uppercase IBM Plex Mono, matching the OUTPUT box's label
 * (output-viewer.tsx). Using the product's mono face for technical labels gives
 * the drawer a deliberate "spec sheet" character and ties it to the code editors
 * and output panel, instead of generic sans micro-text.
 */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </span>
  );
}

/** `grow` makes the section fill remaining height (for the prompt/script editor). */
function Section({ label, children, grow = false }: { label: string; children: React.ReactNode; grow?: boolean }) {
  return (
    <div className={cn(grow ? "flex min-h-0 flex-1 flex-col gap-2" : "space-y-2")}>
      <SectionLabel>{label}</SectionLabel>
      {children}
    </div>
  );
}

/** Status glyph — inherits the pill's colour so icon + label read as one chip. */
function StatusGlyph({ status }: { status: RunStatus }) {
  if (status === "success") return <CheckCircleIcon size={13} weight="fill" />;
  if (status === "failed") return <XCircleIcon size={13} weight="fill" />;
  if (status === "running") return <SpinnerGapIcon size={13} className="animate-spin" />;
  return <CircleDashedIcon size={13} />;
}

/**
 * Status as a semantic-coloured chip — green succeeded, red failed, neutral
 * running/not-run. It mirrors the type tag's pill shape so the meta row reads as
 * one cohesive set of chips, and it carries the colour the header was missing.
 * Duration rides inside, dimmed, so it doesn't shout in the same hue.
 */
const STATUS_PILL: Record<RunStatus, string> = {
  success: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  running: "bg-secondary text-foreground",
  idle: "bg-muted text-muted-foreground",
};

function StatusPill({ run }: { run: StepRunResult }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        STATUS_PILL[run.status],
      )}
    >
      <StatusGlyph status={run.status} />
      <span>{STATUS_VERB[run.status]}</span>
      {run.durationMs != null && run.status !== "idle" && (
        <span className="opacity-60">· {formatDuration(run.durationMs)}</span>
      )}
    </span>
  );
}

/**
 * "Uses" — the external apps/integrations a step touches, in plain language.
 * Replaces the old per-type chips (`mode: sketch`, bare `sheets`); one label, one
 * language, shown only when a step actually reaches out to something.
 */
function UsesRow({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <Section label="Uses">
      <div className="flex flex-wrap gap-1.5">
        {items.map((app) => (
          <Badge key={app} variant="secondary" className="rounded-md px-2 py-0.5 text-xs font-normal">
            {appLabel(app)}
          </Badge>
        ))}
      </div>
    </Section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Section label={label}>
      <Input defaultValue={value} className="h-9 text-[13px]" />
    </Section>
  );
}

/**
 * The step type as a small tag in the meta row (next to status) — not an eyebrow
 * on its own row above the title. Mono uppercase so it reads as a system/type
 * label, distinct from the sans app chips in "Uses".
 */
function TypeTag({ type }: { type: AutomationStep["type"] }) {
  return (
    <Badge
      variant="secondary"
      className="rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em]"
    >
      {TYPE_LABEL[type]}
    </Badge>
  );
}

export function NodeDrawer({
  data,
  onClose,
  onRun,
  running = false,
}: {
  data: StepNodeData | null;
  onClose: () => void;
  onRun?: () => void;
  running?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "light";
  const { width, startResize } = useDrawerWidth();

  const step = data?.step;
  const content = data?.content;
  const run = data?.run;

  // Test runs only this node. Filled (no stroke), standard h-7 height to match the
  // product's other buttons, neutral grey fill (`secondary`) so it stays
  // subordinate to the page's solid Run without the brand gold. Mono uppercase.
  const testButton = onRun ? (
    <RunButton
      running={running}
      onRun={onRun}
      size="sm"
      variant="secondary"
      label="Test"
      runningLabel="Testing…"
      className="font-mono uppercase tracking-[0.08em]"
    />
  ) : null;

  return (
    <Sheet open={!!data} onOpenChange={(open) => !open && onClose()}>
      <ResizableSheetContent width={width} onResizeStart={startResize}>
        {/* Top section, part 1: title + meta chips. The close ✕ is the Sheet's
         *  default, pinned in the top-right corner (chrome) — Test lives down on
         *  the tab row, so the dismiss control and the action don't share a spot.
         *  Bottom padding is tuned so the gap to the tab row lands on the same
         *  12px rhythm — title, chips and tabs read as ONE block. */}
        <SheetHeader className="gap-1.5 p-4 pb-1.5">
          <SheetTitle className="pr-8 text-left text-[17px] font-semibold leading-snug">{step?.label}</SheetTitle>
          {/* -ml-1.5 cancels the first chip's left padding so the chip *text*
           *  lines up with the title above and the tabs below (optical
           *  alignment), instead of being inset by the pill's padding. */}
          <div className="-ml-1.5 flex flex-wrap items-center gap-2">
            {step && <TypeTag type={step.type} />}
            {run && <StatusPill run={run} />}
          </div>
          <SheetDescription className="sr-only">Step configuration</SheetDescription>
        </SheetHeader>

        {step && (
          <Tabs
            key={step.id}
            defaultValue={run?.status === "failed" ? "output" : "input"}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            {/* Top section, part 2: tabs left, Test right. The bottom border
             *  closes the whole top section (title + chips + tabs) and divides
             *  it from the scrollable content. `pb-2.5` keeps the rule off the
             *  tabs/Test; the selected tab is marked by colour, not an underline
             *  on this line. */}
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 pb-2.5">
              <TabsList className="h-auto justify-start gap-5 rounded-none bg-transparent p-0">
                <TabsTrigger value="input" className={TAB_TRIGGER}>
                  Input
                </TabsTrigger>
                <TabsTrigger value="output" className={TAB_TRIGGER}>
                  Output
                </TabsTrigger>
              </TabsList>
              {testButton}
            </div>

            {/* The title above is the step's name, so no separate "Label" field. */}
            <TabsContent value="input" className="mt-0 flex min-h-0 flex-1 flex-col gap-5 px-4 pt-3 pb-4 outline-none">
              {step.type === "trigger" && step.triggerConfig && (
                <>
                  <Field label="Trigger type" value={step.triggerConfig.type} />
                  {step.triggerConfig.scheduleType && (
                    <Field label="Schedule type" value={step.triggerConfig.scheduleType} />
                  )}
                  {step.triggerConfig.scheduleValue && (
                    <Field label="Schedule value" value={step.triggerConfig.scheduleValue} />
                  )}
                  {step.triggerConfig.timezone && <Field label="Timezone" value={step.triggerConfig.timezone} />}
                </>
              )}

              {step.type === "agent" && (
                <>
                  <UsesRow items={stepConnections(step, content?.apps)} />
                  <Section label="Prompt" grow>
                    <CodeBlock value={content?.content ?? ""} language="plaintext" prose monacoTheme={monacoTheme} />
                  </Section>
                </>
              )}

              {step.type === "action" && (
                <>
                  <UsesRow items={stepConnections(step, content?.apps)} />
                  <Section label="Script" grow>
                    <CodeBlock value={content?.content ?? ""} language="javascript" monacoTheme={monacoTheme} />
                  </Section>
                </>
              )}
            </TabsContent>

            <TabsContent value="output" className="mt-0 flex min-h-0 flex-1 flex-col px-4 pt-3 pb-4 outline-none">
              <StepOutput run={run} />
            </TabsContent>
          </Tabs>
        )}
      </ResizableSheetContent>
    </Sheet>
  );
}
