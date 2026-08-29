import type { EntityListItem } from "@/lib/api";
import { useEntityUi } from "@/lib/entity-ui";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectsPage, validateOrgTabSearch } from "./index";

function entity(
  overrides: Partial<EntityListItem> & Pick<EntityListItem, "id" | "name" | "sourceType">,
): EntityListItem {
  return {
    nameStatus: "confirmed",
    proposedName: null,
    subtype: null,
    aliases: [],
    contactPoints: [],
    metadata: null,
    status: "confirmed",
    hotness: 1,
    mentionCount: 0,
    lastMentionAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const PERSON = entity({
  id: "person-1",
  name: "Mira Shah",
  sourceType: "person",
  subtype: "internal",
  metadata: { email: "mira@example.com", role: "Engineer" },
  contactPoints: [
    {
      id: "mira-email",
      kind: "email",
      value: "mira@example.com",
      label: null,
      isPrimary: true,
      provenance: "inferred",
      source: "google_calendar",
      verifiedAt: null,
    },
  ],
  mentionCount: 12,
});
const COMPANY = entity({ id: "company-1", name: "Acme", sourceType: "company", subtype: "internal" });
const PROJECT = entity({ id: "project-1", name: "Atlas Rollout", sourceType: "project" });
const TOOL = entity({ id: "tool-1", name: "Figma", sourceType: "tool" });

const ENTITIES: Record<string, EntityListItem[]> = {
  person: [PERSON],
  company: [COMPANY],
  team: [],
  project: [PROJECT],
  product: [],
  tool: [TOOL],
};

function StackProbe() {
  const ui = useEntityUi();
  return <div data-testid="open-stack">{ui.stack.join(",")}</div>;
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    server.use(
      http.get("/api/entities/graph", () =>
        HttpResponse.json({
          nodes: [
            { id: PERSON.id, name: PERSON.name, sourceType: PERSON.sourceType, hotness: PERSON.hotness },
            { id: COMPANY.id, name: COMPANY.name, sourceType: COMPANY.sourceType, hotness: COMPANY.hotness },
          ],
          edges: [{ source: PERSON.id, target: COMPANY.id, type: "works_at" }],
        }),
      ),
      http.get("/api/entities", ({ request }) => {
        const type = new URL(request.url).searchParams.get("type") ?? "";
        const entities = ENTITIES[type] ?? [];
        return HttpResponse.json({ entities, total: entities.length });
      }),
      http.get("/api/products", () =>
        HttpResponse.json({
          products: [
            {
              id: "product-1",
              name: "Canvas Copilot",
              aliases: [],
              hotness: 0,
              provenance_tier: "declared",
            },
          ],
        }),
      ),
    );
  });

  it("renders the company-grouped People directory with real contact metadata", async () => {
    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByText("Your Org")).toBeInTheDocument();
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Mira Shah")).toBeInTheDocument();
    expect(screen.getByText("mira@example.com")).toBeInTheDocument();
    expect(screen.getByText("Engineer · Internal")).toBeInTheDocument();
  });

  it("has no per-tab search boxes — the org-wide box is the only entity search", async () => {
    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByText("Mira Shah")).toBeInTheDocument();
    expect(screen.getByTestId("org-search-input")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search people…")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Companies/ }));
    await screen.findByText("Acme");
    expect(screen.queryByPlaceholderText("Search companies…")).not.toBeInTheDocument();
  });

  it("opens entity rows from type tabs in the shared drawer", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ProjectsPage />
        <StackProbe />
      </>,
    );

    await user.click(await screen.findByRole("button", { name: /^Projects/ }));
    await user.click(await screen.findByText("Atlas Rollout"));

    expect(screen.getByTestId("open-stack")).toHaveTextContent("project-1");
  });

  it("keeps curated products separate from tracked tools", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />);

    await user.click(await screen.findByRole("button", { name: /^Products/ }));

    expect(await screen.findByText("Canvas Copilot")).toBeInTheDocument();
    expect(screen.getByText("declared")).toBeInTheDocument();
    expect(screen.getByText("Figma")).toBeInTheDocument();
  });

  it("uses the active tab as the Add dialog's default entity type", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />);

    await user.click(await screen.findByRole("button", { name: /^Companies/ }));
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByRole("button", { name: "company" })).toHaveAttribute("data-variant", "default");
  });

  it("searches every entity type at once from the org-wide box and opens results in the drawer", async () => {
    const requestedTypes: Array<string | null> = [];
    server.use(
      http.get("/api/entities", ({ request }) => {
        const url = new URL(request.url);
        const search = url.searchParams.get("search");
        if (!search) {
          const entities = ENTITIES[url.searchParams.get("type") ?? ""] ?? [];
          return HttpResponse.json({ entities, total: entities.length });
        }
        requestedTypes.push(url.searchParams.get("type"));
        return HttpResponse.json({ entities: [PROJECT, TOOL], total: 2 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ProjectsPage />
        <StackProbe />
      </>,
    );

    await user.type(await screen.findByTestId("org-search-input"), "atlas");

    const results = await screen.findByTestId("org-search-results");
    expect(results).toHaveTextContent("2 matches across your whole org");
    expect(results).toHaveTextContent("Atlas Rollout");
    expect(results).toHaveTextContent("Figma");
    expect(requestedTypes).toContain("person,company,team,project,product,tool");
    expect(screen.queryByText("Mira Shah")).not.toBeInTheDocument();

    await user.click(screen.getByText("Atlas Rollout"));
    expect(screen.getByTestId("open-stack")).toHaveTextContent("project-1");
  });

  it("has no Review tab, maps legacy ?tab=review to People, and expands the band in place", async () => {
    server.use(
      http.get("/api/entity-review", ({ request }) => {
        const types = new URL(request.url).searchParams.get("types");
        if (types !== "person") return HttpResponse.json({ rows: [], total: 0 });
        return HttpResponse.json({
          rows: [
            {
              id: "review-1",
              proposed_name: "Nadia Rahman",
              normalized_name: "nadia rahman",
              entity_type: "person",
              proposed_email: null,
              candidate_entity_id: null,
              candidate_score: null,
              candidate_reason: null,
              candidate_generated_at: "2026-08-14T09:00:00.000Z",
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
        });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />);

    await screen.findByText("Your Org");
    expect(screen.queryByRole("button", { name: /^Review/ })).not.toBeInTheDocument();

    expect(validateOrgTabSearch({ tab: "review" })).toEqual({ tab: "people" });
    expect(validateOrgTabSearch({ tab: "projects" })).toEqual({ tab: "projects" });

    await screen.findByText("Nadia Rahman");
    await user.click(screen.getByTestId("review-band-toggle"));
    expect(await screen.findByTestId("review-band-search")).toBeInTheDocument();
    expect(screen.getByTestId("review-band-toggle")).toHaveTextContent("Collapse");
  });
});
