/**
 * Chat input — modeled after Claude's / ChatGPT's input shape rather than a
 * single-row search field:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ Ask Sketch anything…                        │  ← textarea, top-aligned
 *   │                                             │     auto-grows up to 5 rows
 *   │                                             │
 *   │  ╭─╮                                  ╭───╮ │  ← action row pinned bottom
 *   │  │＋│  · attach / context             │ ↑ │ │     submit lights up brand
 *   │  ╰─╯                                  ╰───╯ │     yellow when ready
 *   └─────────────────────────────────────────────┘
 *
 * Disabled state (paused routes) keeps the same chrome but greys the text
 * and inert-locks the controls.
 */
import { ArrowUpIcon } from "@/components/sketch/icons";
import { PaperclipIcon, PlusIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import {
  type ChangeEvent,
  type KeyboardEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export interface ChatInputProps {
  /** Pre-filled value (used by chip clicks to seed a prompt template). */
  initialValue?: string;
  placeholder?: string;
  disabled?: boolean;
  disabledPlaceholder?: string;
  onSubmit?: (value: string) => void;
}

const MIN_HEIGHT = 76; // px — roughly 3 lines of text
const MAX_HEIGHT = 220; // px — caps at ~9 lines, then internal scroll

/** Auto-resize a textarea to fit its content, capped between MIN/MAX. */
function autosize(el: HTMLTextAreaElement) {
  el.style.height = "0px";
  const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, el.scrollHeight));
  el.style.height = `${next}px`;
}

export const ChatInput = forwardRef<HTMLInputElement, ChatInputProps>(function ChatInput(
  {
    initialValue = "",
    placeholder = "Ask Sketch anything…",
    disabled = false,
    disabledPlaceholder = "Resolve account issue to continue",
    onSubmit,
  },
  ref,
) {
  const [value, setValue] = useState(initialValue);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Expose the textarea via the parent's HTMLInputElement-typed ref so the
  // existing chip-row focus call (inputRef.current?.focus()) still works.
  useImperativeHandle(ref, () => taRef.current as unknown as HTMLInputElement, []);

  useEffect(() => {
    if (taRef.current) autosize(taRef.current);
  }, []);

  function submitNow() {
    if (disabled) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit?.(trimmed);
    setValue("");
    requestAnimationFrame(() => taRef.current && autosize(taRef.current));
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setValue(event.target.value);
    autosize(event.target);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter submits, Shift+Enter newlines (Claude/ChatGPT convention).
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitNow();
    }
  }

  const empty = value.trim().length === 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitNow();
      }}
      className={cn(
        "group/input relative w-full rounded-[16px] border bg-card",
        "transition-all duration-150 ease-out",
        disabled
          ? "border-border opacity-90"
          : // Focus = neutral border emphasis + a soft neutral drop-shadow. The
            // brand colour stays on the submit pip, not on the field chrome.
            "border-border hover:border-foreground/25 focus-within:border-foreground/30 focus-within:shadow-[0_6px_24px_-10px_rgba(0,0,0,0.08)]",
      )}
    >
      <textarea
        ref={taRef}
        rows={3}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? disabledPlaceholder : placeholder}
        disabled={disabled}
        className={cn(
          "block w-full resize-none bg-transparent px-[18px] pt-[16px] pb-[6px]",
          "text-[15px] leading-[1.55] text-foreground placeholder:text-muted-foreground",
          "outline-none disabled:cursor-not-allowed",
        )}
        style={{ height: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
        aria-label="Message Sketch"
      />

      {/* Action row — pinned to the bottom of the card. Left holds future
       * affordances (attach, voice, model switcher); right holds submit. */}
      <div className="flex items-center justify-between px-[10px] pb-[10px] pt-[2px]">
        <div className="flex items-center gap-[2px] text-muted-foreground">
          <ActionButton aria-label="Attach a file" disabled={disabled}>
            <PaperclipIcon size={16} weight="regular" aria-hidden />
          </ActionButton>
          <ActionButton aria-label="Add context" disabled={disabled}>
            <PlusIcon size={16} weight="regular" aria-hidden />
          </ActionButton>
        </div>

        <SubmitButton disabled={disabled} empty={empty} onClick={submitNow} />
      </div>
    </form>
  );
});

function ActionButton({
  children,
  disabled,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "flex h-[30px] w-[30px] items-center justify-center rounded-[8px]",
        "text-muted-foreground transition-colors duration-150 ease-out cursor-pointer",
        "hover:text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      {children}
    </button>
  );
}

function SubmitButton({ disabled, empty, onClick }: { disabled: boolean; empty: boolean; onClick: () => void }) {
  const ready = !disabled && !empty;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || empty}
      aria-label="Send message"
      className={cn(
        "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full",
        "transition-all duration-200 ease-out cursor-pointer",
        // Active state — brand yellow with brown icon and a soft warm glow.
        // Idle state — muted, no glow, no shadow. The transition is the
        // affordance: it tells the user the form is "ready" the moment they
        // type anything.
        ready
          ? "bg-brand-yellow text-brand-brown shadow-[0_4px_14px_-2px_rgba(254,237,1,0.45)] hover:scale-[1.04] active:scale-[0.97]"
          : "bg-muted text-muted-foreground/70 cursor-not-allowed",
      )}
    >
      <ArrowUpIcon size={16} weight="bold" aria-hidden />
    </button>
  );
}
