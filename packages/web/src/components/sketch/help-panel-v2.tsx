import {
  CalendarBlankIcon,
  ChatCircleDotsIcon,
  CompassIcon,
  EnvelopeSimpleIcon,
  type Icon,
  PlayCircleIcon,
  SlackLogoIcon,
  SparkleIcon,
  WhatsappLogoIcon,
  XIcon,
} from "@phosphor-icons/react";
/**
 * HelpPanelV2 — the v2 help surface used by both the bubble helper and the
 * setup tray on the /home/onboarding-v2 route.
 *
 * Three tabs replace the v1 single column of action rows:
 *   1. Contact — multiple channels (Slack, WhatsApp, email, schedule), each
 *      annotated with a realistic response-time expectation so the user
 *      can pick the channel that matches their urgency.
 *   2. Videos — a small library of feature walkthroughs. Each row shows a
 *      thumbnail placeholder, title, duration, optional NEW badge. Tapping
 *      the intro fires onWatchVideo (reuses the existing overlay); the
 *      other rows are wired to the same handler in this prototype.
 *   3. What's new — chronological product updates with a small type tag
 *      (NEW / FEATURE / FIX) and a one-line excerpt.
 *
 * Default tab on open is Contact (when a user clicks Help, they usually
 * want a human first; Videos and News are secondary engagement).
 *
 * Tabs are text labels with a foreground underline on the active one —
 * codebase-aligned, no invented pill chrome. Panel width stays at 320px;
 * tab content is capped at max-height with internal scroll so the panel
 * can't push off-screen on the News tab.
 */
import { cn } from "@sketch/ui/lib/utils";
import { useState } from "react";

export type HelpTab = "contact" | "videos" | "news";

export interface HelpPanelV2Props {
  onClose: () => void;
  /** Wired to the existing video overlay. Reused for every Videos-tab row
   *  in the prototype; in production each row would target its own video. */
  onWatchVideo?: () => void;
  /** Wired to the existing coach-mark tour replay. */
  onReplayTour?: () => void;
  /** Initial tab on open. Defaults to "contact". */
  defaultTab?: HelpTab;
  /** When true, hides the X close button (used by the in-tray variant
   *  where the surrounding chrome already provides a way out). */
  hideClose?: boolean;
}

// ─── Contact channels ────────────────────────────────────────────────────
// Each channel has its own urgency profile, communicated inline in the
// subtitle ("Our shared channel · usually ~4 min") so the info reads as
// language instead of API-style metadata. Hrefs are placeholders — wired
// to the org's real URLs in production.

interface ContactMethod {
  id: string;
  icon: React.ComponentType<{ size?: number; weight?: "regular" | "fill" | "duotone" | "bold" }>;
  title: string;
  subtitle: string;
  href: string;
}

const CONTACT_METHODS: ContactMethod[] = [
  {
    id: "slack",
    icon: SlackLogoIcon,
    title: "Chat on Slack",
    subtitle: "Our shared channel · usually ~4 min",
    href: "https://canvasx.ai/slack",
  },
  {
    id: "whatsapp",
    icon: WhatsappLogoIcon,
    title: "Ping us on WhatsApp",
    subtitle: "Quick replies in work hours · 9–6 IST",
    href: "https://wa.me/919999999999",
  },
  {
    id: "email",
    icon: EnvelopeSimpleIcon,
    title: "Send an email",
    subtitle: "hello@canvasx.ai · within a day",
    href: "mailto:hello@canvasx.ai",
  },
  {
    id: "schedule",
    icon: CalendarBlankIcon,
    title: "Book a 30-min call",
    subtitle: "Pick a time at cal.com/canvasx",
    href: "https://cal.com/canvasx",
  },
];

// ─── Videos ──────────────────────────────────────────────────────────────
// Each video gets a gradient thumbnail placeholder — real posters drop in
// later. "isNew" tags the latest additions with a small brand-yellow chip
// (matches the next-step chip in the tray, so the NEW affordance reads
// from the same family as the rest of the surface).

interface VideoItem {
  id: string;
  title: string;
  subtitle: string;
  duration: string;
  /** Tailwind classes for the gradient swatch — keeps the thumbnail a real
   *  visual element while we don't yet have poster assets. */
  swatch: string;
  isNew?: boolean;
}

const VIDEOS: VideoItem[] = [
  {
    id: "intro",
    title: "Welcome to Sketch",
    subtitle: "From our founder",
    duration: "2:14",
    swatch: "from-[#FEED01] to-[#FFD56B]",
  },
  {
    id: "channels",
    title: "Setting up channels",
    subtitle: "Slack + WhatsApp",
    duration: "3:42",
    swatch: "from-[#C7E5FF] to-[#7AB8FF]",
  },
  {
    id: "skills",
    title: "Skills & tools",
    subtitle: "Connect your stack",
    duration: "4:18",
    swatch: "from-[#E7D9FF] to-[#B89CFF]",
    isNew: true,
  },
  {
    id: "schedule",
    title: "Scheduled runs",
    subtitle: "Cron + triggers",
    duration: "3:01",
    swatch: "from-[#FFD6B0] to-[#F39C42]",
  },
  {
    id: "team",
    title: "Inviting your team",
    subtitle: "Workspaces & roles",
    duration: "2:30",
    swatch: "from-[#CFEFCF] to-[#7AD27A]",
    isNew: true,
  },
];

// ─── News / What's new ───────────────────────────────────────────────────
// Type tag is a tiny chip in a tonal disc — matches the "NEW" affordance
// on videos so the panel reads as one family across tabs.

type NewsTag = "NEW" | "FEATURE" | "FIX";

interface NewsItem {
  id: string;
  date: string;
  title: string;
  excerpt: string;
  tag: NewsTag;
}

const NEWS_ITEMS: NewsItem[] = [
  {
    id: "1",
    date: "May 28",
    title: "WhatsApp adapter in beta",
    excerpt: "Connect your WhatsApp number and let Sketch reply in your style.",
    tag: "NEW",
  },
  {
    id: "2",
    date: "May 22",
    title: "Recurring schedules",
    excerpt: "Run any skill on a cron — daily standups, weekly reports.",
    tag: "FEATURE",
  },
  {
    id: "3",
    date: "May 15",
    title: "3 new integrations",
    excerpt: "Linear, Asana, and ClickUp join the existing 40+ tools.",
    tag: "FEATURE",
  },
  {
    id: "4",
    date: "May 8",
    title: "Faster Slack delivery",
    excerpt: "Reduced p95 latency by 60% across our messaging infrastructure.",
    tag: "FIX",
  },
];

// ─── Component ────────────────────────────────────────────────────────────

export function HelpPanelV2({
  onClose,
  onWatchVideo,
  onReplayTour,
  defaultTab = "contact",
  hideClose = false,
}: HelpPanelV2Props) {
  const [active, setActive] = useState<HelpTab>(defaultTab);

  return (
    <div
      className={cn(
        "pointer-events-auto w-[320px] rounded-[14px] border border-border bg-card overflow-hidden",
        "shadow-[0_16px_40px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.04)]",
        "sketch-bubble-panel-in",
        "flex flex-col",
      )}
    >
      {/* Heading row — chrome zone matching the bottom nav (same subtle
       *  bg tint + hairline divider) so the panel reads as three zones:
       *  chrome top → content middle → chrome bottom. Avoids the orphaned
       *  floating-eyebrow look. */}
      <div
        className={cn(
          "flex items-center justify-between gap-[12px] px-[14px] py-[10px]",
          "border-b border-border/60 bg-foreground/[0.02]",
        )}
      >
        <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.07em" }}>
          How can I help?
        </span>
        {!hideClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close help"
            className={cn(
              "-mr-[4px] inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px]",
              "text-muted-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground cursor-pointer",
              "transition-colors duration-150",
            )}
          >
            <XIcon size={13} />
          </button>
        )}
      </div>

      {/* Tab content — scroll container so tall tabs (Videos, News) don't
       *  push the panel off-screen. Cap chosen so the panel feels like a
       *  contained surface, not a sheet. */}
      <div className="max-h-[360px] overflow-y-auto">
        {active === "contact" && <ContactTab />}
        {active === "videos" && <VideosTab onPlay={onWatchVideo} onTour={onReplayTour} />}
        {active === "news" && <NewsTab />}
      </div>

      {/* Bottom navigation — Intercom-style icon + label tabs at the
       *  bottom of the panel. Frees the top edge for content, makes the
       *  panel feel like an app surface rather than a dropdown. Active
       *  tab gets a tinted bg + foreground colors; inactive is muted. */}
      <div
        role="tablist"
        aria-label="Help sections"
        className="grid grid-cols-3 border-t border-border/60 bg-foreground/[0.02]"
      >
        <BottomTab
          icon={ChatCircleDotsIcon}
          label="Contact"
          active={active === "contact"}
          onClick={() => setActive("contact")}
        />
        <BottomTab
          icon={PlayCircleIcon}
          label="Videos"
          active={active === "videos"}
          onClick={() => setActive("videos")}
        />
        <BottomTab icon={SparkleIcon} label="News" active={active === "news"} onClick={() => setActive("news")} />
      </div>
    </div>
  );
}

// ─── Bottom nav tab ──────────────────────────────────────────────────────

function BottomTab({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: Icon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "group flex flex-col items-center justify-center gap-[3px] py-[10px] cursor-pointer",
        "transition-colors duration-150",
        active
          ? "bg-foreground/[0.04] text-foreground"
          : "text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground/80",
      )}
    >
      <Icon size={18} weight={active ? "fill" : "regular"} />
      <span className="text-[11px] font-medium">{label}</span>
    </button>
  );
}

// ─── Contact tab ─────────────────────────────────────────────────────────

function ContactTab() {
  return (
    <div className="flex flex-col px-[8px] py-[8px]">
      {CONTACT_METHODS.map((m) => (
        <ContactRow key={m.id} method={m} />
      ))}
    </div>
  );
}

function ContactRow({ method }: { method: ContactMethod }) {
  const Icon = method.icon;
  return (
    <a
      href={method.href}
      target={method.href.startsWith("http") ? "_blank" : undefined}
      rel={method.href.startsWith("http") ? "noopener noreferrer" : undefined}
      className={cn(
        "group flex items-center gap-[12px] rounded-[8px] px-[10px] py-[9px]",
        "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/[0.05]",
      )}
    >
      <span
        className={cn(
          "inline-flex w-[16px] shrink-0 items-center justify-center",
          "text-foreground/55 transition-colors duration-150 group-hover:text-foreground",
        )}
      >
        <Icon size={16} weight="regular" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[14px] font-medium text-foreground/90 transition-colors duration-150 group-hover:text-foreground">
          {method.title}
        </span>
        <span className="mt-[2px] text-[12px] text-muted-foreground">{method.subtitle}</span>
      </span>
    </a>
  );
}

// ─── Videos tab ──────────────────────────────────────────────────────────

function VideosTab({ onPlay, onTour }: { onPlay?: () => void; onTour?: () => void }) {
  // Walkthrough sits at the top as a featured "TOUR" card — it's a
  // tutorial, so it belongs here, not as a persistent panel footer.
  // The TOUR tag distinguishes it from the regular video items below.
  return (
    <div className="flex flex-col px-[8px] py-[8px] gap-[10px]">
      {onTour && <TourCard onClick={onTour} />}
      <div className="flex flex-col">
        <SectionEyebrow>Watch</SectionEyebrow>
        {VIDEOS.map((v) => (
          <VideoRow key={v.id} video={v} onPlay={onPlay} />
        ))}
      </div>
    </div>
  );
}

function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-[10px] pt-[4px] pb-[8px]">
      <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.07em" }}>
        {children}
      </span>
    </div>
  );
}

function TourCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex items-center gap-[12px] rounded-[8px] px-[10px] py-[10px] text-left",
        "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/[0.05]",
      )}
    >
      {/* Brand-yellow circle with compass icon — distinct from the gradient
       *  video thumbnails so the tour reads as "guided walkthrough" not
       *  "watch a video". Same yellow circle pattern as the bubble itself,
       *  ties this card to the helper identity. */}
      <span
        aria-hidden
        className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full text-[#1a1a18]"
        style={{
          backgroundColor: "var(--brand-yellow)",
          boxShadow: "0 1px 4px color-mix(in oklab, var(--brand-yellow) 35%, transparent)",
        }}
      >
        <CompassIcon size={18} weight="regular" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-[6px]">
          <span className="text-[14px] font-medium text-foreground/90 transition-colors duration-150 group-hover:text-foreground">
            Take the walkthrough
          </span>
          <span
            className={cn(
              "inline-flex items-center rounded-[3px] px-[5px] py-[1px] font-mono text-[9px] font-semibold uppercase",
              "bg-[#FEED01] text-[#1a1a18]",
            )}
            style={{ letterSpacing: "0.08em" }}
          >
            Tour
          </span>
        </span>
        <span className="mt-[2px] text-[12px] text-muted-foreground">5 quick steps · 60 seconds</span>
      </span>
    </button>
  );
}

function VideoRow({ video, onPlay }: { video: VideoItem; onPlay?: () => void }) {
  return (
    <button
      type="button"
      onClick={onPlay}
      className={cn(
        "group flex items-center gap-[12px] rounded-[8px] px-[8px] py-[8px] text-left",
        "transition-colors duration-100 ease-out cursor-pointer hover:bg-foreground/[0.05]",
      )}
    >
      {/* Gradient thumbnail placeholder. Real poster frames slot in here
       *  later — the gradient gives each video its own visual identity in
       *  the meantime so the row isn't pure monochrome. */}
      <span
        aria-hidden
        className={cn(
          "relative inline-flex h-[34px] w-[52px] shrink-0 items-center justify-center rounded-[6px] bg-gradient-to-br",
          video.swatch,
        )}
      >
        <PlayCircleIcon size={16} weight="fill" className="text-[#1a1a18]/70" />
        {video.isNew && (
          <span
            className={cn(
              "absolute -top-[5px] -right-[5px] inline-flex items-center justify-center rounded-full px-[5px] py-[1px]",
              "font-mono text-[8px] font-semibold uppercase bg-[#FEED01] text-[#1a1a18]",
              "ring-[2px] ring-card",
            )}
            style={{ letterSpacing: "0.08em" }}
          >
            New
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[14px] font-medium text-foreground/90 transition-colors duration-150 group-hover:text-foreground">
          {video.title}
        </span>
        <span className="mt-[2px] text-[12px] text-muted-foreground">
          {video.subtitle} <span className="text-foreground/30">·</span> {video.duration}
        </span>
      </span>
    </button>
  );
}

// ─── News tab ────────────────────────────────────────────────────────────

function NewsTab() {
  return (
    <div className="flex flex-col px-[8px] py-[8px]">
      {NEWS_ITEMS.map((n) => (
        <NewsRow key={n.id} item={n} />
      ))}
    </div>
  );
}

function NewsRow({ item }: { item: NewsItem }) {
  return (
    <div
      className={cn(
        "group flex flex-col gap-[3px] rounded-[8px] px-[10px] py-[9px]",
        "transition-colors duration-100 ease-out hover:bg-foreground/[0.04]",
      )}
    >
      <div className="flex items-center gap-[8px]">
        <span className="font-mono text-[10px] uppercase text-muted-foreground/80" style={{ letterSpacing: "0.07em" }}>
          {item.date}
        </span>
        <NewsTagChip tag={item.tag} />
      </div>
      <span className="text-[14px] font-medium text-foreground/90">{item.title}</span>
      <span className="text-[12px] text-muted-foreground leading-snug">{item.excerpt}</span>
    </div>
  );
}

function NewsTagChip({ tag }: { tag: NewsTag }) {
  // NEW = brand-yellow (matches the next-step chip family).
  // FEATURE = neutral grey (informational).
  // FIX = darker neutral (housekeeping).
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[3px] px-[5px] py-[1px] font-mono text-[9px] font-semibold uppercase",
        tag === "NEW" && "bg-[#FEED01] text-[#1a1a18]",
        tag === "FEATURE" && "bg-foreground/[0.10] text-foreground/70",
        tag === "FIX" && "bg-foreground/[0.06] text-foreground/55",
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      {tag === "NEW" && <SparkleIcon size={9} weight="fill" className="mr-[2px]" />}
      {tag}
    </span>
  );
}
