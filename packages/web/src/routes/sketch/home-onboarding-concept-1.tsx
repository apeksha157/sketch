/**
 * /home/onboarding-concept-1 — Sketch-led conversation.
 *
 * The chat itself is the onboarding surface. No overlays, no tray, no coach
 * marks. A new user lands in a chat thread where Sketch greets them, posts a
 * progress card listing the 5 setup steps, then walks through them one at a
 * time as conversational messages with inline action cards.
 *
 * Steps follow Himanshu's spec order: channels → integrations → teammates →
 * skill → schedule.
 *
 * This file exports two routes that share the same page component but
 * different state, so the design review can screenshot the flow at two
 * points (start + mid):
 *
 *   /home/onboarding-concept-1      — step 1 (Connect Slack), 0 of 5 done
 *   /home/onboarding-concept-1-mid  — step 3 (Invite teammates), 2 of 5 done,
 *                                     prior conversation visible above
 */
import { ChatInput } from "@/components/sketch/chat-input";
import { SketchMessage, UserMessage } from "@/components/sketch/chat-message";
import {
  ArrowLeftIcon,
  CalendarTimeIcon,
  ChannelsIcon,
  CheckIcon,
  DotsIcon,
  PuzzleIcon,
  SlackBrandIcon,
  SparklesIcon,
  UserPlusIcon,
} from "@/components/sketch/icons";
import { InlineArtifact } from "@/components/sketch/inline-artifact";
import { SketchShell } from "@/components/sketch/shell";
import { MOCK_FILES_EMPTY } from "@/routes/sketch/mock-data";
import { sketchRoute, useSketchAuth } from "@/routes/sketch/route";
import { cn } from "@sketch/ui/lib/utils";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

interface StepDef {
  id: string;
  label: string;
  icon: typeof ChannelsIcon;
}

const STEPS: StepDef[] = [
  { id: "channel", label: "Connect channels", icon: ChannelsIcon },
  { id: "integration", label: "Add integrations", icon: PuzzleIcon },
  { id: "teammate", label: "Invite teammates", icon: UserPlusIcon },
  { id: "skill", label: "Create a skill", icon: SparklesIcon },
  { id: "schedule", label: "Schedule a task", icon: CalendarTimeIcon },
];

interface ActionContent {
  kind: string;
  title: string;
  description: string;
  icon: typeof ChannelsIcon;
  tags: string[];
  primaryLabel: string;
  intro: string;
}

const STEP_CONTENT: Record<string, ActionContent> = {
  channel: {
    kind: "Step 1 of 5 · Connect channels",
    title: "Connect Slack",
    description: "Authorize Sketch to read and post in the channels you choose. Takes about 30 seconds.",
    icon: SlackBrandIcon,
    tags: ["~30 sec", "OAuth"],
    primaryLabel: "Connect Slack",
    intro: "First — let's connect a channel where I can listen. Slack works best.",
  },
  integration: {
    kind: "Step 2 of 5 · Add integrations",
    title: "Hook up Notion",
    description: "Connect Notion so I can read your docs, search them, and reference them in my answers.",
    icon: PuzzleIcon,
    tags: ["~2 min", "OAuth"],
    primaryLabel: "Connect Notion",
    intro: "Now let's give me some tools to work with. Notion's the most common starting point.",
  },
  teammate: {
    kind: "Step 3 of 5 · Invite teammates",
    title: "Invite your team",
    description:
      "Sketch gets sharper the more of your team it works with. Send a magic link to anyone you want on board.",
    icon: UserPlusIcon,
    tags: ["~1 min", "Email"],
    primaryLabel: "Send invites",
    // Phrased as a clean transition rather than re-stating what was just
    // acknowledged in the prior messages ("Done — Slack is connected" etc.) —
    // avoids the awkward triple-confirmation we had before.
    intro: "Now let's bring your team in.",
  },
  skill: {
    kind: "Step 4 of 5 · Create a skill",
    title: "Build your first skill",
    description:
      "Teach me a workflow once and your team can re-run it forever. I'll suggest one based on what you've connected.",
    icon: SparklesIcon,
    tags: ["~3 min", "Recommended"],
    primaryLabel: "Build a skill",
    intro: "Time to give me a job to do. Skills are reusable workflows — your team can run them anytime.",
  },
  schedule: {
    kind: "Step 5 of 5 · Schedule a task",
    title: "Set a schedule",
    description:
      "Pick a cadence and I'll run the skill on its own from there. Recurring digests, follow-ups, reports — anything you'd do every Monday.",
    icon: CalendarTimeIcon,
    tags: ["~1 min", "Automation"],
    primaryLabel: "Set schedule",
    intro: "Last one — let's put a skill on a schedule so I can run on my own.",
  },
};

interface PageState {
  /** 1-based index of the current step (1–5). */
  currentStep: number;
  /** How the prior steps were handled, in order. Length === currentStep - 1. */
  history: Array<{ stepId: string; outcome: "connected" | "skipped" }>;
}

function HomeOnboardingConcept1PageImpl({ state }: { state: PageState }) {
  const auth = useSketchAuth();
  const navigate = useNavigate();
  const firstName = auth.displayName.trim().split(/\s+/)[0] || "there";

  const doneCount = state.history.filter((h) => h.outcome === "connected").length;
  const currentStepDef = STEPS[state.currentStep - 1];
  const currentContent = STEP_CONTENT[currentStepDef.id];

  // Pin the chat to the bottom on mount so the current step + action card are
  // visible without manual scrolling — same behaviour the user would see in a
  // real chat after Sketch posts a new message.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  function handleSubmit(_message: string) {
    void navigate({ to: "/chat/$conversationId", params: { conversationId: "active" } });
  }

  return (
    <SketchShell
      profile={{
        name: auth.displayName,
        isAdmin: auth.role === "admin",
        identifier: auth.displayIdentifier,
      }}
      orgName={auth.orgName}
      files={MOCK_FILES_EMPTY}
      // Disable the shell's outer scroll so the chat area is the sole scroll
      // container — otherwise tall content scrolls both the page and the chat
      // thread, leaving the chat input mid-page rather than pinned.
      mainClassName="overflow-hidden"
    >
      <div className="flex h-full min-h-0 flex-col">
        <ChatHeader title="Getting set up with Sketch" onBack={() => navigate({ to: "/home/default" })} />

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-[20px] pt-[20px] pb-[12px]">
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-[18px]">
            {/* Opening message — greeting + the whole 5-step plan as a
             *    compact card so the user sees the full arc. */}
            <SketchMessage>
              Welcome to Sketch, {firstName}. I'll get you set up in about three minutes — here's the plan:
              <ProgressCard
                steps={STEPS}
                doneCount={doneCount}
                currentStep={state.currentStep}
                completedIds={state.history.filter((h) => h.outcome === "connected").map((h) => h.stepId)}
              />
            </SketchMessage>

            {/* Prior conversation (only renders when state has history) —
             *    condensed echo of what the user did at each earlier step so
             *    the chat reads as continuous, not jumping into the middle. */}
            {state.history.map((entry) => (
              <HistoryExchange key={entry.stepId} stepId={entry.stepId} outcome={entry.outcome} />
            ))}

            {/* Current step — intro line + inline action card. */}
            <SketchMessage>
              {currentContent.intro}
              <InlineArtifact
                kind={currentContent.kind}
                title={currentContent.title}
                description={currentContent.description}
                icon={currentContent.icon}
                tags={currentContent.tags}
                primaryAction={{ label: currentContent.primaryLabel, onClick: () => {} }}
                secondaryAction={{ label: "Skip for now", onClick: () => {} }}
              />
            </SketchMessage>
          </div>
        </div>

        {/* The same chat input pattern as the regular chat surface — the user
         * is never trapped in the onboarding flow. */}
        <div className={cn("shrink-0 border-t bg-background", "border-border")} style={{ borderTopWidth: "0.5px" }}>
          <div className="mx-auto w-full max-w-[720px] px-[20px] pt-[12px] pb-[18px]">
            <ChatInput onSubmit={handleSubmit} placeholder="Reply to Sketch or ask anything…" />
          </div>
        </div>
      </div>
    </SketchShell>
  );
}

/**
 * Renders a compact "user did X, Sketch acknowledged" pair for a previously
 * completed step. Kept short so the prior conversation reads as scrollback
 * context, not a wall of text the user has to re-read.
 */
function HistoryExchange({ stepId, outcome }: { stepId: string; outcome: "connected" | "skipped" }) {
  const content = STEP_CONTENT[stepId];
  if (outcome === "connected") {
    return (
      <>
        <UserMessage>{content.primaryLabel}</UserMessage>
        <SketchMessage>Done — {ackPhrase(stepId)}.</SketchMessage>
      </>
    );
  }
  return (
    <>
      <UserMessage>Skip for now</UserMessage>
      <SketchMessage>No worries, we can come back to that later.</SketchMessage>
    </>
  );
}

function ackPhrase(stepId: string): string {
  switch (stepId) {
    case "channel":
      return "Slack is connected";
    case "integration":
      return "Notion is connected";
    case "teammate":
      return "invites are out";
    case "skill":
      return "your skill is saved";
    case "schedule":
      return "your schedule is set";
    default:
      return "saved";
  }
}

/**
 * The 5-step "what we'll cover" card.
 */
function ProgressCard({
  steps,
  doneCount,
  currentStep,
  completedIds,
}: {
  steps: StepDef[];
  doneCount: number;
  currentStep: number;
  completedIds: string[];
}) {
  const total = steps.length;

  return (
    <div
      className={cn("mt-[12px] rounded-[12px] border bg-card px-[16px] py-[14px]", "border-border")}
      style={{ borderWidth: "0.5px" }}
    >
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.08em" }}>
          Your setup
        </span>
        <span className="text-[11px] text-muted-foreground">
          {doneCount} of {total} done
        </span>
      </div>

      <ul className="mt-[8px] flex flex-col gap-[1px]">
        {steps.map((step, idx) => (
          <ProgressRow
            key={step.id}
            step={step}
            index={idx + 1}
            done={completedIds.includes(step.id)}
            isNext={idx + 1 === currentStep}
          />
        ))}
      </ul>
    </div>
  );
}

function ProgressRow({
  step,
  index,
  done,
  isNext,
}: {
  step: StepDef;
  index: number;
  done: boolean;
  isNext: boolean;
}) {
  const Icon = step.icon;
  return (
    <li
      className={cn("flex items-center gap-[10px] rounded-[6px] px-[8px] py-[5px]", isNext && "bg-foreground/[0.05]")}
    >
      <span
        className={cn(
          "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[9px] font-mono",
          done && "bg-foreground/15 text-foreground/55",
          !done && isNext && "bg-foreground text-background",
          !done && !isNext && "bg-foreground/[0.07] text-foreground/55",
        )}
        aria-hidden
      >
        {done ? <CheckIcon size={10} weight="bold" /> : index}
      </span>
      <Icon size={14} className="shrink-0 text-foreground/70" aria-hidden />
      <span
        className={cn(
          "min-w-0 flex-1 text-[13px]",
          done && "text-muted-foreground line-through decoration-muted-foreground/50",
          !done && "text-foreground",
        )}
      >
        {step.label}
      </span>
      {isNext && (
        <span className="font-mono text-[9px] uppercase text-muted-foreground" style={{ letterSpacing: "0.12em" }}>
          next
        </span>
      )}
    </li>
  );
}

function ChatHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div
      className={cn("flex shrink-0 items-center gap-[12px] border-b px-[18px] py-[12px]", "border-border")}
      style={{ borderBottomWidth: "0.5px" }}
    >
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to home"
        className="text-muted-foreground/65 hover:text-foreground transition-colors duration-100 ease-out cursor-pointer"
      >
        <ArrowLeftIcon size={16} aria-hidden />
      </button>
      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{title}</span>
      <button
        type="button"
        aria-label="Thread options"
        className="text-muted-foreground/65 hover:text-foreground transition-colors duration-100 ease-out cursor-pointer"
      >
        <DotsIcon size={16} aria-hidden />
      </button>
    </div>
  );
}

// ── Two route exports — fresh start + mid-flow ─────────────────────────────

export const homeOnboardingConcept1Route = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/onboarding-concept-1",
  component: () => <HomeOnboardingConcept1PageImpl state={{ currentStep: 1, history: [] }} />,
});

export const homeOnboardingConcept1MidRoute = createRoute({
  getParentRoute: () => sketchRoute,
  path: "/home/onboarding-concept-1-mid",
  component: () => (
    <HomeOnboardingConcept1PageImpl
      state={{
        currentStep: 3,
        history: [
          { stepId: "channel", outcome: "connected" },
          { stepId: "integration", outcome: "connected" },
        ],
      }}
    />
  ),
});
