/**
 * TimelineStrip contract:
 *  - snippet-first rows under day headers: the snippet is the content, the
 *    file name is attribution, and date-only rows show no clock time
 *  - snippet rows expand in place; snippetless rows are inert
 *  - CRM activity rows show the activity label, not the raw source string
 */
import { renderWithProviders } from "@/test/utils";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
        fileName: "Atlas standup",
        sourceType: "fireflies",
        occurredAt: "2026-05-22T00:00:00",
        mentionCount: 2,
        contextSnippet: "Sarah leads Atlas through the rollout freeze",
      }),
    ],
  },
  {
    month: "2026-04",
    items: [item({ fileId: "f2", fileName: "Helios spec", occurredAt: "2026-04-10T00:00:00" })],
  },
];

describe("TimelineStrip", () => {
  it("renders snippet-first rows under day headers, file name demoted to attribution", () => {
    renderWithProviders(<TimelineStrip groups={groups} />);
    expect(screen.getByText(/2 entries/)).toBeInTheDocument();
    expect(screen.getByText("May 22")).toBeInTheDocument();
    expect(screen.getByText("Apr 10")).toBeInTheDocument();
    expect(screen.getByText("Sarah leads Atlas through the rollout freeze")).toBeInTheDocument();
    expect(screen.getByText(/Atlas standup · fireflies · ×2/)).toBeInTheDocument();
    expect(screen.getByText("Helios spec")).toBeInTheDocument();
    expect(screen.queryByText(/12:00/)).not.toBeInTheDocument();
  });

  it("expands snippet rows in place and leaves snippetless rows inert", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TimelineStrip groups={groups} />);
    const snippetRow = screen.getByText("Sarah leads Atlas through the rollout freeze").closest("button");
    expect(snippetRow).toHaveAttribute("aria-expanded", "false");
    if (snippetRow) await user.click(snippetRow);
    expect(snippetRow).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Helios spec").closest("button")).not.toHaveAttribute("aria-expanded");
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
      />,
    );

    expect(screen.getByText("Follow up on renewal - Jane Buyer")).toBeInTheDocument();
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.queryByText(/zoho_crm/)).not.toBeInTheDocument();
  });
});
