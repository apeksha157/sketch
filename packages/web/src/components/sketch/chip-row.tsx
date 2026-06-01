/**
 * Suggestion chip row — §4.5.
 *
 * Horizontal scroll with a right-edge fade that matches the page background.
 * The fade earns its keep because with 6–8 chips we can't fit them in a 400px
 * column without shrinking type — scrolling lets the column stay tight.
 *
 * Click pre-fills the chat input with the chip's prompt template and focuses
 * the input. Submit is one more keystroke.
 */
import {
  BulbIcon,
  CalendarTimeIcon,
  ChartBarIcon,
  FileIcon,
  type IconProps,
  MailIcon,
  MessageSquareIcon,
  PencilIcon,
  SparklesIcon,
} from "@/components/sketch/icons";
import { cn } from "@sketch/ui/lib/utils";
import { type ComponentType, useEffect, useRef, useState } from "react";

export interface ChipSuggestion {
  label: string;
  prompt: string;
  icon: ComponentType<IconProps>;
}

/**
 * Default chip set defined in §4.5. Each label maps to a prompt template that
 * pre-fills the chat input.
 */
export const DEFAULT_CHIPS: ChipSuggestion[] = [
  { label: "Triage inbox", prompt: "Triage my inbox from the last 24 hours", icon: MailIcon },
  { label: "Draft a reply", prompt: "Draft a reply to ", icon: PencilIcon },
  { label: "Schedule a task", prompt: "Schedule a recurring task to ", icon: CalendarTimeIcon },
  { label: "Summarize thread", prompt: "Summarize the latest thread in ", icon: MessageSquareIcon },
  { label: "Browse skills", prompt: "Show me the skills I can install", icon: SparklesIcon },
  { label: "Find a file", prompt: "Find a file about ", icon: FileIcon },
  { label: "Run a report", prompt: "Run a report on ", icon: ChartBarIcon },
  { label: "Show me what's possible", prompt: "Show me what's possible with Sketch", icon: BulbIcon },
];

export interface ChipRowProps {
  chips?: ChipSuggestion[];
  onPick: (chip: ChipSuggestion) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Tracks whether the scroll container has content peeking past the left or right
 * edge. Both edges get their own fade — and each is only rendered when there
 * is something to fade past, so the visible chip area always reads as full-width.
 */
function useEdgeFades(): {
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  showLeft: boolean;
  showRight: boolean;
} {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(false);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => {
      const maxScroll = el.scrollWidth - el.clientWidth;
      setShowLeft(el.scrollLeft > 1);
      setShowRight(el.scrollLeft < maxScroll - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  return { scrollerRef, showLeft, showRight };
}

export function ChipRow({ chips = DEFAULT_CHIPS, onPick, disabled, className }: ChipRowProps) {
  const { scrollerRef, showLeft, showRight } = useEdgeFades();

  return (
    <div className={cn("relative w-full", disabled && "pointer-events-none opacity-60", className)}>
      <div
        ref={scrollerRef}
        className="sketch-scrollbar-hide flex w-full overflow-x-auto"
        aria-label="Suggested prompts"
      >
        <div className="flex w-max gap-[8px]">
          {chips.map((chip) => {
            const Icon = chip.icon;
            return (
              <button
                key={chip.label}
                type="button"
                onClick={() => onPick(chip)}
                className={cn(
                  "group/chip inline-flex shrink-0 items-center gap-[7px] rounded-full px-[14px] py-[8px]",
                  "bg-card border border-border text-[13px] text-muted-foreground",
                  "transition-colors duration-150 ease-out cursor-pointer",
                  // Hover follows the same neutral-affordance language as the
                  // tile grid below: bg darkens, border picks up subtle
                  // structural emphasis, text lifts to foreground. Brand
                  // colour stays anchored at rest (tile icons, submit pip).
                  "hover:bg-muted/60 hover:border-foreground/20 hover:text-foreground",
                  "active:scale-[0.97]",
                )}
              >
                <Icon
                  size={14}
                  weight="regular"
                  className={cn(
                    "text-muted-foreground transition-all duration-150 ease-out",
                    "group-hover/chip:text-foreground group-hover/chip:scale-[1.08]",
                  )}
                  aria-hidden
                />
                <span className="whitespace-nowrap">{chip.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      {/* Edge fades — thin overlays right at the column edge. Rendered only when
       * there's overflow in that direction, so the chip row reads as wide as the
       * chat input above and tile grid below. */}
      {showLeft && (
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 h-full w-[20px]"
          style={{ background: "linear-gradient(to right, var(--background), transparent)" }}
        />
      )}
      {showRight && (
        <div
          aria-hidden
          className="pointer-events-none absolute right-0 top-0 h-full w-[20px]"
          style={{ background: "linear-gradient(to left, var(--background), transparent)" }}
        />
      )}
    </div>
  );
}
