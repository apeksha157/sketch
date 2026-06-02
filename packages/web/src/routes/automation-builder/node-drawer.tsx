/**
 * Node config drawer. Click a node on the canvas to open it. Shows the per-step
 * config (Input tab) and the last run result (Output tab). Prototype: fields are
 * editable in-place but nothing persists yet — the wiring step adds the PUT calls.
 */
import { Badge } from "@sketch/ui/components/badge";
import { Input } from "@sketch/ui/components/input";
import { Label } from "@sketch/ui/components/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@sketch/ui/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sketch/ui/components/tabs";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { Suspense, lazy, useState } from "react";
import { STATUS_COLOR, TYPE_LABEL } from "./node-meta";
import { StepOutput } from "./output-viewer";
import { RunButton } from "./run-controls";
import type { StepNodeData } from "./types";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

const MIN_DRAWER_WIDTH = 380;
const DEFAULT_DRAWER_WIDTH = 480;

function CodeBlock({ value, language, monacoTheme }: { value: string; language: string; monacoTheme: string }) {
  return (
    <div className="h-[320px] overflow-hidden rounded-md border border-border">
      <Suspense fallback={<div className="p-3 text-xs text-muted-foreground">Loading editor…</div>}>
        <MonacoEditor
          loading={null}
          value={value}
          language={language}
          theme={monacoTheme}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: "on",
            lineNumbersMinChars: 3,
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input defaultValue={value} />
    </div>
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
  const [width, setWidth] = useState(DEFAULT_DRAWER_WIDTH);

  const step = data?.step;
  const content = data?.content;
  const run = data?.run;

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const maxWidth = Math.round(window.innerWidth * 0.94);
    const onMove = (ev: MouseEvent) => {
      const next = window.innerWidth - ev.clientX;
      setWidth(Math.min(maxWidth, Math.max(MIN_DRAWER_WIDTH, next)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <Sheet open={!!data} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0" style={{ width: `${width}px`, maxWidth: "94vw" }}>
        <button
          type="button"
          aria-label="Resize drawer"
          onMouseDown={startResize}
          className="absolute inset-y-0 left-0 z-50 w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-border"
        />
        <SheetHeader className="border-b border-border">
          <div className="flex items-center gap-2 pr-8">
            <Badge variant="outline">{step ? TYPE_LABEL[step.type] : ""}</Badge>
            {run && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-2 rounded-full" style={{ backgroundColor: STATUS_COLOR[run.status] }} />
                {run.status}
              </span>
            )}
            {onRun && (
              <div className="ml-auto">
                <RunButton running={running} onRun={onRun} size="xs" />
              </div>
            )}
          </div>
          <SheetTitle className="text-left">{step?.label}</SheetTitle>
          <SheetDescription className="sr-only">Step configuration</SheetDescription>
        </SheetHeader>

        {step && (
          <Tabs defaultValue="input" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-4 mt-3 w-fit">
              <TabsTrigger value="input">Input</TabsTrigger>
              <TabsTrigger value="output">Output</TabsTrigger>
            </TabsList>

            <TabsContent value="input" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <Field label="Label" value={step.label} />

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
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="secondary">mode: {step.agentMode ?? "light"}</Badge>
                    {step.agentModel && <Badge variant="secondary">model: {step.agentModel}</Badge>}
                    {step.agentSkills?.map((s) => (
                      <Badge key={s} variant="secondary">
                        skill: {s}
                      </Badge>
                    ))}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Prompt</Label>
                    <CodeBlock value={content?.content ?? ""} language="markdown" monacoTheme={monacoTheme} />
                  </div>
                </>
              )}

              {step.type === "action" && (
                <>
                  {content?.apps && content.apps.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {content.apps.map((a) => (
                        <Badge key={a} variant="secondary">
                          {a}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Script</Label>
                    <CodeBlock value={content?.content ?? ""} language="javascript" monacoTheme={monacoTheme} />
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="output" className="min-h-0 flex-1 overflow-y-auto p-4">
              <StepOutput run={run} />
            </TabsContent>
          </Tabs>
        )}
      </SheetContent>
    </Sheet>
  );
}
