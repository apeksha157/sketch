/**
 * /home/onboarding-concept-2 — Tile dashboard.
 *
 * For new users, the home dashboard *is* the setup hub. Instead of the
 * usual hero (greeting → chat input → quick actions → recents), we render:
 *
 *   1. A welcome header with progress bar showing N of 5 done
 *   2. A grid of 5 setup tiles — one per action, each with icon + title +
 *      description + status/CTA. Done tiles show "Connected" status with a
 *      check; next tile is subtly highlighted; pending tiles are neutral.
 *   3. A "skip setup" link beneath the grid for users who'd rather explore
 *
 * Once all 5 are done in production, this view dissolves into the normal
 * dashboard. For design review there are two routes:
 *
 *   /home/onboarding-concept-2      — fresh start (0 of 5)
 *   /home/onboarding-concept-2-mid  — mid-flow (2 of 5, steps 1 + 2 done)
 *
 * Steps follow Himanshu's spec order.
 */
import {
  ArrowRightIcon,
  CalendarTimeIcon,
  ChannelsIcon,
  CheckIcon,
  type IconProps,
  PuzzleIcon,
  SparklesIcon,
  UserPlusIcon,
} from "@/components/sketch/icons";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_FILES_EMPTY } from "@/routes/sketch/mock-data";
import { firstNameOf, sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { cn } from "@sketch/ui/lib/utils";
import { createRoute, useNavigate } from "@tanstack/react-router";
import type { ComponentType } from "react";

interface SetupTileDef {
  id: string;
  title: string;
  description: string;
  icon: ComponentType<IconProps>;
  ctaLabel: string;
  /** Approx time-to-complete, shown as a small meta line. */
  time: string;
}

const SETUP_TILES: SetupTileDef[] = [
  {
    id: "channel",
    title: "Connect channels",
    description: "Plug Sketch into Slack so it can reply in threads and jump in when @mentioned.",
    icon: ChannelsIcon,
    ctaLabel: "Connect",
    time: "~30 sec",
  },
  {
    id: "integration",
    title: "Add integrations",
    description: "Wire up Notion, Gmail, Linear, and 300+ others so Sketch has tools to work with.",
    icon: PuzzleIcon,
    ctaLabel: "Connect",
    time: "~2 min",
  },
  {
    id: "teammate",
    title: "Invite teammates",
    description: "Sketch gets sharper the more of your team it works with — bring them in now.",
    icon: UserPlusIcon,
    ctaLabel: "Invite",
    time: "~1 min",
  },
  {
    id: "skill",
    title: "Create a skill",
    description: "Teach Sketch a workflow once — your whole team can re-run it forever.",
    icon: SparklesIcon,
    ctaLabel: "Build",
    time: "~3 min",
  },
  {
    id: "schedule",
    title: "Schedule a task",
    description: "Pick a cadence and Sketch runs the skill on its own. Set it and forget it.",
    icon: CalendarTimeIcon,
    ctaLabel: "Schedule",
    time: "~1 min",
  },
];

interface PageState {
  /** IDs of steps that have been completed. */
  completedIds: string[];
}

function HomeOnboardingConcept2PageImpl({ state }: { state: PageState }) {
  const auth = useSketchAuth();
  const navigate = useNavigate();
  const firstName = firstNameOf(auth);

  const doneCount = state.completedIds.length;
  const total = SETUP_TILES.length;
  const nextId = SETUP_TILES.find((t) => !state.completedIds.includes(t.id))?.id;
  const allDone = doneCount === total;

  return (
    <SketchShell
      profile={{
        name: auth.displayName,
        isAdmin: auth.role === "admin",
        identifier: auth.displayIdentifier,
      }}
      orgName={auth.orgName}
      files={MOCK_FILES_EMPTY}
    >
      <div className="mx-auto w-full max-w-4xl px-10 py-8">
        {/* Hero — welcome + progress. */}
        <header>
          <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.14em" }}>
            Get started
          </span>
          <h1 className="mt-[10px] text-[22px] font-semibold text-foreground">
            {allDone ? `You're all set, ${firstName}.` : `Set up Sketch, ${firstName}.`}
          </h1>
          <p className="mt-[6px] text-[14px] text-muted-foreground">
            {allDone
              ? "Setup complete. The full dashboard is right behind this — let's go."
              : "Five things to connect, then I'm ready to actually do work for you."}
          </p>

          <ProgressBar doneCount={doneCount} total={total} />
        </header>

        {/* The 5-tile grid. 2 columns; the 5th tile takes the whole bottom row. */}
        <div className="mt-[28px] grid grid-cols-1 gap-[12px] md:grid-cols-2">
          {SETUP_TILES.map((tile, idx) => (
            <SetupTile
              key={tile.id}
              tile={tile}
              index={idx + 1}
              done={state.completedIds.includes(tile.id)}
              isNext={tile.id === nextId}
              isLast={idx === SETUP_TILES.length - 1}
              onClick={() => navigate({ to: "/chat/$conversationId", params: { conversationId: "active" } })}
            />
          ))}
        </div>

        {/* Soft escape hatch — power users who want to explore on their own. */}
        <div className="mt-[24px] flex items-center justify-center">
          <button
            type="button"
            onClick={() => navigate({ to: "/home/default" })}
            className={cn(
              "text-[12px] text-muted-foreground hover:text-foreground transition-colors duration-100 ease-out",
              "cursor-pointer underline-offset-[3px] hover:underline",
            )}
          >
            Skip setup and explore the dashboard
          </button>
        </div>
      </div>
    </SketchShell>
  );
}

function ProgressBar({ doneCount, total }: { doneCount: number; total: number }) {
  const pct = (doneCount / total) * 100;
  return (
    <div className="mt-[18px]">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.12em" }}>
          Progress
        </span>
        <span className="text-[12px] text-foreground">
          <span className="font-medium">{doneCount}</span>
          <span className="text-muted-foreground"> of {total} done</span>
        </span>
      </div>
      <div className="mt-[6px] h-[6px] w-full overflow-hidden rounded-full bg-foreground/[0.07]">
        <div
          className="h-full rounded-full bg-[#FEED01] transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function SetupTile({
  tile,
  index,
  done,
  isNext,
  isLast,
  onClick,
}: {
  tile: SetupTileDef;
  index: number;
  done: boolean;
  isNext: boolean;
  isLast: boolean;
  onClick: () => void;
}) {
  const Icon = tile.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex min-h-[150px] flex-col rounded-[12px] border bg-card text-left",
        "transition-[background-color,border-color,transform,box-shadow] duration-150 ease-out cursor-pointer",
        "hover:-translate-y-[0.5px] hover:shadow-[0_3px_10px_-2px_rgba(0,0,0,0.08)]",
        "px-[18px] py-[16px]",
        done && "bg-foreground/[0.025] border-border/70",
        !done && isNext && "border-foreground/30 hover:border-foreground/40",
        !done && !isNext && "border-border hover:border-foreground/20",
        // The fifth tile spans both columns on md+ so the layout doesn't end
        // with an orphaned half-row. On mobile it just stacks naturally.
        isLast && "md:col-span-2",
      )}
    >
      {/* Top row — index badge + icon. */}
      <div className="flex items-center gap-[10px]">
        <span
          className={cn(
            "inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[10px] font-mono",
            done && "bg-[#22c55e]/15 text-[#22c55e] dark:bg-[#22c55e]/20",
            !done && isNext && "bg-foreground text-background",
            !done && !isNext && "bg-foreground/[0.07] text-foreground/55",
          )}
          aria-hidden
        >
          {done ? <CheckIcon size={12} weight="bold" /> : index}
        </span>

        <span
          className={cn(
            "flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[8px]",
            done && "bg-[#22c55e]/12 text-[#22c55e]",
            !done && "bg-[#FAF3BD] text-[#8B7A00] dark:bg-[#322B0C] dark:text-[#FEED01]",
          )}
          aria-hidden
        >
          <Icon size={16} weight="regular" />
        </span>

        {/* NEXT tag on the active tile so the entry point reads at a glance. */}
        {isNext && !done && (
          <span
            className="ml-auto font-mono text-[9px] uppercase text-foreground/70"
            style={{ letterSpacing: "0.14em" }}
          >
            Next
          </span>
        )}
        {done && (
          <span
            className="ml-auto font-mono text-[9px] uppercase text-[#22c55e]/85"
            style={{ letterSpacing: "0.14em" }}
          >
            Done
          </span>
        )}
      </div>

      {/* Title + description. */}
      <div className="mt-[12px] flex min-w-0 flex-col gap-[4px]">
        <span
          className={cn("text-[15px] font-medium leading-[1.25]", done ? "text-muted-foreground" : "text-foreground")}
        >
          {tile.title}
        </span>
        <span
          className={cn("text-[12.5px] leading-[1.45]", done ? "text-muted-foreground/70" : "text-muted-foreground")}
        >
          {tile.description}
        </span>
      </div>

      {/* Footer — time + CTA on the right. */}
      <div className="mt-auto flex items-center justify-between pt-[14px]">
        <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.10em" }}>
          {done ? "Connected" : tile.time}
        </span>

        {!done && (
          <span
            className={cn(
              "inline-flex items-center gap-[5px] rounded-[8px] px-[10px] py-[5px] text-[12px] font-medium",
              "transition-colors duration-100 ease-out",
              isNext
                ? "bg-foreground text-background"
                : "bg-foreground/[0.06] text-foreground/75 group-hover:bg-foreground/[0.10]",
            )}
          >
            {tile.ctaLabel}
            <ArrowRightIcon size={11} weight="bold" aria-hidden />
          </span>
        )}
      </div>
    </button>
  );
}

// ── Two route exports — fresh start + mid-flow ─────────────────────────────

export const homeOnboardingConcept2Route = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/onboarding-concept-2",
  component: () => <HomeOnboardingConcept2PageImpl state={{ completedIds: [] }} />,
});

export const homeOnboardingConcept2MidRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/onboarding-concept-2-mid",
  component: () => <HomeOnboardingConcept2PageImpl state={{ completedIds: ["channel", "integration"] }} />,
});
