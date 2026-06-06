/**
 * Neutral presentation atoms shared across the three redesign directions.
 * Deliberately small — anything that encodes a *layout opinion* lives in the
 * direction files themselves, so the three explorations stay genuinely
 * divergent rather than three skins of one component.
 */
import {
  BellSimpleIcon,
  CheckCircleIcon,
  LightningIcon,
  SlackLogoIcon,
  WhatsappLogoIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import type { MockTask } from "./mock";

/** Emoji stand-ins for app logos — fine for mid-fi; swap for real marks later. */
const APP_GLYPH: Record<string, string> = {
  clickup: "🟣",
  trustpilot: "⭐",
  slack: "💬",
  gmail: "✉️",
  sheets: "📊",
  ai: "✦",
  code: "{}",
  intercom: "💬",
  linear: "▲",
  calendly: "📅",
  notion: "📝",
  stripe: "💳",
};

export function AppChip({ app }: { app: string }) {
  return (
    <span
      className="inline-flex size-5 items-center justify-center rounded-[5px] border border-border bg-background text-[10px] leading-none"
      title={app}
    >
      {APP_GLYPH[app] ?? app.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The app/step chain that signals "this is a workflow, not a reminder". */
export function AppChain({ apps }: { apps: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {apps.map((app, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static decorative chain, order is stable
        <span key={`${app}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-[10px] text-muted-foreground">→</span> : null}
          <AppChip app={app} />
        </span>
      ))}
    </span>
  );
}

/** Last-N run outcomes as dots — a glanceable health signal for workflows. */
export function RunHealth({ health }: { health: MockTask["runHealth"] }) {
  if (!health || health.length === 0) {
    return <span className="text-[11px] text-muted-foreground">No runs yet</span>;
  }
  return (
    <span className="inline-flex items-center gap-1" title="Last 5 runs">
      {health.map((h, i) => {
        const tone = h === "ok" ? "bg-emerald-500" : h === "fail" ? "bg-destructive" : "bg-blue-500";
        // biome-ignore lint/suspicious/noArrayIndexKey: static decorative dots, order is stable
        return <span key={i} className={cn("size-1.5 rounded-full", tone)} />;
      })}
    </span>
  );
}

export function KindIcon({ task, className }: { task: MockTask; className?: string }) {
  if (task.kind === "workflow") {
    return <LightningIcon weight="fill" className={cn("text-amber-500", className)} />;
  }
  if (task.platform === "slack") return <SlackLogoIcon className={cn("text-muted-foreground", className)} />;
  if (task.platform === "whatsapp") return <WhatsappLogoIcon className={cn("text-muted-foreground", className)} />;
  return <BellSimpleIcon className={cn("text-muted-foreground", className)} />;
}

export function StatusBadge({ task }: { task: MockTask }) {
  const base = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium";
  if (task.status === "active") {
    return <span className={cn(base, "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}>Active</span>;
  }
  if (task.status === "paused") {
    return <span className={cn(base, "bg-muted text-muted-foreground")}>Paused</span>;
  }
  return <span className={cn(base, "border border-border text-muted-foreground")}>Completed</span>;
}

export function LastRunPill({ task }: { task: MockTask }) {
  if (!task.lastRunAt) return null;
  const failed = task.lastRunStatus === "failed";
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      {failed ? (
        <XCircleIcon className="size-3 text-destructive" weight="fill" />
      ) : (
        <CheckCircleIcon className="size-3 text-emerald-500" weight="fill" />
      )}
      {failed ? "Last run failed" : "Last run ok"} · {relativeTime(task.lastRunAt)}
    </span>
  );
}

export function relativeTime(value: string | null): string {
  if (!value) return "never";
  const diff = Date.now() - new Date(value).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Human step summary, e.g. "Trigger → Prepare updates → Update subtasks". */
export function stepSummary(task: MockTask): string | null {
  if (!task.steps) return null;
  try {
    const list = JSON.parse(task.steps) as Array<{ type: string; label: string }>;
    return list
      .filter((s) => s.type !== "trigger")
      .map((s) => s.label)
      .join(" → ");
  } catch {
    return null;
  }
}
