/**
 * Double-merge awareness: the server dedupes proposals on (subject, action)
 * only, so fan-ins and chains reach the queue with no cross-reference. These
 * cover the three layers that make that visible BEFORE approval: the
 * relatedness classifier, the sheet's Related-proposals box, and the
 * cross-pipeline note in the manual merge dialog.
 */
import { EntityMergeDialog } from "@/components/entity-merge-dialog";
import { GraphVerdictsSection } from "@/components/graph-verdicts-section";
import type { GraphVerdict } from "@/lib/api";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { relatedOpenVerdicts } from "./graph-verdict-sheet";

function verdict(overrides: Partial<GraphVerdict> = {}): GraphVerdict {
  return {
    id: "gv-1",
    runId: "run-1",
    action: "merge_into",
    subjectEntityId: "ent-a",
    subjectContainerId: null,
    subjectName: "Redseer Strategy",
    subjectEntityType: "company",
    targetEntityId: "ent-c",
    resolvedTargetEntityId: "ent-c",
    targetName: "Redseer",
    reason: "Same firm",
    evidence: { fileIds: [], reviewIds: [], notes: [] },
    evidenceFingerprint: "fp",
    validationStatus: "ok",
    validationReason: null,
    wouldChange: null,
    status: "awaiting_human",
    supersededAt: null,
    decidedAt: null,
    decidedByUserId: null,
    appliedLedgerRef: null,
    createdAt: "2026-08-29T10:00:00.000Z",
    updatedAt: "2026-08-29T10:00:00.000Z",
    ...overrides,
  } as GraphVerdict;
}

describe("relatedOpenVerdicts", () => {
  it("classifies fan-ins, both chain directions, and same-subject overlaps", () => {
    const current = verdict();
    const fanIn = verdict({ id: "gv-2", subjectEntityId: "ent-b", subjectName: "Redseer Consulting" });
    const otherMergesMyTarget = verdict({
      id: "gv-3",
      subjectEntityId: "ent-c",
      subjectName: "Redseer",
      targetEntityId: "ent-d",
      resolvedTargetEntityId: "ent-d",
      targetName: "Redseer Global",
    });
    const otherTargetsMySubject = verdict({
      id: "gv-4",
      subjectEntityId: "ent-e",
      subjectName: "RS Strategy",
      targetEntityId: "ent-a",
      resolvedTargetEntityId: "ent-a",
      targetName: "Redseer Strategy",
    });
    const sameSubject = verdict({
      id: "gv-5",
      action: "archive",
      targetEntityId: null,
      resolvedTargetEntityId: null,
      targetName: null,
    });
    const unrelated = verdict({
      id: "gv-6",
      subjectEntityId: "ent-x",
      targetEntityId: "ent-y",
      resolvedTargetEntityId: "ent-y",
    });

    const related = relatedOpenVerdicts(current, [
      current,
      fanIn,
      otherMergesMyTarget,
      otherTargetsMySubject,
      sameSubject,
      unrelated,
    ]);
    expect(Object.fromEntries(related.map((r) => [r.verdict.id, r.kind]))).toEqual({
      "gv-2": "fan_in",
      "gv-3": "chain_apply_this_first",
      "gv-4": "chain_apply_other_first",
      "gv-5": "same_subject",
    });
  });
});

describe("related proposals in the review flow", () => {
  it("chips related band rows and spells out the ordering in the sheet", async () => {
    const a = verdict();
    const b = verdict({ id: "gv-2", subjectEntityId: "ent-b", subjectName: "Redseer Consulting" });
    server.use(
      http.get("/api/graph-verdicts", () => HttpResponse.json({ verdicts: [a, b] })),
      http.post("/api/graph-verdicts/gv-1/application", () =>
        HttpResponse.json({
          application: {
            verdictId: "gv-1",
            dryRun: true,
            status: "awaiting_human",
            ledgerRef: null,
            wouldChange: { entities: 2 },
            plan: null,
          },
        }),
      ),
    );

    renderWithProviders(<GraphVerdictsSection verdicts={[a, b]} allOpen={[a, b]} />);

    expect(await screen.findByTestId("graph-verdict-related-chip-gv-1")).toBeInTheDocument();
    expect(screen.getByTestId("graph-verdict-related-chip-gv-2")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("graph-verdict-band-row-gv-1"));
    const related = await screen.findByTestId("graph-verdict-related");
    expect(related).toHaveTextContent("Redseer Consulting");
    expect(related).toHaveTextContent("safe in any order");
  });

  it("gives veto_window rows the normal Confirm path into the reconcile sheet", async () => {
    const veto = verdict({
      id: "gv-veto",
      status: "veto_window",
      vetoUntil: "2026-09-11T00:00:00.000Z",
      corroboration: [
        {
          kind: "cross_source_cooccurrence",
          source: "gmail",
          fileId: "f-1",
          clusterKey: "gmail:th-1",
          supportsEntityId: "ent-c",
          observedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    server.use(
      http.get("/api/graph-verdicts", () => HttpResponse.json({ verdicts: [veto] })),
      http.post("/api/graph-verdicts/gv-veto/application", () =>
        HttpResponse.json({
          application: {
            verdictId: "gv-veto",
            dryRun: true,
            status: "veto_window",
            ledgerRef: null,
            wouldChange: { entities: 2 },
            plan: null,
          },
        }),
      ),
    );

    renderWithProviders(<GraphVerdictsSection verdicts={[veto]} allOpen={[veto]} />);

    expect(await screen.findByTestId("graph-verdict-veto-chip-gv-veto")).toHaveTextContent("corroborated — ready");
    await userEvent.click(screen.getByTestId("graph-verdict-band-approve-gv-veto"));
    expect(await screen.findByTestId("graph-verdict-approve")).toHaveTextContent("Merge into Redseer");
    expect(screen.getByTestId("graph-verdict-corroboration")).toHaveTextContent("Supports this decision");
  });

  it("keeps pending_corroboration rows dismissable but never confirmable", async () => {
    const pending = verdict({ id: "gv-pend", status: "pending_corroboration", corroboration: [] });
    server.use(
      http.get("/api/graph-verdicts", () => HttpResponse.json({ verdicts: [pending] })),
      http.post("/api/graph-verdicts/gv-pend/application", () =>
        HttpResponse.json({
          application: {
            verdictId: "gv-pend",
            dryRun: true,
            status: "pending_corroboration",
            ledgerRef: null,
            wouldChange: { entities: 2 },
            plan: null,
          },
        }),
      ),
    );

    renderWithProviders(<GraphVerdictsSection verdicts={[pending]} allOpen={[pending]} />);

    expect(await screen.findByTestId("graph-verdict-pending-chip-gv-pend")).toHaveTextContent("waiting for proof");
    expect(screen.queryByTestId("graph-verdict-band-approve-gv-pend")).not.toBeInTheDocument();
    expect(screen.getByTestId("graph-verdict-band-dismiss-gv-pend")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("graph-verdict-band-row-gv-pend"));
    expect(await screen.findByText("Waiting for more proof")).toBeInTheDocument();
    expect(screen.queryByTestId("graph-verdict-approve")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("splits corroboration entries into supporting and pointing-elsewhere groups", async () => {
    const mixed = verdict({
      id: "gv-mix",
      status: "pending_corroboration",
      corroboration: [
        {
          kind: "reproposal",
          source: "slack",
          fileId: "f-1",
          clusterKey: "slack:th-1",
          supportsEntityId: "ent-c",
          observedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          kind: "cross_source_cooccurrence",
          source: "gmail",
          fileId: "f-2",
          clusterKey: "gmail:th-2",
          supportsEntityId: "ent-z",
          observedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    server.use(
      http.get("/api/graph-verdicts", () => HttpResponse.json({ verdicts: [mixed] })),
      http.post("/api/graph-verdicts/gv-mix/application", () =>
        HttpResponse.json({
          application: {
            verdictId: "gv-mix",
            dryRun: true,
            status: "pending_corroboration",
            ledgerRef: null,
            wouldChange: { entities: 2 },
            plan: null,
          },
        }),
      ),
    );

    renderWithProviders(<GraphVerdictsSection verdicts={[mixed]} allOpen={[mixed]} />);
    await userEvent.click(screen.getByTestId("graph-verdict-band-row-gv-mix"));

    const section = await screen.findByTestId("graph-verdict-corroboration");
    expect(section).toHaveTextContent("Corroboration (2)");
    expect(section).toHaveTextContent("Supports this decision");
    expect(section).toHaveTextContent("proposed again");
    expect(section).toHaveTextContent("Points at a different entity");
    expect(section).toHaveTextContent("ent-z");
  });

  it("warns the manual merge dialog when an open agent proposal touches the entity", async () => {
    server.use(http.get("/api/graph-verdicts", () => HttpResponse.json({ verdicts: [verdict()] })));

    renderWithProviders(
      <EntityMergeDialog
        entityId="ent-a"
        entityName="Redseer Strategy"
        sourceType="company"
        open
        onOpenChange={() => {}}
      />,
    );

    const note = await screen.findByTestId("merge-agent-overlap");
    expect(note).toHaveTextContent("merge into → Redseer");
    expect(note).toHaveTextContent("whichever runs second goes stale");
  });
});
