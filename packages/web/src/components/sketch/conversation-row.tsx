/**
 * Conversation row + relative-time formatter.
 *
 * Channel handling:
 *   - Web (in-product) → BrowserIcon. A tiny browser window glyph reads as
 *     "this conversation happened on the dashboard", which is the signal we
 *     need. The Sketch logo previously used here didn't communicate channel —
 *     it just sat as decoration.
 *   - Slack and WhatsApp keep their real brand glyphs because the channel
 *     difference is the whole point.
 *
 * Time formatting (revised — was inconsistent: 18m / 3h / 11:54pm / Tue):
 *   < 1m  → "now"
 *   < 1h  → "Nm"
 *   < 1d  → "Nh"
 *   < 7d  → "Nd"
 *   < 4w  → "Nw"
 *   older → "Mon D" (same year) / "Mon YYYY" (older)
 * One scale, monotonic, no special-cased yesterday-with-time.
 */
import { BrowserIcon, SlackBrandIcon, WhatsappBrandIcon } from "@/components/sketch/icons";
import { SuccessDot } from "@/components/sketch/status-indicators";
import { cn } from "@sketch/ui/lib/utils";
import { Link } from "@tanstack/react-router";

export type ConversationChannel = "web" | "slack" | "whatsapp";

export interface ConversationRowProps {
  id: string;
  title: string;
  channel: ConversationChannel;
  /** ISO timestamp of the latest activity. */
  occurredAt: string;
  /** Optional success indicator — a green dot before the timestamp. */
  ranSuccessfully?: boolean;
  /** Override for testing the relative time output. */
  now?: Date;
}

const CHANNEL_ICON = {
  web: BrowserIcon,
  slack: SlackBrandIcon,
  whatsapp: WhatsappBrandIcon,
} as const;

const CHANNEL_LABEL = {
  web: "Dashboard",
  slack: "Slack",
  whatsapp: "WhatsApp",
} as const;

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function formatRelative(occurredAt: string, now: Date = new Date()): string {
  const then = new Date(occurredAt);
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 0) return "now"; // future timestamps clamp to "now"
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 28) return `${Math.floor(diffDays / 7)}w`;
  const sameYear = then.getFullYear() === now.getFullYear();
  return sameYear
    ? `${MONTH_NAMES[then.getMonth()]} ${then.getDate()}`
    : `${MONTH_NAMES[then.getMonth()]} ${then.getFullYear()}`;
}

export function ConversationRow({ id, title, channel, occurredAt, ranSuccessfully, now }: ConversationRowProps) {
  const ChannelIcon = CHANNEL_ICON[channel];
  return (
    <Link
      to="/chat/$conversationId"
      params={{ conversationId: id }}
      className={cn(
        "group flex w-full items-center gap-[12px] rounded-[6px] px-[8px] py-[8px]",
        "transition-colors duration-100 ease-out hover:bg-accent",
      )}
    >
      {/* Fixed 18×18 leading slot so titles align across channels. */}
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-muted-foreground">
        <ChannelIcon size={16} weight="regular" aria-label={CHANNEL_LABEL[channel]} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{title}</span>
      {ranSuccessfully && <SuccessDot />}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatRelative(occurredAt, now)}</span>
    </Link>
  );
}
