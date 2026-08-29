/**
 * The graph-verdict lane inside the Your Org review bands: verdicts must land
 * in the band matching their subject type (never leak across tabs), count
 * toward the band's header and render-decision, and walk approve → apply in
 * one sheet visit — the sheet staying open after Approve is what makes the
 * band a review surface instead of a two-trip chore.
 */
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ReviewBandCapped } from "./org-review";

function verdictFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gv-1",
    runId: "run-1",
    action: "merge_into",
    subjectEntityId: "ent-ow",
    subjectContainerId: null,
    subjectName: "OW",
    subjectEntityType: "company",
    targetEntityId: "ent-oliver",
    resolvedTargetEntityId: "ent-oliver",
    targetName: "Oliver Wyman",
    reason: "Same firm under its short and long names",
    evidence: { fileIds: ["f-1"], reviewIds: [], notes: ["Both names on the same engagement"] },
    evidenceFingerprint: "abc123",
    validationStatus: "ok",
    validationReason: null,
    wouldChange: { entities: 2, entity_merges: 1 },
    status: "awaiting_human",
    supersededAt: null,
    decidedAt: null,
    decidedByUserId: null,
    appliedLedgerRef: null,
    createdAt: "2026-08-29T10:00:00.000Z",
    updatedAt: "2026-08-29T10:00:00.000Z",
    ...overrides,
  };
}

describe("Your Org graph-verdict band lane", () => {
  it("shows only the tab's own verdicts and counts them into the band header", async () => {
    server.use(
      http.get("/api/graph-verdicts", () =>
        HttpResponse.json({
          verdicts: [
            verdictFixture(),
            verdictFixture({
              id: "gv-2",
              action: "archive",
              subjectEntityId: "ent-falcon",
              subjectName: "Falcon Dashboard",
              subjectEntityType: "project",
              targetEntityId: null,
              targetName: null,
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<ReviewBandCapped types={["company"]} isAdmin />);

    const section = await screen.findByTestId("review-band-graph-verdicts");
    expect(section).toHaveTextContent("Agent proposals · 1");
    expect(section).toHaveTextContent("OW → Oliver Wyman");
    expect(screen.queryByText("Falcon Dashboard")).not.toBeInTheDocument();
    expect(screen.getByText("Needs your review · 1")).toBeInTheDocument();
  });

  it("never fetches or renders verdicts for members", async () => {
    let fetches = 0;
    server.use(
      http.get("/api/graph-verdicts", () => {
        fetches += 1;
        return HttpResponse.json({ verdicts: [verdictFixture()] });
      }),
      http.get("/api/entity-review", () =>
        HttpResponse.json({
          rows: [
            {
              id: "review-1",
              proposed_name: "Acme Labs",
              normalized_name: "acme labs",
              entity_type: "company",
              proposed_email: null,
              candidate_entity_id: null,
              candidate_score: null,
              candidate_reason: null,
              candidate_generated_at: null,
              source: "fireflies",
              source_id: "file-1",
              seed_source: null,
              seed_source_id: null,
              first_seen_at: "2026-08-10T09:00:00.000Z",
              last_seen_at: "2026-08-14T09:00:00.000Z",
              occurrence_count: 2,
              status: "pending",
              triggered_by_user_id: "user-1",
              review_started_at: null,
              review_started_by: null,
              backfill_cursor: null,
              resolved_by: null,
              resolved_at: null,
              resolved_entity_id: null,
              evidenceCount: 2,
              sourceBreakdown: [{ source: "fireflies", count: 2 }],
              candidate: null,
            },
          ],
          total: 1,
        }),
      ),
    );

    renderWithProviders(<ReviewBandCapped types={["company"]} />);

    expect(await screen.findByText("Needs your review · 1")).toBeInTheDocument();
    expect(screen.queryByTestId("review-band-graph-verdicts")).not.toBeInTheDocument();
    expect(fetches).toBe(0);
  });

  it("walks a verdict from approve to apply in one sheet visit, then retires the section", async () => {
    const decisions: string[] = [];
    let verdicts: ReturnType<typeof verdictFixture>[] = [verdictFixture()];
    server.use(
      http.get("/api/graph-verdicts", () => HttpResponse.json({ verdicts })),
      http.post("/api/graph-verdicts/gv-1/approval", () => {
        decisions.push("approval");
        verdicts = [verdictFixture({ status: "approved" })];
        return HttpResponse.json({ verdict: verdictFixture({ status: "approved" }) });
      }),
      http.post("/api/graph-verdicts/gv-1/application", async ({ request }) => {
        const body = (await request.json()) as { dryRun?: boolean };
        decisions.push(body.dryRun ? "dry-run" : "apply");
        if (!body.dryRun) verdicts = [];
        return HttpResponse.json({
          application: {
            verdictId: "gv-1",
            dryRun: body.dryRun === true,
            status: body.dryRun ? "awaiting_human" : "applied",
            ledgerRef: body.dryRun ? null : "merge-group:graph-verdict:gv-1",
            wouldChange: { entities: 2, entity_merges: 1 },
            plan: null,
          },
        });
      }),
    );

    renderWithProviders(<ReviewBandCapped types={["company"]} isAdmin />);

    await userEvent.click(await screen.findByTestId("graph-verdict-band-row-gv-1"));
    await screen.findByText("Same firm under its short and long names");
    await waitFor(() => expect(decisions).toContain("dry-run"));

    await userEvent.click(await screen.findByTestId("graph-verdict-approve"));
    await waitFor(() => expect(decisions).toContain("approval"));

    const applyButton = await screen.findByTestId("graph-verdict-apply");
    await waitFor(() => expect(applyButton).toBeEnabled());
    await userEvent.click(applyButton);
    await waitFor(() => expect(decisions).toContain("apply"));

    await waitFor(() => expect(screen.queryByTestId("review-band-graph-verdicts")).not.toBeInTheDocument());
  });
});
