import { ConnectorLogo } from "@/components/connector-logos";
import type { SkillCategory } from "@/lib/skills-data";
import { useDashboardAuth } from "@/routes/dashboard";
/**
 * Member home — bento-grid dashboard. Uses the same page shell as every other
 * dashboard page (mx-auto max-w-4xl, px-10 py-8) so typography, spacing, and
 * card surfaces stay consistent. Page scrolls naturally if content overflows.
 *
 * The same layout serves both empty (new member) and mature (active member) states.
 * Cards keep the same dimensions across states; only their content changes — a
 * layout that reshuffles as setup progresses feels disorienting.
 *
 * Discovery / "what can Sketch do?" lives in the chatbot widget (rendered separately,
 * shared across pages). Setup guidance lives in the AppSidebar's stepper. Neither is
 * the home page's job.
 *
 * Bento grid (3 rows × 3 cols):
 *
 *   activity activity      files
 *   skills   team          usage
 *   skills   integrations  usage
 *
 * Files is compact (1 row); Usage spans 2 rows so it has room for a donut
 * chart of credits used vs remaining. Team and Integrations stay in col 2.
 */
import { GreetingBar, type HomeDigest } from "@/routes/home";
import {
  ArrowRightIcon,
  CalendarDotsIcon,
  ChartBarIcon,
  ChatCircleIcon,
  GaugeIcon,
  LockIcon,
  MagnifyingGlassIcon,
  NewspaperIcon,
  type Icon as PhosphorIcon,
  PlusIcon,
  StackIcon,
  TargetIcon,
  WarningIcon,
  WarningOctagonIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type React from "react";

// ── Types ────────────────────────────────────────────────────────────────────

export interface UpcomingRun {
  id: string;
  title: string;
  /** Where this runs — e.g. "Standup", "Sales team", "DM with Sarah". Title-cased for visual consistency across platforms. */
  target: string;
  /** Clock time, e.g. "9:00 AM". */
  time: string;
  /** Time-until-next-run — capitalized, e.g. "In 2h", "Mon", "Tomorrow". */
  relativeTime: string;
  /** Channel the run will post to. Drives the inline channel icon on the secondary line. */
  channel: "slack" | "whatsapp";
  /** Destination for the row click — usually a specific task detail page. */
  href: string;
}

export interface RecentEvent {
  id: string;
  title: string;
  category: SkillCategory;
  /** Human-readable relative time, e.g. "2h ago", "Yesterday". */
  relativeTime: string;
  /** Destination for the row click — usually the run detail page. */
  href: string;
  /** True for runs that errored — swaps category tile for a red warning tile. */
  error?: boolean;
}

export interface ActiveSkill {
  id: string;
  name: string;
  category: SkillCategory;
  /** ISO string or null for "never run". Display formatting is up to the renderer. */
  lastUsedAt: string | null;
  /** Pre-formatted relative time — bare timestamp, e.g. "2h ago", "Today". Empty for never-run. */
  lastUsedLabel: string;
  /** Destination for the row click — usually the skill detail page. */
  href: string;
  /** True when the skill is broken — swaps the yellow tile for the red ERROR_TILE + warning glyph in the LEFT column (alarm), and shows a muted info tile in the RIGHT column identifying what's wrong. */
  error?: boolean;
  /** What kind of error. Drives the right-column icon: integration shows the connector logo, others show a type-specific glyph. Defaults to "integration" if errorIntegration is set, otherwise "execution". */
  errorReason?: "integration" | "config" | "quota" | "permission" | "execution";
  /** Connector ID (e.g., "slack", "notion") when errorReason is "integration". */
  errorIntegration?: string;
}

export interface ExploreSuggestion {
  id: string;
  /** Creator-written heading. Quality varies — display, but don't lean on it for trust signals. */
  name: string;
  /** Creator-written subheading describing the value. Same caveat as name — unreliable, but informative. */
  description: string;
  /** System fact: category drives the tile glyph so Active/Explore feel like one family. */
  category: SkillCategory;
  /** System fact: integrations the skill template requires. Rendered as small ConnectorLogo glyphs on the row's right edge (replaces a decorative arrow). */
  integrations: string[];
  href: string;
}

export interface TeamMember {
  id: string;
  initials: string;
  /** Tailwind background class for the initials-fallback tint, e.g. "bg-blue-500/20". */
  tint: string;
  /** Optional profile photo URL. When set, replaces the initials/tint with the image. */
  imageUrl?: string;
}

export interface TeamSummary {
  totalCount: number;
  humanCount: number;
  agentCount: number;
  pendingInvites: number;
  /** First few members shown in the avatar row. */
  members: TeamMember[];
}

export interface IntegrationProvider {
  id: string;
  /** Tailwind background class for the connector swatch, e.g. "bg-orange-500". */
  tint: string;
  status: "ok" | "error";
}

export interface IntegrationSummary {
  totalCount: number;
  needsReconnectCount: number;
  providers: IntegrationProvider[];
  /** Number of skills currently powered by these integrations — surfaces on the Full stat card to convey the *value* of connections, not just the count. */
  skillsPowered?: number;
}

export interface UsageBreakdown {
  /** Credits consumed by chat messages. */
  messages: number;
  /** Credits consumed by scheduled automations. */
  automations: number;
  /** Credits consumed by tool / MCP calls. */
  toolCalls: number;
}

export interface UsageSummary {
  /** Credit allowance for the current billing period. */
  creditsTotal: number;
  /** Credits left to spend in the current period. */
  creditsRemaining: number;
  /** Days until the allowance resets, e.g. 12. */
  resetsInDays: number;
  /** Breakdown of consumed credits by category. Sum should ≈ creditsTotal - creditsRemaining. */
  breakdown: UsageBreakdown;
}

export interface FilesEntityCounts {
  people: number;
  companies: number;
  projects: number;
  databases: number;
  documents: number;
}

export interface RecentlyIndexedFile {
  id: string;
  fileName: string;
  /** Display label for the source, e.g. "Drive", "Notion". */
  source: string;
  /** Pre-formatted relative time, e.g. "2h ago", "today". */
  syncedLabel: string;
}

export interface FilesSummary {
  entityCounts: FilesEntityCounts;
  recentlyIndexed: RecentlyIndexedFile[];
}

export interface HomeMemberPageProps {
  digest: HomeDigest;
  upcoming: UpcomingRun[];
  recent: RecentEvent[];
  /** Count of scheduled tasks that failed during their last run. Drives the Activity card's error state. */
  failedRunsCount: number;
  activeSkills: ActiveSkill[];
  exploreSuggestions: ExploreSuggestion[];
  team: TeamSummary;
  integrations: IntegrationSummary;
  usage: UsageSummary;
  files: FilesSummary;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function firstName(displayName: string): string {
  return displayName.split(" ")[0] ?? displayName;
}

/**
 * Phosphor icon per skill category. Picked once and stable so Activity and Active
 * skill rows feel cohesive (a "research" run looks like a "research" skill).
 * Only the categories that show up frequently get a dedicated icon; everything
 * else falls back to a generic spark.
 */
const CATEGORY_ICON: Partial<Record<SkillCategory, PhosphorIcon>> = {
  crm: TargetIcon,
  comms: ChatCircleIcon,
  research: MagnifyingGlassIcon,
  ops: WrenchIcon,
  reporting: ChartBarIcon,
  sales: TargetIcon,
  analytics: ChartBarIcon,
  marketing: NewspaperIcon,
};

function CategoryIcon({ category, size = 11 }: { category: SkillCategory; size?: number }) {
  const Icon = CATEGORY_ICON[category] ?? StackIcon;
  return <Icon size={size} />;
}

/** Yellow-wash tile used for sketch-action and active-skill rows. */
const SKETCH_TILE = "bg-[#FEED01]/15 dark:bg-[#FEED01]/[0.06] text-[#8B7A00] dark:text-[#FEED01]";

/** Red-wash tile used for failed-run rows. Same shape as SKETCH_TILE — only the wash and glyph color flip. */
const ERROR_TILE = "bg-red-500/15 text-red-700 dark:bg-red-500/[0.12] dark:text-red-400";

/**
 * Card title — IBM Plex Mono uppercase, primary text.
 */
const CARD_TITLE = "font-mono text-xs uppercase tracking-[0.08em] text-foreground";

/**
 * Card header row — title on the left, optional CTA on the right, banded
 * across the full card width with a subtle muted fill. The fill establishes
 * the "header band" pattern; error states (e.g. Integrations needs reconnect)
 * swap the muted bg for a red one but keep the same shape, so the error
 * doesn't read as a one-off treatment.
 *
 * Negative top/side margins push the band to the rounded card corners; the
 * matching pt/px restores the title's inset position.
 */
const CARD_HEADER =
  "-mx-4 -mt-4 px-4 pt-4 rounded-t-lg bg-muted/40 flex items-center justify-between border-b border-border pb-2.5 mb-3";

/**
 * Sub-section label — IBM Plex Mono uppercase, muted. Same family as the card
 * title; hierarchy comes from the divided header above plus size + color.
 */
const SECTION_LABEL = "font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground";

// ── Page ─────────────────────────────────────────────────────────────────────

export function HomeMemberPage(props: HomeMemberPageProps) {
  const auth = useDashboardAuth();

  return (
    <div className="mx-auto max-w-4xl px-10 py-5">
      <GreetingBar firstName={firstName(auth.displayName)} digest={props.digest} />

      <div
        className="mt-5 grid gap-3"
        style={{
          gridTemplateColumns: "1.2fr 0.78fr 1.05fr",
          // Locked row heights. Row 1 (Activity / Files) is the prominent tier
          // — daily check-in + USP visibility. Rows 2 & 3 are the housekeeping
          // tier (Team, Integrations) and the spanning cards (Skills, Usage)
          // get 2 × 130px + gap ≈ 272px between them.
          gridTemplateRows: "320px 130px 130px",
          gridTemplateAreas: `
            "activity activity files"
            "skills team usage"
            "skills integrations usage"
          `,
        }}
      >
        <div style={{ gridArea: "activity" }} className="min-w-0">
          <ActivityCard upcoming={props.upcoming} recent={props.recent} failedRunsCount={props.failedRunsCount} />
        </div>

        <div style={{ gridArea: "skills" }} className="min-w-0">
          <SkillsCard active={props.activeSkills} suggestions={props.exploreSuggestions} />
        </div>

        <div style={{ gridArea: "team" }} className="min-w-0">
          <TeamCard team={props.team} />
        </div>

        <div style={{ gridArea: "integrations" }} className="min-w-0">
          <IntegrationsCard summary={props.integrations} />
        </div>

        <div style={{ gridArea: "files" }} className="min-w-0">
          <FilesCard files={props.files} />
        </div>

        <div style={{ gridArea: "usage" }} className="min-w-0">
          <UsageCard usage={props.usage} />
        </div>
      </div>
    </div>
  );
}

// ── Activity card ────────────────────────────────────────────────────────────

function ActivityCard({
  upcoming,
  recent,
  failedRunsCount,
}: {
  upcoming: UpcomingRun[];
  recent: RecentEvent[];
  failedRunsCount: number;
}) {
  const upcomingEmpty = upcoming.length === 0;
  const recentEmpty = recent.length === 0;
  const hasError = failedRunsCount > 0;
  // Top 3 recent events. Combined with 2 upcoming, that's the densest split
  // that fits the 320px row 1 without bleeding into bottom padding.
  // Sort errored runs to the top so broken state stays visible even when many
  // newer (non-errored) entries push them past the slice cap. Same pattern as
  // SkillsCard Active sorting — applies to any list card surfacing errors.
  const recentEvents = [...recent].sort((a, b) => Number(b.error ?? false) - Number(a.error ?? false)).slice(0, 3);

  return (
    <Card>
      <header className={cn(CARD_HEADER, hasError && "bg-red-500/[0.08]")}>
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className={CARD_TITLE}>Activity</h2>
          {hasError ? (
            <WarningIcon
              size={12}
              weight="fill"
              className="shrink-0 text-red-700 dark:text-red-400"
              aria-label={`${failedRunsCount} ${failedRunsCount === 1 ? "run" : "runs"} failed`}
            />
          ) : null}
        </div>
        <CardHeaderArrow to="/scheduled-tasks" label="Open scheduled tasks" />
      </header>

      {upcomingEmpty && recentEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 pb-2 text-center">
          <p className="text-base font-medium text-foreground">Ready when you are.</p>
          <p className="max-w-[36ch] text-sm text-muted-foreground">
            Hand me a task and I'll show the work here —
            <br />
            every run, every detail.
          </p>
        </div>
      ) : (
        <>
          <p className={SECTION_LABEL}>Up next</p>
          {upcomingEmpty ? (
            <VoiceLine className="mt-2">I'm built for routines. Tell me when, and I'll run on time.</VoiceLine>
          ) : (
            <ul className="mt-2">
              {upcoming.slice(0, 2).map((run) => (
                <UpcomingRow key={run.id} run={run} />
              ))}
            </ul>
          )}

          <p className={cn(SECTION_LABEL, "mt-3")}>Recent activity</p>
          {recentEmpty ? (
            <VoiceLine className="mt-2">My logbook — every task I run lands here.</VoiceLine>
          ) : (
            <ul className="mt-2">
              {recentEvents.map((event) => (
                <RecentRow key={event.id} event={event} />
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Shared row-link classes for clickable card rows — hover bg bleeds 8px into the
 * card's horizontal padding (the -mx-2/px-2 trick), leaving an 8px gap from the
 * card edge so the band sits visually inset. Used by Activity (Upcoming, Recent)
 * and Skills (Active) — one motion across the dashboard.
 */
const CARD_ROW_LINK =
  "group/row -mx-2 flex items-center gap-3 rounded-md px-2 py-1 transition-colors duration-300 ease-in-out hover:bg-muted/40";

function UpcomingRow({ run }: { run: UpcomingRun }) {
  return (
    <li>
      <Link to={run.href} className={CARD_ROW_LINK}>
        <div className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", SKETCH_TILE)}>
          <CalendarDotsIcon size={12} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{run.title}</p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <ConnectorLogo type={run.channel} size={10} className="shrink-0" />
            <span className="truncate">
              {run.target} · {run.time}
            </span>
          </p>
        </div>
        <p className="shrink-0 text-xs text-muted-foreground">{run.relativeTime}</p>
      </Link>
    </li>
  );
}

function RecentRow({ event }: { event: RecentEvent }) {
  const failed = event.error === true;
  return (
    <li>
      <Link to={event.href} className={CARD_ROW_LINK}>
        <div
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md",
            failed ? ERROR_TILE : SKETCH_TILE,
          )}
        >
          {failed ? <WarningIcon size={12} weight="fill" /> : <CategoryIcon category={event.category} size={12} />}
        </div>
        <p className="min-w-0 flex-1 truncate text-sm">{event.title}</p>
        <p className="shrink-0 text-xs text-muted-foreground">{event.relativeTime}</p>
      </Link>
    </li>
  );
}

// ── Skills card ──────────────────────────────────────────────────────────────

function SkillsCard({ active, suggestions }: { active: ActiveSkill[]; suggestions: ExploreSuggestion[] }) {
  const empty = active.length === 0;
  const errored = active.filter((s) => s.error);
  const okay = active.filter((s) => !s.error);
  const erroredCount = errored.length;
  const hasError = erroredCount > 0;
  // Error priority rule (applies across the dashboard): errors are sacred. With
  // up to 3 errors, default 3+1 layout holds. Beyond that, drop Explore and let
  // Active expand to show every error. Beyond ~5 errors, the Active list scrolls
  // — the card stays the same height; errors stay visible via scroll.
  const showExplore = !empty && erroredCount <= 3;
  const SCROLL_THRESHOLD = 5;
  const visibleActive = showExplore ? [...errored, ...okay].slice(0, 3) : [...errored, ...okay]; // render all when errors take over; CSS scroll handles overflow
  const needsScroll = !showExplore && visibleActive.length > SCROLL_THRESHOLD;
  // Explore count flexes with Active count so the card fills its height budget:
  //  - 0 active → 3 Explore (Empty)
  //  - 1 active → 2 Explore (Sparse — Active is small, Explore takes the slack)
  //  - 2-3 active → 1 Explore (Full or Error with 2 active)
  const exploreCount = empty ? 3 : active.length === 1 ? 2 : 1;
  const visibleExplore = suggestions.slice(0, exploreCount);

  return (
    <Card>
      <header className={cn(CARD_HEADER, hasError && "bg-red-500/[0.08]")}>
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className={CARD_TITLE}>Skills</h2>
          {hasError ? (
            <WarningIcon
              size={12}
              weight="fill"
              className="shrink-0 text-red-700 dark:text-red-400"
              aria-label={`${erroredCount} ${erroredCount === 1 ? "skill" : "skills"} need attention`}
            />
          ) : null}
        </div>
        <CardHeaderArrow to="/skills" label="Open skills" />
      </header>

      {!empty ? (
        <>
          <p className={SECTION_LABEL}>Active</p>
          <ul className={cn("mt-2", needsScroll && "max-h-[160px] overflow-y-auto")}>
            {visibleActive.map((skill) => (
              <ActiveSkillRow key={skill.id} skill={skill} />
            ))}
          </ul>
        </>
      ) : null}

      {showExplore || empty ? (
        <>
          <p className={cn(SECTION_LABEL, !empty && "mt-2")}>Explore</p>
          <ul className="mt-1.5 space-y-0.5">
            {visibleExplore.map((suggestion) => (
              <ExploreRow key={suggestion.id} suggestion={suggestion} />
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}

/**
 * A row inside the Explore list. Padded so the hover background gets breathing
 * room (no edge-flush icon/arrow), and the arrow is always visible — important
 * when multiple rows render, since the hover-only arrow stops reading as an
 * affordance once it scales beyond one item.
 */
/**
 * Source-of-truth brand colors per connector. Used by:
 *  - Skills Explore tiles (hover state via group-hover/row prefix)
 *  - Integrations card avatar stack (always-on, see home-demo.tsx mock data)
 * Each hex is sampled from the actual product's brand identity, not arbitrary
 * Tailwind palette — generic colors (bg-pink-500 for Slack) misrepresent brands.
 * Tailwind JIT picks up arbitrary-value classes (bg-[#…]) from these strings.
 */
const CONNECTOR_HOVER_TINT: Record<string, string> = {
  drive: "group-hover/row:bg-[#1a73e8] group-hover/row:text-white",
  google_drive: "group-hover/row:bg-[#1a73e8] group-hover/row:text-white",
  notion: "group-hover/row:bg-[#191919] group-hover/row:text-white",
  slack: "group-hover/row:bg-[#611f69] group-hover/row:text-white",
  linear: "group-hover/row:bg-[#5e6ad2] group-hover/row:text-white",
  fireflies: "group-hover/row:bg-[#ff9500] group-hover/row:text-white",
  clickup: "group-hover/row:bg-[#7b68ee] group-hover/row:text-white",
  whatsapp: "group-hover/row:bg-[#25d366] group-hover/row:text-white",
};

/**
 * Same brand-color hover map as CONNECTOR_HOVER_TINT but scoped to the
 * unnamed `group` token that Card sets — used by the Integrations card so
 * hovering anywhere on that card flips every connector circle to brand color.
 */
const CONNECTOR_HOVER_TINT_FROM_CARD: Record<string, string> = {
  drive: "group-hover:bg-[#1a73e8] group-hover:text-white",
  google_drive: "group-hover:bg-[#1a73e8] group-hover:text-white",
  notion: "group-hover:bg-[#191919] group-hover:text-white",
  slack: "group-hover:bg-[#611f69] group-hover:text-white",
  linear: "group-hover:bg-[#5e6ad2] group-hover:text-white",
  fireflies: "group-hover:bg-[#ff9500] group-hover:text-white",
  clickup: "group-hover:bg-[#7b68ee] group-hover:text-white",
  whatsapp: "group-hover:bg-[#25d366] group-hover:text-white",
};

/**
 * Raw hex versions of the connector brand colors — used by the Integrations
 * "color cluster" visual (SVG circles need fill hex, not Tailwind class strings).
 */
const CONNECTOR_BRAND_HEX: Record<string, string> = {
  drive: "#1a73e8",
  google_drive: "#1a73e8",
  notion: "#191919",
  slack: "#611f69",
  linear: "#5e6ad2",
  fireflies: "#ff9500",
  clickup: "#7b68ee",
  whatsapp: "#25d366",
  // Abstract shape "connectors" — varied colors so the drifting bg feels diverse.
  "shape-hexagon": "#e91e63",
  "shape-diamond": "#9c27b0",
  "shape-triangle": "#3f51b5",
  "shape-square": "#00bcd4",
  "shape-plus": "#009688",
  "shape-star": "#d97706",
  "shape-pill": "#795548",
  "shape-ring": "#0ea5e9",
};

/**
 * Hover-only TEXT color (no background) for floating glyphs — they default to
 * muted-foreground (monochrome) and flip to brand color on card hover, all
 * happening inside a low-opacity wrapper so the effect stays atmospheric.
 */
const CONNECTOR_HOVER_TEXT_FROM_CARD: Record<string, string> = {
  drive: "group-hover:text-[#1a73e8]",
  google_drive: "group-hover:text-[#1a73e8]",
  notion: "group-hover:text-[#191919]",
  slack: "group-hover:text-[#611f69]",
  linear: "group-hover:text-[#5e6ad2]",
  fireflies: "group-hover:text-[#ff9500]",
  clickup: "group-hover:text-[#7b68ee]",
  whatsapp: "group-hover:text-[#25d366]",
  "shape-hexagon": "group-hover:text-[#e91e63]",
  "shape-diamond": "group-hover:text-[#9c27b0]",
  "shape-triangle": "group-hover:text-[#3f51b5]",
  "shape-square": "group-hover:text-[#00bcd4]",
  "shape-plus": "group-hover:text-[#009688]",
  "shape-star": "group-hover:text-[#d97706]",
  "shape-pill": "group-hover:text-[#795548]",
  "shape-ring": "group-hover:text-[#0ea5e9]",
};

/**
 * Floating brand-glyph background for the Integrations card's Full state.
 *
 * Glyphs sampled from the user's actual stack drift slowly left-to-right at low
 * opacity, like stars in a galaxy. The foreground (count + status) sits on top.
 * On card hover the opacity bumps slightly — the glyphs become more visible,
 * inviting the user to look. Motion stays constant (80s linear loop).
 *
 * Why bounded: regardless of whether totalCount is 15 or 500, we sample only 7
 * provider glyphs. The card's visual density never explodes — the background
 * stays calm and atmospheric at any scale.
 */
function DriftingGlyphBackground({ providers }: { providers: IntegrationProvider[] }) {
  // Split the providers across two halves so no icon is ever visible twice at
  // once — half A holds the first slice, half B holds the rest. As the strip
  // drifts, the visible composition transitions between the two distinct halves.
  const midpoint = Math.ceil(providers.length / 2);
  const halfA = providers.slice(0, midpoint);
  const halfB = providers.slice(midpoint);

  // Varied sizes (14–22, capped at 75% of foreground "15" text-3xl). Positions
  // avoid the center vertical band where the count + status text sits.
  const positionsA: Array<{ left: string; top: string; size: number }> = [
    { left: "4%", top: "10%", size: 16 },
    { left: "14%", top: "75%", size: 22 },
    { left: "26%", top: "8%", size: 14 },
    { left: "38%", top: "78%", size: 18 },
    { left: "52%", top: "10%", size: 20 },
    { left: "66%", top: "76%", size: 16 },
    { left: "80%", top: "8%", size: 22 },
    { left: "92%", top: "74%", size: 14 },
  ];
  const positionsB: Array<{ left: string; top: string; size: number }> = [
    { left: "5%", top: "76%", size: 20 },
    { left: "16%", top: "10%", size: 14 },
    { left: "30%", top: "74%", size: 16 },
    { left: "44%", top: "8%", size: 22 },
    { left: "58%", top: "78%", size: 18 },
    { left: "72%", top: "10%", size: 14 },
    { left: "85%", top: "76%", size: 22 },
  ];

  const renderHalf = (
    icons: IntegrationProvider[],
    positions: Array<{ left: string; top: string; size: number }>,
    keyPrefix: string,
  ) => (
    <div className="relative h-full w-1/2 shrink-0">
      {icons.map((p, i) => {
        const pos = positions[i % positions.length];
        return (
          <div
            key={`${keyPrefix}-${p.id}`}
            className={cn(
              "absolute text-muted-foreground transition-colors duration-500 ease-in-out",
              CONNECTOR_HOVER_TEXT_FROM_CARD[p.id],
            )}
            style={{ left: pos.left, top: pos.top }}
          >
            <ConnectorLogo type={p.id} size={pos.size} />
          </div>
        );
      })}
    </div>
  );
  return (
    <div
      className="pointer-events-none absolute right-0 bottom-0 left-0 top-[44px] overflow-hidden rounded-b-lg opacity-[0.10] transition-opacity duration-500 ease-in-out group-hover:opacity-[0.20]"
      style={{
        // Soft horizontal fade at left/right edges — glyphs ease in/out of view
        // rather than getting hard-clipped as they drift past the card boundary.
        maskImage: "linear-gradient(to right, transparent 0%, black 10%, black 90%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(to right, transparent 0%, black 10%, black 90%, transparent 100%)",
      }}
      aria-hidden
    >
      <div className="absolute inset-y-0 left-0 flex w-[200%] animate-[driftHorizontal_120s_linear_infinite]">
        {renderHalf(halfA, positionsA, "a")}
        {renderHalf(halfB, positionsB, "b")}
      </div>
    </div>
  );
}

/**
 * Right-column avatar-stack of required integrations for an ExploreRow.
 * - Circular tiles (20px), slight overlap (-4px) to read as a connected stack
 * - Default: muted bg + muted glyph (resting state, quiet)
 * - On row hover: each tile flips to its connector brand color with a white
 *   glyph — the card "wakes up" when reached for
 * - When > 3 integrations: show first 2 tiles + a muted "+N" circle (same
 *   shape as tiles, so the stack stays visually unified)
 * - When 0 integrations: render nothing, letting the row's text take full width
 */
function ExploreIntegrations({ integrations }: { integrations: string[] }) {
  const total = integrations.length;
  if (total === 0) return null;
  const visible = total <= 3 ? integrations : integrations.slice(0, 2);
  const overflow = total - visible.length;
  return (
    <div className="flex shrink-0 items-center" aria-label="Required integrations">
      {visible.map((integration, idx) => (
        <div
          key={integration}
          className={cn(
            "flex size-5 items-center justify-center rounded-full border border-card bg-muted text-muted-foreground transition-colors duration-300 ease-in-out",
            CONNECTOR_HOVER_TINT[integration],
          )}
          style={{ marginLeft: idx === 0 ? 0 : -4 }}
        >
          <ConnectorLogo type={integration} size={11} />
        </div>
      ))}
      {overflow > 0 ? (
        <div
          className="flex size-5 items-center justify-center rounded-full border border-card bg-muted text-[9px] font-medium leading-none text-muted-foreground"
          style={{ marginLeft: -4 }}
        >
          +{overflow}
        </div>
      ) : null}
    </div>
  );
}

function ExploreRow({ suggestion }: { suggestion: ExploreSuggestion }) {
  return (
    <li>
      <Link to={suggestion.href} className={cn(CARD_ROW_LINK, "py-1.5")}>
        <div className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", SKETCH_TILE)}>
          <CategoryIcon category={suggestion.category} size={12} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{suggestion.name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{suggestion.description}</p>
        </div>
        <ExploreIntegrations integrations={suggestion.integrations} />
      </Link>
    </li>
  );
}

/** Right-column glyphs per non-integration error reason. Rendered inside a muted gray circle so the left red tile stays the dominant alarm; this one is just an identifier. */
const ERROR_REASON_ICON: Record<Exclude<NonNullable<ActiveSkill["errorReason"]>, "integration">, PhosphorIcon> = {
  config: WrenchIcon,
  quota: GaugeIcon,
  permission: LockIcon,
  execution: WarningOctagonIcon,
};

const ERROR_REASON_LABEL: Record<NonNullable<ActiveSkill["errorReason"]>, string> = {
  integration: "Integration disconnected",
  config: "Needs setup",
  quota: "Usage limit reached",
  permission: "Permission revoked",
  execution: "Run keeps failing",
};

function ActiveSkillRow({ skill }: { skill: ActiveSkill }) {
  const failed = skill.error === true;
  const reason: NonNullable<ActiveSkill["errorReason"]> = failed
    ? (skill.errorReason ?? (skill.errorIntegration ? "integration" : "execution"))
    : "integration"; // unused when !failed
  const ReasonIcon = reason !== "integration" ? ERROR_REASON_ICON[reason] : null;

  return (
    <li>
      <Link to={skill.href} className={CARD_ROW_LINK}>
        <div
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md",
            failed ? ERROR_TILE : SKETCH_TILE,
          )}
        >
          {failed ? <WarningIcon size={12} weight="fill" /> : <CategoryIcon category={skill.category} size={12} />}
        </div>
        <p className="min-w-0 flex-1 truncate text-sm">{skill.name}</p>
        {failed ? (
          <div
            className="flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-red-700/50 text-red-700 dark:border-red-400/50 dark:text-red-400"
            aria-label={ERROR_REASON_LABEL[reason]}
            title={ERROR_REASON_LABEL[reason]}
          >
            {reason === "integration" && skill.errorIntegration ? (
              <ConnectorLogo type={skill.errorIntegration} size={11} />
            ) : ReasonIcon ? (
              <ReasonIcon size={11} weight="bold" />
            ) : null}
          </div>
        ) : (
          <p className="shrink-0 text-xs text-muted-foreground">{skill.lastUsedLabel}</p>
        )}
      </Link>
    </li>
  );
}

// ── Team card ────────────────────────────────────────────────────────────────

function TeamCard({ team }: { team: TeamSummary }) {
  const empty = team.totalCount <= 1;
  // Cap the row at 5 chips total. When total > 5, surrender one slot to the
  // "+N" overflow chip; otherwise show up to 5 members with no overflow chip.
  const MAX_CHIPS = 5;
  const needsOverflow = team.totalCount > MAX_CHIPS;
  const visible = team.members.slice(0, needsOverflow ? MAX_CHIPS - 1 : MAX_CHIPS);
  const overflow = team.totalCount - visible.length;

  return (
    <Card>
      <header className={CARD_HEADER}>
        <h2 className={CARD_TITLE}>Team</h2>
        <CardHeaderArrow to="/team" label="Open team" />
      </header>

      <div className="flex items-baseline gap-1.5">
        <p className="text-xl font-semibold leading-none tracking-tight tabular-nums">{team.totalCount}</p>
        <p className="text-xs text-muted-foreground">{team.totalCount === 1 ? "member" : "members"}</p>
      </div>

      {empty ? (
        team.pendingInvites > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {team.pendingInvites} {team.pendingInvites === 1 ? "invite" : "invites"} pending
          </p>
        ) : null
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          {team.humanCount} humans
          {team.agentCount > 0 ? ` · ${team.agentCount} agents` : ""}
          {team.pendingInvites > 0 ? ` · ${team.pendingInvites} pending` : ""}
        </p>
      )}

      <div className="mt-3 flex items-center">
        {visible.map((member, idx) =>
          member.imageUrl ? (
            <img
              key={member.id}
              src={member.imageUrl}
              alt={member.initials}
              title={member.initials}
              className="size-[28px] rounded-full border-[1.5px] border-card object-cover"
              style={{ marginLeft: idx === 0 ? 0 : -8 }}
            />
          ) : (
            <div
              key={member.id}
              title={member.initials}
              className={cn(
                "flex size-[28px] items-center justify-center rounded-full border-[1.5px] border-card text-[11px] font-medium",
                member.tint,
              )}
              style={{ marginLeft: idx === 0 ? 0 : -8 }}
            >
              {member.initials}
            </div>
          ),
        )}
        {overflow > 0 && !empty ? (
          <div
            className="flex size-[28px] items-center justify-center rounded-full border-[1.5px] border-card bg-muted text-[11px] font-medium text-muted-foreground"
            style={{ marginLeft: -8 }}
          >
            +{overflow}
          </div>
        ) : null}
        {empty ? (
          <Link
            to="/team"
            aria-label="Invite teammate"
            className="flex size-[28px] items-center justify-center rounded-full border border-dashed border-border/80 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            style={{ marginLeft: visible.length > 0 ? -5 : 0 }}
          >
            <PlusIcon size={14} />
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

// ── Integrations card ────────────────────────────────────────────────────────

function IntegrationsCard({ summary }: { summary: IntegrationSummary }) {
  const empty = summary.totalCount === 0;
  const hasError = summary.needsReconnectCount > 0;
  // Stat-card pivot: above the icon-stack threshold the avatar pattern breaks
  // (8+ logos become an indecipherable cluster + "+N more"). Switch to a
  // metric-card layout in that regime — count + status + insight instead of
  // icons. Identity lives on /integrations where it's actually scannable.
  const STACK_THRESHOLD = 7;
  const useStatCard = !empty && summary.totalCount > STACK_THRESHOLD;
  // Avatar stack: up to STACK_THRESHOLD slots; "+N" chip eats one when beyond.
  const needsOverflow = summary.totalCount > STACK_THRESHOLD;
  const visible = summary.providers.slice(0, needsOverflow ? STACK_THRESHOLD - 1 : STACK_THRESHOLD);
  const overflow = summary.totalCount - visible.length;

  // Empty-state structure preserves slot count so the row's visual rhythm matches mature.
  const emptyPlaceholderKeys = ["a", "b", "c", "d"];

  return (
    <Card>
      {useStatCard ? <DriftingGlyphBackground providers={summary.providers} /> : null}
      <header
        className={cn(
          CARD_HEADER,
          // Error variant swaps the muted band + border for red — same shape,
          // different state-color.
          hasError && "bg-red-500/10 border-red-500/30",
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className={CARD_TITLE}>Integrations</h2>
          {hasError ? (
            <WarningIcon
              size={12}
              weight="fill"
              className="shrink-0 text-red-700 dark:text-red-400"
              aria-label={`${summary.needsReconnectCount} ${summary.needsReconnectCount === 1 ? "needs" : "need"} reconnect`}
            />
          ) : null}
        </div>
        <CardHeaderArrow to="/integrations" label="Open integrations" />
      </header>

      {useStatCard ? (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center text-center">
          <p className="text-3xl font-semibold leading-none tabular-nums">{summary.totalCount}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            connected ·{" "}
            {hasError
              ? `${summary.needsReconnectCount} need${summary.needsReconnectCount === 1 ? "s" : ""} attention`
              : "all healthy"}
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-1.5">
            <p
              className={cn(
                "text-xl font-semibold leading-none tracking-tight tabular-nums",
                empty && "text-muted-foreground",
              )}
            >
              {summary.totalCount}
            </p>
            <p className="text-xs text-muted-foreground">connected</p>
          </div>
          <div className="mt-3 flex items-center">
            {empty ? (
              <>
                <Link
                  to="/integrations"
                  aria-label="Connect a tool"
                  className="flex size-[22px] items-center justify-center rounded-full border border-dashed border-border/80 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                >
                  <PlusIcon size={11} />
                </Link>
                {emptyPlaceholderKeys.map((key) => (
                  <div
                    key={key}
                    className="size-[22px] rounded-full border-[1.5px] border-card bg-muted/50 opacity-40"
                    style={{ marginLeft: -5 }}
                  />
                ))}
              </>
            ) : (
              <>
                {visible.map((provider, idx) => (
                  <div
                    key={provider.id}
                    className={cn(
                      "flex size-[22px] items-center justify-center rounded-full border-[1.5px] border-card bg-muted text-muted-foreground transition-colors duration-300 ease-in-out",
                      CONNECTOR_HOVER_TINT_FROM_CARD[provider.id],
                    )}
                    style={{ marginLeft: idx === 0 ? 0 : -5 }}
                    title={provider.id}
                  >
                    <ConnectorLogo type={provider.id} size={11} />
                  </div>
                ))}
                {overflow > 0 ? (
                  <div
                    className="flex size-[22px] items-center justify-center rounded-full border-[1.5px] border-card bg-muted text-[10px] font-medium text-muted-foreground"
                    style={{ marginLeft: -5 }}
                  >
                    +{overflow}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

// ── Usage card ───────────────────────────────────────────────────────────────

/**
 * Credit-based usage display.
 *
 * The donut is a stacked breakdown: each colored segment is a usage category
 * (messages / automations / tool calls). The visible arcs together fill the
 * "used" portion of the ring; the remaining gray track is what's still
 * available. The credits-left number sits at the donut's center.
 *
 * The legend below the donut shows the same data numerically so the user gets
 * both a glance-shape (donut) and exact counts (rows).
 */
function UsageCard({ usage }: { usage: UsageSummary }) {
  const used = Math.max(usage.creditsTotal - usage.creditsRemaining, 0);
  const percentUsed = usage.creditsTotal > 0 ? (used / usage.creditsTotal) * 100 : 0;
  const isCritical = percentUsed >= 95;

  // SVG donut math (100×100 viewBox scales cleanly).
  const RADIUS = 40;
  const STROKE = 9;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  // Segments are sized as a share of the FULL allowance (not just used) so the
  // visible arcs end at exactly the "used" point on the ring, leaving the rest
  // of the track unfilled.
  const segments = [
    { key: "messages", label: "Messages", value: usage.breakdown.messages, color: "#FEED01" },
    {
      key: "automations",
      label: "Automations",
      value: usage.breakdown.automations,
      color: "#6366f1", // indigo
    },
    {
      key: "toolCalls",
      label: "Tool calls",
      value: usage.breakdown.toolCalls,
      color: "#ec4899", // pink
    },
  ] as const;

  // Pre-compute each segment's arc length + starting offset on the ring.
  let cursor = 0;
  const arcs = segments.map((seg) => {
    const length = usage.creditsTotal > 0 ? (seg.value / usage.creditsTotal) * CIRCUMFERENCE : 0;
    const arc = { ...seg, length, offset: cursor };
    cursor += length;
    return arc;
  });

  return (
    <Card>
      <header className={CARD_HEADER}>
        <h2 className={CARD_TITLE}>Usage</h2>
        <CardHeaderArrow to="/usage" label="Open usage" />
      </header>

      <div className="relative flex items-center justify-center">
        <svg viewBox="0 0 100 100" className="w-full max-w-[140px] -rotate-90">
          <title>Credit usage breakdown</title>
          {/* Empty track — the portion still available. */}
          <circle
            cx="50"
            cy="50"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            className="text-muted"
          />
          {/* Stacked category segments (only render non-zero). */}
          {arcs.map((arc) =>
            arc.length > 0 ? (
              <circle
                key={arc.key}
                cx="50"
                cy="50"
                r={RADIUS}
                fill="none"
                stroke={arc.color}
                strokeWidth={STROKE}
                strokeDasharray={`${arc.length} ${CIRCUMFERENCE - arc.length}`}
                strokeDashoffset={-arc.offset}
              />
            ) : null,
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p
            className={cn(
              "text-2xl font-semibold leading-none tracking-tight tabular-nums",
              isCritical && "text-red-700 dark:text-red-400",
            )}
          >
            {usage.creditsRemaining.toLocaleString()}
          </p>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">credits left</p>
        </div>
      </div>

      <ul className="mt-4 space-y-1.5">
        {segments.map((seg) => (
          <li key={seg.key} className="flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ backgroundColor: seg.color }} />
              <span className="text-foreground">{seg.label}</span>
            </span>
            <span className="font-medium tabular-nums text-muted-foreground">{seg.value.toLocaleString()}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto flex items-center justify-between pt-3 text-xs text-muted-foreground tabular-nums">
        <span>
          {used.toLocaleString()} / {usage.creditsTotal.toLocaleString()}
        </span>
        <span>{usage.resetsInDays === 0 ? "Resets today" : `Resets in ${usage.resetsInDays}d`}</span>
      </div>
    </Card>
  );
}

// ── Files card ───────────────────────────────────────────────────────────────

function FilesCard({ files }: { files: FilesSummary }) {
  // Empty when there's literally nothing memorized yet — sum the entity counts.
  const totalKnown =
    files.entityCounts.people +
    files.entityCounts.companies +
    files.entityCounts.projects +
    files.entityCounts.databases +
    files.entityCounts.documents;
  const isEmpty = totalKnown === 0;

  return (
    <Card>
      <header className={CARD_HEADER}>
        <h2 className={CARD_TITLE}>Files</h2>
        <CardHeaderArrow to="/files" label="Open files" />
      </header>

      <Link
        to="/files"
        className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-muted-foreground transition-colors hover:bg-muted"
      >
        <MagnifyingGlassIcon size={14} />
        <span className="text-sm">Search memory</span>
      </Link>

      {isEmpty ? (
        <div className="mt-3">
          <VoiceLine>I'll start building this as you connect tools and we talk.</VoiceLine>
        </div>
      ) : null}

      <ul className="mt-3 flex flex-1 flex-col justify-between">
        <FilesEntityRow label="People" count={files.entityCounts.people} empty={isEmpty} />
        <FilesEntityRow label="Companies" count={files.entityCounts.companies} empty={isEmpty} />
        <FilesEntityRow label="Projects" count={files.entityCounts.projects} empty={isEmpty} />
        <FilesEntityRow label="Databases" count={files.entityCounts.databases} empty={isEmpty} />
        <FilesEntityRow label="Documents" count={files.entityCounts.documents} empty={isEmpty} />
      </ul>
    </Card>
  );
}

function RecentlyIndexedRow({ file }: { file: RecentlyIndexedFile }) {
  return (
    <li className="flex items-center gap-3">
      <div className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", SKETCH_TILE)}>
        <NewspaperIcon size={12} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{file.fileName}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{file.source}</p>
      </div>
      <p className="shrink-0 text-xs text-muted-foreground">{file.syncedLabel}</p>
    </li>
  );
}

function FilesEntityRow({ label, count, empty }: { label: string; count: number; empty: boolean }) {
  return (
    <li className="flex items-center justify-between text-sm">
      <span className="text-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", empty && "text-muted-foreground/70")}>{empty ? "—" : count}</span>
    </li>
  );
}

// ── Shared building blocks ───────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="group relative flex h-full min-h-0 flex-col rounded-lg border border-border bg-card p-4">
      {children}
      {/* DEBUG: dashed line marks the bottom of the inner content area (just
          inside the card's bottom padding). Single line to remove globally. */}
      <div className="pointer-events-none absolute right-4 bottom-4 left-4 border-t border-dashed border-pink-500" />
    </section>
  );
}

/**
 * Small right-aligned arrow link for card headers — hidden by default, fades in
 * on card hover. Keeps the header quiet at rest while still offering a quick
 * route to the full page.
 */
function CardHeaderArrow({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      aria-label={label}
      className="text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
    >
      <ArrowRightIcon size={14} />
    </Link>
  );
}

function VoiceLine({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("text-sm leading-relaxed text-muted-foreground", className)}>{children}</p>;
}
