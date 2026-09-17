/**
 * Three failure modes this panel must not have: filters that look applied but
 * never reach the server, a comparison whose verdicts cannot be narrowed to the
 * disagreements, and a stage read against newer content presented as if it were
 * current — or, worse, one that 404s and takes the page down with it.
 */
import type {
  ConsolidatedLoopGuard,
  LoopCompareDetail,
  LoopCompareListRow,
  LoopCompareVerdict,
  ReportStageValidation,
} from "@/lib/api";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import LoopCompare from "./loop-compare";

const guard: ConsolidatedLoopGuard = {
  overriddenByMatcher: 2,
  demotedUnoffered: 1,
  heldUnjudged: 0,
  heldPending: 0,
  newOverCandidates: 0,
  suppressed: 0,
  registryLinked: 4,
  droppedFacts: 0,
  matchToolCalls: 3,
  matchToolCalled: true,
};

const validation: ReportStageValidation = {
  droppedMentions: 1,
  droppedRelations: 0,
  invalidType: 0,
  droppedSingleTokenPerson: 1,
  schemaInvalid: 0,
  droppedSamples: [{ mention: "Ravi", type: "person", reason: "single token person" }],
  malformedResolution: 2,
  malformedSamples: [{ mention: "Arco", type: "company", reason: "unknown resolution kind" }],
};

function listRow(overrides: Partial<LoopCompareListRow> = {}): LoopCompareListRow {
  return {
    fileId: "file-1",
    fileName: "Weekly sync with Arco",
    source: "fireflies",
    sourceBucket: "fireflies",
    fileType: "transcript",
    extractorVersion: "loop-v2",
    stageUpdatedAt: "2026-09-16T10:35:00.000Z",
    stale: false,
    loopMentionCount: 3,
    holdCount: 1,
    legacyMentionCount: 2,
    guard: { overriddenByMatcher: 2, demotedUnoffered: 0, registryLinked: 4 },
    validation: { schemaInvalid: 0, malformedResolution: 2 },
    ...overrides,
  };
}

function verdictTotals(counts: Partial<Record<LoopCompareVerdict, number>>): Record<LoopCompareVerdict, number> {
  return {
    same_target: 0,
    different_target: 0,
    loop_resolved_legacy_queued: 0,
    loop_resolved_legacy_unresolved: 0,
    loop_hold_legacy_linked: 0,
    loop_new_legacy_linked: 0,
    loop_new_legacy_queued: 0,
    loop_only: 0,
    legacy_only: 0,
    both_unresolved: 0,
    indeterminate: 0,
    ...counts,
  };
}

function detailFixture(overrides: Partial<LoopCompareDetail> = {}): LoopCompareDetail {
  return {
    file: {
      id: "file-1",
      fileName: "Weekly sync with Arco",
      source: "fireflies",
      sourceBucket: "fireflies",
      fileType: "transcript",
      sourceCreatedAt: "2026-09-15T09:00:00.000Z",
      contentHash: "hash-new",
      enrichmentStatus: "done",
      summary: "Legacy summary of the weekly sync.",
    },
    stage: {
      id: "stage-1",
      extractorVersion: "loop-v2",
      updatedAt: "2026-09-16T10:35:00.000Z",
      stale: false,
      model: "claude-sonnet-4",
      costUsd: 0.0123,
      tokens: { input: 8000, output: 900 },
      toolSteps: [{ name: "match_entities", durationMs: 120, cached: false }],
      guard,
      validation,
    },
    legacy: {
      summary: "Legacy summary of the weekly sync.",
      mentions: [],
      relationCount: 4,
      factCount: 6,
      costUsd: 0.02,
      tokens: 7200,
      reconstructed: true,
    },
    loop: {
      summary: "Loop summary of the weekly sync.",
      mentions: [],
      relations: [{ from: "Arco", to: "Nikhil", kind: "works_at" }],
      entityFacts: [{ entityId: "ent-arco", entityName: "Arco", facts: ["Renewal is due in November"] }],
      staged: {
        mentions: [],
        relations: [],
        entityFacts: [],
        summary: "Loop summary of the weekly sync.",
        meta: { model: "claude-sonnet-4" },
      },
    },
    aligned: [
      {
        key: "arco|company",
        name: "Arco",
        type: "company",
        legacy: { status: "linked", entityId: "ent-arco", entityName: "Arco" },
        loop: { kind: "resolved", originalKind: "matched", entityId: "ent-arco", entityName: "Arco", live: true },
        verdict: "same_target",
      },
      {
        key: "nikhil|person",
        name: "Nikhil",
        type: "person",
        legacy: { status: "queued", reviewId: "rev-1", reviewStatus: "awaiting_human" },
        loop: { kind: "resolved", originalKind: "judged", entityId: "ent-nikhil", entityName: "Nikhil Rao" },
        verdict: "loop_resolved_legacy_queued",
      },
      {
        key: "onestop|company",
        name: "OneStop",
        type: "company",
        legacy: { status: "linked", entityId: "ent-onestop", entityName: "OneStop Retail" },
        loop: {
          kind: "hold",
          originalKind: "hold",
          reason: "two plausible targets",
          candidates: [
            { entityId: "ent-onestop", name: "OneStop Retail" },
            { entityId: "ent-onestop-2", name: "OneStop Logistics" },
          ],
        },
        verdict: "loop_hold_legacy_linked",
      },
    ],
    totals: {
      legacyMentions: 3,
      loopMentions: 3,
      holds: 1,
      verdicts: verdictTotals({ same_target: 1, loop_resolved_legacy_queued: 1, loop_hold_legacy_linked: 1 }),
    },
    ...overrides,
  };
}

describe("loop compare panel", () => {
  it("lists staged runs and sends the filters the operator picked", async () => {
    const requested: URLSearchParams[] = [];
    server.use(
      http.get("/api/dev/loop-stages", ({ request }) => {
        const url = new URL(request.url);
        requested.push(url.searchParams);
        const bucket = url.searchParams.get("bucket");
        return HttpResponse.json({
          stages:
            bucket === "slack"
              ? [listRow({ fileId: "file-2", fileName: "#ops thread", sourceBucket: "slack" })]
              : [listRow()],
        });
      }),
    );

    renderWithProviders(<LoopCompare />);

    await screen.findByText("Weekly sync with Arco");
    expect(screen.getByText(/loop 3 · holds 1 · legacy 2/)).toBeInTheDocument();
    expect(screen.getByText("overrides 2")).toBeInTheDocument();
    expect(screen.getByText("malformed 2")).toBeInTheDocument();
    expect(screen.queryByText(/^unoffered/)).toBeNull();
    expect(screen.queryByText(/^stale$/)).toBeNull();
    expect(requested[0]?.get("version")).toBe("loop-v2");
    expect(requested[0]?.get("limit")).toBe("50");
    expect(requested[0]?.get("bucket")).toBeNull();
    expect(requested[0]?.get("since")).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Source bucket"), "slack");
    await userEvent.selectOptions(screen.getByLabelText("Row limit"), "100");
    await userEvent.selectOptions(screen.getByLabelText("Extractor version"), "loop-v1");

    await screen.findByText("#ops thread");
    await waitFor(() => {
      const last = requested[requested.length - 1];
      expect(last?.get("bucket")).toBe("slack");
      expect(last?.get("limit")).toBe("100");
      expect(last?.get("version")).toBe("loop-v1");
    });
  });

  it("opens a stage into the aligned table and narrows it to one verdict", async () => {
    server.use(
      http.get("/api/dev/loop-stages", () => HttpResponse.json({ stages: [listRow()] })),
      http.get("/api/dev/loop-stages/file-1", () => HttpResponse.json({ detail: detailFixture() })),
      http.get("/api/connectors/files/file-1/content", () =>
        HttpResponse.json({
          file: {
            id: "file-1",
            connectorConfigId: "conn-1",
            fileName: "Weekly sync transcript.txt",
            fileType: "transcript",
            content: "Arco and Nikhil discussed the renewal.",
            summary: "Legacy summary of the weekly sync.",
            contextNote: null,
            tags: null,
            source: "fireflies",
            sourcePath: null,
            providerUrl: null,
            enrichmentStatus: "done",
          },
          access: { scope: "unrestricted", members: [], manualShares: [], shareWithEveryone: true },
          entities: [],
        }),
      ),
    );

    renderWithProviders(<LoopCompare />);
    await userEvent.click(await screen.findByTestId("loop-stage-row"));

    await screen.findByText("Legacy (reconstructed from current rows)");
    expect(screen.getByText("Loop summary of the weekly sync.")).toBeInTheDocument();
    expect(await screen.findAllByTestId("loop-aligned-row")).toHaveLength(3);
    expect(screen.getAllByTestId("loop-verdict-badge").map((node) => node.textContent)).toEqual([
      "same_target",
      "loop_resolved_legacy_queued",
      "loop_hold_legacy_linked",
    ]);
    expect(screen.getAllByTestId("loop-verdict-chip")).toHaveLength(3);
    expect(screen.queryByText(/^loop_only/)).toBeNull();

    await userEvent.click(screen.getByText("loop_hold_legacy_linked 1"));
    await waitFor(() => expect(screen.getAllByTestId("loop-aligned-row")).toHaveLength(1));
    expect(screen.getByText(/two plausible targets · OneStop Retail, OneStop Logistics/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open file" }));
    await screen.findByText("Weekly sync transcript.txt");
  });

  it("flags a stale stage with its note and reports a missing stage inline", async () => {
    server.use(
      http.get("/api/dev/loop-stages", () =>
        HttpResponse.json({
          stages: [
            listRow({ fileId: "file-stale", fileName: "Stale transcript", stale: true }),
            listRow({ fileId: "file-gone", fileName: "Re-staged elsewhere" }),
          ],
        }),
      ),
      http.get("/api/dev/loop-stages/file-stale", () =>
        HttpResponse.json({
          detail: detailFixture({
            stage: {
              ...detailFixture().stage,
              stale: true,
              staleNote: "stage content hash differs from the file's current content",
            },
          }),
        }),
      ),
      http.get("/api/dev/loop-stages/file-gone", () =>
        HttpResponse.json({ error: { code: "NOT_FOUND", message: "Loop stage not found" } }, { status: 404 }),
      ),
    );

    renderWithProviders(<LoopCompare />);
    const rows = await screen.findAllByTestId("loop-stage-row");
    await userEvent.click(rows[0]);

    expect(screen.getAllByText("stale")).toHaveLength(1);
    const banner = await screen.findByTestId("loop-compare-stale");
    expect(banner).toHaveTextContent("stage content hash differs from the file's current content");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("loop-compare-stale")).toBeNull());

    await userEvent.click((await screen.findAllByTestId("loop-stage-row"))[1]);
    const failure = await screen.findByTestId("loop-compare-detail-error");
    expect(failure).toHaveTextContent("No staged loop run for this file");
    expect(screen.getAllByTestId("loop-stage-row").length).toBeGreaterThan(0);
  });
});
