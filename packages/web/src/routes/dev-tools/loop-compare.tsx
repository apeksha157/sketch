/**
 * The Loop compare tab: what the consolidated loop would have written, next to
 * what the legacy pipeline actually wrote for the same file.
 *
 * The loop runs in shadow and stages its output without applying it, so this is
 * the only place the two can be read against each other. Legacy keeps no
 * per-mention trace — its column is reconstructed from the rows that survive
 * today, which is why a stale stage still renders: the verdicts are then a
 * comparison against newer content, and the banner says so.
 *
 * Read-only by construction. Nothing here re-runs anything.
 */
import {
  type AlignedMention,
  ApiRequestError,
  type ConsolidatedLoopExtractorVersion,
  type LoopCompareDetail,
  type LoopCompareListRow,
  type LoopCompareSourceBucket,
  type LoopCompareVerdict,
  api,
} from "@/lib/api";
import { formatRelativeTime } from "@/lib/time";
import { FileDetailSheet } from "@/routes/files/file-detail-sheet";
import { Button } from "@sketch/ui/components/button";
import { Input } from "@sketch/ui/components/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { FilterChip, Td, Th } from "./dev-table";

const BUCKETS: LoopCompareSourceBucket[] = ["fireflies", "email", "slack", "whatsapp", "docs"];
const VERSIONS: ConsolidatedLoopExtractorVersion[] = ["loop-v2", "loop-v1"];
const LIMITS = [25, 50, 100, 200];

/** Declaration order of the server's verdict union, so the chips always read in the same sequence. */
const VERDICT_ORDER: LoopCompareVerdict[] = [
  "same_target",
  "different_target",
  "loop_resolved_legacy_queued",
  "loop_resolved_legacy_unresolved",
  "loop_hold_legacy_linked",
  "loop_new_legacy_linked",
  "loop_new_legacy_queued",
  "loop_only",
  "legacy_only",
  "both_unresolved",
  "indeterminate",
];

const TONE_GOOD = "border-emerald-600/40 text-emerald-700 dark:text-emerald-500";
const TONE_INFO = "border-sky-600/40 text-sky-700 dark:text-sky-500";
const TONE_WARN = "border-amber-600/40 text-amber-700 dark:text-amber-500";
const TONE_BAD = "border-destructive/50 text-destructive";
const TONE_NEUTRAL = "border-border text-muted-foreground";

/**
 * Agreement is quiet, disagreement is loud. A verdict that only means "the two
 * looked at different things" stays grey so it cannot be mistaken for a finding.
 */
const VERDICT_TONES: Record<LoopCompareVerdict, string> = {
  same_target: TONE_GOOD,
  different_target: TONE_BAD,
  loop_resolved_legacy_queued: TONE_INFO,
  loop_resolved_legacy_unresolved: TONE_INFO,
  loop_hold_legacy_linked: TONE_WARN,
  loop_new_legacy_linked: TONE_WARN,
  loop_new_legacy_queued: TONE_NEUTRAL,
  loop_only: TONE_NEUTRAL,
  legacy_only: TONE_NEUTRAL,
  both_unresolved: TONE_NEUTRAL,
  indeterminate: TONE_NEUTRAL,
};

const LOOP_KIND_TONES: Record<"resolved" | "new" | "hold", string> = {
  resolved: TONE_GOOD,
  new: TONE_INFO,
  hold: TONE_WARN,
};

const LEGACY_STATUS_TONES: Record<"linked" | "queued" | "ambiguous" | "none", string> = {
  linked: TONE_GOOD,
  queued: TONE_WARN,
  ambiguous: TONE_BAD,
  none: TONE_NEUTRAL,
};

export default function LoopCompare() {
  const [version, setVersion] = useState<ConsolidatedLoopExtractorVersion>("loop-v2");
  const [bucket, setBucket] = useState<LoopCompareSourceBucket | "">("");
  const [since, setSince] = useState("");
  const [limit, setLimit] = useState(50);
  const [openFileId, setOpenFileId] = useState<string | null>(null);
  const [inspectFileId, setInspectFileId] = useState<string | null>(null);

  const stagesQuery = useQuery({
    queryKey: ["dev-tools", "loop-stages", version, bucket, since, limit],
    queryFn: () =>
      api.dev.loopStages({
        version,
        limit,
        ...(bucket ? { bucket } : {}),
        ...(since ? { since } : {}),
      }),
    retry: false,
  });

  const stages = stagesQuery.data?.stages ?? [];

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Loop compare</h2>
      <p className="mb-3 text-[12px] text-muted-foreground">
        Files the consolidated loop staged in shadow. The legacy column is reconstructed from the rows that exist now —
        it is the current state of the graph, not a recording of what legacy decided.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
        <select
          aria-label="Extractor version"
          value={version}
          onChange={(event) => setVersion(event.target.value as ConsolidatedLoopExtractorVersion)}
          className="rounded-md border border-border bg-background px-2 py-1 text-[13px]"
        >
          {VERSIONS.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
        <select
          aria-label="Source bucket"
          value={bucket}
          onChange={(event) => setBucket(event.target.value as LoopCompareSourceBucket | "")}
          className="rounded-md border border-border bg-background px-2 py-1 text-[13px]"
        >
          <option value="">All buckets</option>
          {BUCKETS.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
        <Input
          aria-label="Staged since"
          type="date"
          value={since}
          onChange={(event) => setSince(event.target.value)}
          className="h-8 w-[10.5rem] text-[13px]"
        />
        <select
          aria-label="Row limit"
          value={limit}
          onChange={(event) => setLimit(Number(event.target.value))}
          className="rounded-md border border-border bg-background px-2 py-1 text-[13px]"
        >
          {LIMITS.map((entry) => (
            <option key={entry} value={entry}>
              {entry} rows
            </option>
          ))}
        </select>
      </div>

      {stagesQuery.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((k) => (
            <Skeleton key={k} className="h-12 rounded-md" />
          ))}
        </div>
      ) : stagesQuery.isError ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
          Could not load staged loop runs: {String(stagesQuery.error)}
        </p>
      ) : stages.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-6 text-center">
          <p className="text-[13px] text-muted-foreground">
            No staged runs match. The loop only stages on tenants where the shadow pass is switched on.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {stages.map((row) => (
            <StageRow
              key={`${row.fileId}-${row.extractorVersion}`}
              row={row}
              onOpen={() => setOpenFileId(row.fileId)}
            />
          ))}
        </div>
      )}

      <Sheet open={!!openFileId} onOpenChange={(open) => !open && setOpenFileId(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-[1100px]">
          <SheetTitle className="text-[14px]">Loop compare</SheetTitle>
          <SheetDescription className="sr-only">
            The legacy result reconstructed from current rows next to the consolidated loop's staged output.
          </SheetDescription>
          {openFileId ? (
            <DetailPane fileId={openFileId} version={version} onOpenFile={() => setInspectFileId(openFileId)} />
          ) : null}
        </SheetContent>
      </Sheet>

      <FileDetailSheet fileId={inspectFileId} onClose={() => setInspectFileId(null)} />
    </section>
  );
}

/**
 * Only the counters that are non-zero get a badge. A row of zeroes reads as
 * noise, and the thing an operator scans this list for is the exception.
 */
function StageRow({ row, onOpen }: { row: LoopCompareListRow; onOpen: () => void }) {
  const malformed = row.validation.schemaInvalid + row.validation.malformedResolution;

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="loop-stage-row"
      className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-muted/40"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{row.fileName}</span>
        <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{row.sourceBucket}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{row.extractorVersion}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatRelativeTime(row.stageUpdatedAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-muted-foreground">
        <span>
          loop {row.loopMentionCount} · holds {row.holdCount} · legacy {row.legacyMentionCount}
        </span>
        {row.stale ? <Pill tone={TONE_WARN} mono label="stale" /> : null}
        {row.guard.overriddenByMatcher > 0 ? (
          <Pill tone={TONE_NEUTRAL} mono label={`overrides ${row.guard.overriddenByMatcher}`} />
        ) : null}
        {row.guard.demotedUnoffered > 0 ? (
          <Pill tone={TONE_NEUTRAL} mono label={`unoffered ${row.guard.demotedUnoffered}`} />
        ) : null}
        {malformed > 0 ? <Pill tone={TONE_BAD} mono label={`malformed ${malformed}`} /> : null}
      </div>
    </button>
  );
}

function DetailPane({
  fileId,
  version,
  onOpenFile,
}: { fileId: string; version: ConsolidatedLoopExtractorVersion; onOpenFile: () => void }) {
  const detailQuery = useQuery({
    queryKey: ["dev-tools", "loop-stages", fileId, version],
    queryFn: () => api.dev.loopStage(fileId, version),
    retry: false,
  });

  if (detailQuery.isLoading) return <Skeleton className="mt-3 h-40 rounded-md" />;
  if (detailQuery.isError) {
    const missing = detailQuery.error instanceof ApiRequestError && detailQuery.error.status === 404;
    return (
      <p data-testid="loop-compare-detail-error" className="mt-3 text-[12px] text-destructive">
        {missing
          ? "No staged loop run for this file and version — it may have been re-staged under the other version."
          : `Could not load the comparison: ${String(detailQuery.error)}`}
      </p>
    );
  }

  const detail = detailQuery.data?.detail;
  if (!detail) return <p className="mt-3 text-[12px] text-muted-foreground">Nothing staged for this file.</p>;
  return <Detail detail={detail} onOpenFile={onOpenFile} />;
}

function Detail({ detail, onOpenFile }: { detail: LoopCompareDetail; onOpenFile: () => void }) {
  const [verdictFilter, setVerdictFilter] = useState<LoopCompareVerdict | null>(null);
  const { file, stage, legacy, loop, totals } = detail;
  const rows = verdictFilter ? detail.aligned.filter((row) => row.verdict === verdictFilter) : detail.aligned;
  const activeVerdicts = VERDICT_ORDER.filter((verdict) => (totals.verdicts[verdict] ?? 0) > 0);

  return (
    <div className="mt-3 space-y-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-foreground">{file.fileName}</p>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {file.sourceBucket} · {file.source}
            {file.fileType ? ` · ${file.fileType}` : ""} · {stage.extractorVersion}
            {stage.model ? ` · ${stage.model}` : ""}
            {stage.costUsd === null ? "" : ` · $${stage.costUsd.toFixed(4)}`}
            {` · ${formatTokens(stage.tokens.input)}/${formatTokens(stage.tokens.output)} tok`}
          </p>
        </div>
        <Button size="sm" variant="outline" className="shrink-0 text-[11px]" onClick={onOpenFile}>
          Open file
        </Button>
      </div>

      {stage.stale ? (
        <p
          data-testid="loop-compare-stale"
          className="rounded-md border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-[12px]"
        >
          {stage.staleNote ?? "This stage was produced from older content than the file holds now."}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <SideCard title="Legacy (reconstructed from current rows)" summary={legacy.summary}>
          <Stat label="mentions" value={totals.legacyMentions} />
          <Stat label="relations" value={legacy.relationCount} />
          <Stat label="facts" value={legacy.factCount} />
          <Stat label="cost" value={legacy.costUsd === null ? "—" : `$${legacy.costUsd.toFixed(4)}`} />
          <Stat label="tokens" value={formatTokens(legacy.tokens)} />
        </SideCard>
        <SideCard title="Consolidated loop" summary={loop.summary}>
          <Stat label="mentions" value={totals.loopMentions} />
          <Stat label="holds" value={totals.holds} />
          <Stat label="relations" value={loop.relations.length} />
          <Stat label="facts" value={loop.entityFacts.reduce((sum, entry) => sum + entry.facts.length, 0)} />
          <Stat label="cost" value={stage.costUsd === null ? "—" : `$${stage.costUsd.toFixed(4)}`} />
        </SideCard>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap gap-1">
          <FilterChip
            active={verdictFilter === null}
            onClick={() => setVerdictFilter(null)}
            label={`All ${detail.aligned.length}`}
          />
          {activeVerdicts.map((verdict) => (
            <span key={verdict} data-testid="loop-verdict-chip">
              <FilterChip
                active={verdictFilter === verdict}
                onClick={() => setVerdictFilter(verdictFilter === verdict ? null : verdict)}
                label={`${verdict} ${totals.verdicts[verdict]}`}
              />
            </span>
          ))}
        </div>

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[44rem] border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left">
                <Th>Name</Th>
                <Th className="w-20">Type</Th>
                <Th className="w-[14rem]">Legacy</Th>
                <Th className="w-[16rem]">Loop</Th>
                <Th className="w-[13rem]">Verdict</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <AlignedRow key={`${row.key}-${row.verdict}`} row={row} />
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? (
          <p className="mt-2 text-[12px] text-muted-foreground">No mentions with that verdict.</p>
        ) : null}
      </div>

      <Section title={`Loop relations · ${loop.relations.length}`}>
        <JsonBlock value={loop.relations} />
      </Section>

      <Section title={`Loop entity facts · ${loop.entityFacts.length}`}>
        {loop.entityFacts.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">The loop attached no facts.</p>
        ) : (
          <div className="space-y-2">
            {loop.entityFacts.map((entry) => (
              <div key={entry.entityId}>
                <p className="text-[12px] font-medium text-foreground">{entry.entityName}</p>
                <ul className="mt-0.5 list-disc pl-4 text-[11.5px] text-muted-foreground">
                  {entry.facts.map((fact) => (
                    <li key={fact}>{fact}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Guard and validation counters">
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[11px] sm:grid-cols-3">
          {Object.entries(stage.guard).map(([key, value]) => (
            <CounterLine key={key} label={key} value={String(value)} />
          ))}
          <CounterLine label="droppedMentions" value={String(stage.validation.droppedMentions)} />
          <CounterLine label="droppedRelations" value={String(stage.validation.droppedRelations)} />
          <CounterLine label="invalidType" value={String(stage.validation.invalidType)} />
          <CounterLine label="droppedSingleTokenPerson" value={String(stage.validation.droppedSingleTokenPerson)} />
          <CounterLine label="schemaInvalid" value={String(stage.validation.schemaInvalid)} />
          <CounterLine label="malformedResolution" value={String(stage.validation.malformedResolution)} />
        </div>
      </Section>

      <Section
        title={`Validation samples · ${stage.validation.droppedSamples.length + stage.validation.malformedSamples.length}`}
      >
        <SampleList title="Dropped" samples={stage.validation.droppedSamples} />
        <SampleList title="Malformed resolution" samples={stage.validation.malformedSamples} />
      </Section>

      <Section title={`Tool steps · ${stage.toolSteps.length}`}>
        {stage.toolSteps.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">The loop called no tools on this file.</p>
        ) : (
          <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {stage.toolSteps.map((step, index) => (
              <li key={`${step.name}-${index}`}>
                {step.name} · {step.durationMs}ms{step.cached ? " · cached" : ""}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Raw staged JSON">
        <JsonBlock value={loop.staged} />
      </Section>
    </div>
  );
}

function AlignedRow({ row }: { row: AlignedMention }) {
  return (
    <tr data-testid="loop-aligned-row" className="border-b border-border last:border-b-0">
      <Td>
        <span className="block truncate text-foreground">{row.name}</span>
      </Td>
      <Td className="font-mono text-[10.5px] text-muted-foreground">{row.type}</Td>
      <Td>
        <LegacyCell row={row} />
      </Td>
      <Td>
        <LoopCell row={row} />
      </Td>
      <Td>
        <Pill tone={VERDICT_TONES[row.verdict]} mono label={row.verdict} testId="loop-verdict-badge" />
      </Td>
    </tr>
  );
}

function LegacyCell({ row }: { row: AlignedMention }) {
  const legacy = row.legacy;
  if (!legacy) return <span className="text-muted-foreground">not extracted</span>;
  return (
    <div>
      <Pill tone={LEGACY_STATUS_TONES[legacy.status]} label={legacy.status} />
      {legacy.status === "linked" ? (
        <span className="ml-1.5 text-[11.5px] text-muted-foreground">{legacy.entityName ?? legacy.entityId}</span>
      ) : null}
      {legacy.status === "queued" ? (
        <span className="ml-1.5 text-[11.5px] text-muted-foreground">{legacy.reviewStatus ?? "in review"}</span>
      ) : null}
      {legacy.status === "ambiguous" ? (
        <span className="ml-1.5 text-[11.5px] text-muted-foreground">
          {legacy.entityIds?.length ?? 0} entities · {legacy.reviewIds?.length ?? 0} reviews
        </span>
      ) : null}
    </div>
  );
}

function LoopCell({ row }: { row: AlignedMention }) {
  const loop = row.loop;
  if (!loop) return <span className="text-muted-foreground">not extracted</span>;
  const targetHint = loop.live === false ? mergedOrDeleted(loop.mergedIntoEntityId) : null;
  const candidates = loop.candidates ?? [];
  const rejected = loop.rejectedCandidates ?? [];
  return (
    <div>
      <Pill tone={LOOP_KIND_TONES[loop.kind]} label={loop.kind} />
      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{loop.originalKind}</span>
      {loop.kind === "resolved" ? (
        <span className="ml-1.5 text-[11.5px] text-muted-foreground">
          {loop.entityName ?? loop.entityId}
          {targetHint ? ` (${targetHint})` : ""}
        </span>
      ) : null}
      {loop.kind === "hold" ? (
        <span className="ml-1.5 text-[11.5px] text-muted-foreground">
          {loop.reason ?? "held"}
          {candidates.length > 0 ? ` · ${candidateNames(candidates)}` : ""}
        </span>
      ) : null}
      {loop.kind === "new" ? (
        <span className="ml-1.5 text-[11.5px] text-muted-foreground">
          {rejected.length > 0 ? `new · rejected ${candidateNames(rejected)}` : "new entity"}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Which entities the loop actually weighed, not how many. Three names is what
 * fits the cell; past that the tail is a count, because the point of the list is
 * to recognise a wrong candidate, not to audit it here.
 */
function candidateNames(items: Array<{ name: string; live?: boolean; mergedIntoEntityId?: string }>): string {
  const shown = items
    .slice(0, 3)
    .map((item) => (item.live === false ? `${item.name} (${mergedOrDeleted(item.mergedIntoEntityId)})` : item.name));
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
}

/** The one rounded-full badge this panel uses, for verdicts, legacy status, loop kind and the list counters. */
function Pill({ label, tone, mono = false, testId }: { label: string; tone: string; mono?: boolean; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${mono ? "font-mono" : ""} ${tone}`}
    >
      {label}
    </span>
  );
}

function SideCard({ title, summary, children }: { title: string; summary: string | null; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
        {children}
      </div>
      <div className="mt-2">
        <SummaryText text={summary} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span>
      {label} <span className="text-foreground">{value}</span>
    </span>
  );
}

function CounterLine({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline justify-between gap-2 text-muted-foreground">
      <span className="truncate">{label}</span>
      <span className="text-foreground">{value}</span>
    </span>
  );
}

function SummaryText({ text }: { text: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return <p className="text-[12px] text-muted-foreground">No summary.</p>;
  return (
    <div>
      <p className={`text-[12px] leading-relaxed ${expanded ? "" : "line-clamp-3"}`}>{text}</p>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mt-1 text-[11px] text-muted-foreground underline"
      >
        {expanded ? "less" : "more"}
      </button>
    </div>
  );
}

function SampleList({
  title,
  samples,
}: { title: string; samples: Array<{ mention: string; type: string; reason: string }> }) {
  if (samples.length === 0) return null;
  return (
    <div className="mb-2 last:mb-0">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="mt-0.5 space-y-0.5 font-mono text-[11px] text-muted-foreground">
        {samples.map((sample, index) => (
          <li key={`${sample.mention}-${index}`}>
            {sample.mention} ({sample.type}) — {sample.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-md border border-border px-3 py-2">
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function mergedOrDeleted(mergedIntoEntityId: string | undefined): string {
  return mergedIntoEntityId ? "merged" : "deleted";
}

function formatTokens(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}
