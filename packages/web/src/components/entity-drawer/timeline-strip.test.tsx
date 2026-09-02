/**
 * TimelineStrip contract:
 *  - day-grouped rows lead with the file title (email subject), snippet
 *    clamped under it, junk fact-snippets suppressed, no midnight clock time
 *  - expanding a row prefers read-time chunk quotes (/snippets) and falls
 *    back to stored mention snippets when the chunks yield nothing
 *  - CRM activity rows show the activity label, not the raw source string
 */
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { TimelineStrip } from "./timeline-strip";

function item(overrides: Record<string, unknown>) {
  return {
    fileId: "f0",
    fileName: "Some file",
    fileType: "doc",
    contentCategory: "document",
    sourceType: "google_drive",
    occurredAt: "2026-05-22T00:00:00",
    mentionConfidence: "EXTRACTED" as const,
    mentionCount: 1,
    contextSnippet: null,
    url: null,
    rollupGroupId: null,
    crmActivity: null,
    ...overrides,
  };
}

const groups = [
  {
    month: "2026-05",
    items: [
      item({
        fileId: "f1",
        fileName: "Verification engine - feedback received",
        sourceType: "gmail",
        occurredAt: "2026-05-22T00:00:00",
        mentionCount: 2,
        contextSnippet: "Sanaa confirmed the feedback is in",
      }),
      item({
        fileId: "f-junk",
        fileName: "Re: Isometry AI | Payroll May 2026",
        sourceType: "gmail",
        occurredAt: "2026-05-22T00:00:00",
        contextSnippet: "Corresponded 19e87b7823248128",
      }),
    ],
  },
  {
    month: "2026-04",
    items: [item({ fileId: "f2", fileName: "Helios spec", occurredAt: "2026-04-10T00:00:00" })],
  },
];

describe("TimelineStrip", () => {
  it("leads with the file title under day headers and suppresses junk fact snippets", () => {
    renderWithProviders(<TimelineStrip groups={groups} entityId="e-1" />);
    expect(screen.getByText(/3 entries/)).toBeInTheDocument();
    expect(screen.getByText("May 22")).toBeInTheDocument();
    expect(screen.getByText("Apr 10")).toBeInTheDocument();
    expect(screen.getByText("Verification engine - feedback received")).toBeInTheDocument();
    expect(screen.getByText("Sanaa confirmed the feedback is in")).toBeInTheDocument();
    expect(screen.getByText("Re: Isometry AI | Payroll May 2026")).toBeInTheDocument();
    expect(screen.queryByText(/Corresponded 19e87b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/12:00/)).not.toBeInTheDocument();
  });

  it("expands into stored mention snippets when the file's chunks yield no quotes", async () => {
    server.use(
      http.get("/api/entities/e-1/mentions", ({ request }) => {
        if (new URL(request.url).searchParams.get("fileId") !== "f1") {
          return HttpResponse.json({ mentions: [], total: 0, hiddenCount: 0 });
        }
        return HttpResponse.json({
          mentions: [
            { id: "m1", contextSnippet: "Sanaa confirmed the feedback is in", chunkIndex: 0 },
            { id: "m2", contextSnippet: "Sanaa will own the rollout comms", chunkIndex: 3 },
            { id: "m3", contextSnippet: "Corresponded 19e87b7823248128", chunkIndex: 4 },
          ],
          total: 3,
          hiddenCount: 0,
        });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<TimelineStrip groups={groups} entityId="e-1" />);

    const row = screen.getByText("Verification engine - feedback received").closest("button");
    expect(row).toHaveAttribute("aria-expanded", "false");
    if (row) await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("Sanaa will own the rollout comms")).toBeInTheDocument();
    expect(screen.getAllByText("Sanaa confirmed the feedback is in")).toHaveLength(1);
    expect(screen.queryByText(/Corresponded 19e87b/)).not.toBeInTheDocument();
    expect(screen.getByText("Helios spec").closest("button")).not.toHaveAttribute("aria-expanded");
  });

  it("prefers read-time chunk quotes over stored mention snippets", async () => {
    let mentionsCalled = false;
    server.use(
      http.get("/api/entities/e-1/snippets", ({ request }) => {
        if (new URL(request.url).searchParams.get("fileId") !== "f1") return HttpResponse.json({ quotes: [] });
        return HttpResponse.json({ quotes: ["Sanaa flagged the verification gap in standup"] });
      }),
      http.get("/api/entities/e-1/mentions", () => {
        mentionsCalled = true;
        return HttpResponse.json({ mentions: [], total: 0, hiddenCount: 0 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<TimelineStrip groups={groups} entityId="e-1" />);

    const row = screen.getByText("Verification engine - feedback received").closest("button");
    if (row) await user.click(row);
    expect(await screen.findByText("Sanaa flagged the verification gap in standup")).toBeInTheDocument();
    expect(mentionsCalled).toBe(false);
  });

  it("stays quiet when expansion finds nothing beyond the snippet already shown", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TimelineStrip groups={groups} entityId="e-1" />);

    const row = screen.getByText("Verification engine - feedback received").closest("button");
    if (row) await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(screen.queryByText(/Loading mentions/)).not.toBeInTheDocument());
    expect(screen.queryByText(/No quotable text found/)).not.toBeInTheDocument();
    expect(screen.getByText("Sanaa confirmed the feedback is in")).toBeInTheDocument();
  });

  it("expands a snippetless row through a custom quote loader (review evidence)", async () => {
    const load = async () => ["Shashank walked the team through the demo funnel", "Corresponded 19e87b7823248128"];
    const user = userEvent.setup();
    renderWithProviders(
      <TimelineStrip
        groups={[
          {
            month: "2026-08",
            items: [item({ fileId: "f9", fileName: "Daily CD Training – 2026-08-20", sourceType: "gmail" })],
          },
        ]}
        loadQuotes={load}
        quotesScope="review-1"
      />,
    );
    const row = screen.getByText("Daily CD Training – 2026-08-20").closest("button");
    expect(row).toHaveAttribute("aria-expanded", "false");
    if (row) await user.click(row);
    expect(await screen.findByText("Shashank walked the team through the demo funnel")).toBeInTheDocument();
    expect(screen.queryByText(/Corresponded 19e87b/)).not.toBeInTheDocument();
  });

  it("renders CRM activity rows with the activity label instead of the raw source", () => {
    renderWithProviders(
      <TimelineStrip
        groups={[
          {
            month: "2026-05",
            items: [
              item({
                fileId: "crm-task-1",
                fileName: "Follow up on renewal - Jane Buyer",
                fileType: "crm_task",
                sourceType: "zoho_crm",
                occurredAt: "2026-05-21T00:00:00",
                contextSnippet: "CRM activity parent",
                rollupGroupId: "Deals:d1",
                crmActivity: { activityType: "task", hasBody: true },
              }),
            ],
          },
        ]}
        entityId="e-1"
      />,
    );

    expect(screen.getByText("Follow up on renewal - Jane Buyer")).toBeInTheDocument();
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.queryByText(/zoho_crm/)).not.toBeInTheDocument();
  });
});
