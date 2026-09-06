/**
 * TimelineStrip contract:
 *  - day-grouped rows lead with the file title (email subject), line two names
 *    the relation · source · passage count, no midnight clock time, no ×N
 *  - the whole row is one button that expands in place; nothing opens a sheet
 *  - structural rows (no passages) expand straight into the file's text
 *  - LLM rows show their passages first and reveal the text under
 *    "Show whole file"; review hosts get the same shape from `loadQuotes`
 *  - a gated file expands into the inline no-access line, strip intact
 *  - CRM activity rows show the activity label, not the raw source string
 */
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { TimelineStrip } from "./timeline-strip";

function rowToggle(title: string): HTMLElement {
  const button = screen.getByText(title).closest("button");
  if (!button) throw new Error(`No timeline row found for "${title}"`);
  return button;
}

/** The expansion region is a sibling of the row button, addressed by aria-controls. */
function expansionRegion(toggle: HTMLElement): HTMLElement {
  const id = toggle.getAttribute("aria-controls");
  const region = id ? document.getElementById(id) : null;
  if (!region) throw new Error("Row button has no expansion region");
  return region;
}

function fileContentResponse(overrides: Record<string, unknown> = {}) {
  return {
    file: {
      id: "crm-task-1",
      connectorConfigId: "cc-1",
      fileName: "Follow up on renewal - Jane Buyer",
      fileType: "crm_task",
      content: "Subject: Follow up on renewal\nDescription: Jane asked for the renewal quote by Friday.",
      summary: null,
      contextNote: null,
      tags: null,
      source: "zoho_crm",
      sourcePath: null,
      providerUrl: null,
      enrichmentStatus: "enriched",
      ...overrides,
    },
    access: { scope: "unrestricted", members: [], manualShares: [], shareWithEveryone: false },
    entities: [],
  };
}

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
    relations: [] as string[],
    passageCount: 0,
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
        fileName: "Int. call: Building OW AI capability",
        sourceType: "fireflies",
        occurredAt: "2026-05-22T00:00:00",
        relations: ["attended"],
      }),
      item({
        fileId: "f2",
        fileName: "Re: IPROC SUPPLIER REQUEST",
        sourceType: "gmail",
        occurredAt: "2026-05-22T00:00:00",
        mentionCount: 2,
        relations: ["mentioned"],
        passageCount: 2,
      }),
    ],
  },
  {
    month: "2026-04",
    items: [item({ fileId: "f3", fileName: "Helios spec", occurredAt: "2026-04-10T00:00:00" })],
  },
];

const crmGroups = [
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
];

describe("TimelineStrip", () => {
  it("leads with the file title under day headers and attributes relation, source and passages", () => {
    renderWithProviders(<TimelineStrip groups={groups} entityId="e-1" />);
    expect(screen.getByText(/3 entries/)).toBeInTheDocument();
    expect(screen.getByText("May 22")).toBeInTheDocument();
    expect(screen.getByText("Apr 10")).toBeInTheDocument();
    expect(screen.getByText("Int. call: Building OW AI capability")).toBeInTheDocument();
    expect(screen.getByText("Attended · fireflies")).toBeInTheDocument();
    expect(screen.getByText("Mentioned · gmail · 2 passages")).toBeInTheDocument();
    expect(screen.getByText("google drive")).toBeInTheDocument();
    expect(screen.queryByText(/×2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/12:00/)).not.toBeInTheDocument();
  });

  it("expands a structural row inline into the file's text with no sheet anywhere", async () => {
    server.use(
      http.get("/api/connectors/files/f1/content", () =>
        HttpResponse.json(
          fileContentResponse({
            id: "f1",
            fileName: "Int. call: Building OW AI capability",
            source: "fireflies",
            content: "Sanaa Khalloq walked the team through the AI capability roadmap.",
          }),
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<TimelineStrip groups={groups} entityId="e-1" />);

    const toggle = rowToggle("Int. call: Building OW AI capability");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const body = await screen.findByText(/walked the team through the AI capability roadmap/);
    expect(expansionRegion(toggle).contains(body)).toBe(true);
    expect(toggle.contains(body)).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Show whole file")).not.toBeInTheDocument();
  });

  it("shows an LLM row's passages first and reveals the file text under Show whole file", async () => {
    server.use(
      http.get("/api/entities/e-1/snippets", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("mode") !== "passages" || url.searchParams.get("fileId") !== "f2")
          return HttpResponse.json({ passages: [] });
        return HttpResponse.json({
          passages: [
            { chunkIndex: 3, text: "…with Sanaa Khalloq following up on the submission…" },
            { chunkIndex: 7, text: "…cc Sanaa Khalloq so OW has the trail…" },
          ],
        });
      }),
      http.get("/api/connectors/files/f2/content", () =>
        HttpResponse.json(
          fileContentResponse({
            id: "f2",
            fileName: "Re: IPROC SUPPLIER REQUEST",
            source: "gmail",
            content: "Full supplier request thread body.",
          }),
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<TimelineStrip groups={groups} entityId="e-1" highlight="Sanaa Khalloq" />);

    const toggle = rowToggle("Re: IPROC SUPPLIER REQUEST");
    await user.click(toggle);
    const region = expansionRegion(toggle);

    await within(region).findByText("Where they come up");
    expect(region.textContent).toContain("following up on the submission");
    expect(region.textContent).toContain("cc Sanaa Khalloq so OW has the trail");
    const marks = within(region).getAllByText("Sanaa Khalloq");
    expect(marks).toHaveLength(2);
    expect(marks.every((m) => m.tagName === "MARK")).toBe(true);
    expect(region.textContent).not.toContain("Full supplier request thread body");

    await user.click(within(region).getByRole("button", { name: "Show whole file" }));
    expect(await within(region).findByText(/Full supplier request thread body/)).toBeInTheDocument();
    expect(region.textContent).toContain("following up on the submission");
  });

  it("renders the inline no-access line when the content endpoint denies the file", async () => {
    server.use(
      http.get("/api/connectors/files/crm-task-1/content", () =>
        HttpResponse.json({ error: { code: "FORBIDDEN", message: "No content access" } }, { status: 403 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<TimelineStrip groups={crmGroups} entityId="e-1" />);

    const toggle = rowToggle("Follow up on renewal - Jane Buyer");
    await user.click(toggle);

    const denial = await screen.findByText("You don't have access to this file's contents.");
    expect(expansionRegion(toggle).contains(denial)).toBe(true);
    expect(screen.getByTestId("timeline-strip")).toBeInTheDocument();
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("expands a review-evidence row through a custom quote loader", async () => {
    const load = async () => ["Shashank walked the team through the demo funnel", null];
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

    const toggle = rowToggle("Daily CD Training – 2026-08-20");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);

    const region = expansionRegion(toggle);
    expect(await within(region).findByText("Shashank walked the team through the demo funnel")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Show whole file" })).toBeInTheDocument();
  });

  it("renders CRM activity rows with the activity label instead of the raw source", () => {
    renderWithProviders(<TimelineStrip groups={crmGroups} entityId="e-1" />);

    expect(screen.getByText("Follow up on renewal - Jane Buyer")).toBeInTheDocument();
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.queryByText(/zoho_crm/)).not.toBeInTheDocument();
  });
});
