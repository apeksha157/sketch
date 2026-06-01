/**
 * BuilderCanvas — the shared automation builder form.
 *
 * Used identically by both /scheduled-tasks/builder-inline (Variant A, full
 * page) and /scheduled-tasks/builder-sidecar (Variant B, split with chat
 * sidecar). The form contents and layout are the same in both — the only
 * thing that differs is what wraps it.
 *
 * Visual rhythm: hero (title + description) → three numbered steps
 * (01 WHEN / 02 DO / 03 HOW) → footer chrome. The numbered steps add a
 * narrative so the form reads as a flow, not a flat stack of cards.
 *
 * Mock fields only — no real submission, no validation. Designed to look like
 * a credible automation builder for a screenshot review.
 */
import { ArrowLeftIcon, HashIcon, SlackBrandIcon, SparklesIcon } from "@/components/sketch/icons";
import { FloppyDiskIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import type { ReactNode } from "react";

export interface BuilderCanvasProps {
  /** When true, renders the "back to chat" link in the page header. Hidden in
   * Variant B because the chat sidecar is right there. */
  showBackToChat?: boolean;
  onBack?: () => void;
  onSave?: () => void;
  /** Optional content rendered above the title block — used in Variant A v2 to
   * inject the conversation-context card without changing the canvas itself. */
  topAddon?: ReactNode;
  /** Optional content rendered between the scrollable body and the footer
   * chrome — used in Variant A v4 to inject the bottom-docked chat panel. */
  bottomSlot?: ReactNode;
  /** When true, drape a translucent placeholder layer over the form body to
   * signal that the builder UI is illustrative — the real focus is the
   * chat → builder transition, not the form itself. */
  placeholder?: boolean;
}

export function BuilderCanvas({
  showBackToChat,
  onBack,
  onSave,
  topAddon,
  bottomSlot,
  placeholder,
}: BuilderCanvasProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header showBackToChat={showBackToChat} onBack={onBack} onSave={onSave} dim={!!placeholder} />
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-[28px] px-10 py-8">
            {topAddon}
            <div
              className={cn("flex flex-col gap-[28px]", placeholder && "pointer-events-none select-none")}
              aria-hidden={placeholder || undefined}
            >
              <TitleBlock />
              <TriggerSection />
              <ActionSection />
              <SettingsSection />
            </div>
          </div>
        </div>
        {placeholder && <PlaceholderOverlay />}
      </div>
      {bottomSlot}
    </div>
  );
}

/**
 * The placeholder overlay — an edge-to-edge translucent pane that covers the
 * full body width (including the gutters around max-w-6xl).
 *
 * Two stacked layers so the blur stays consistent while the visual still feels
 * soft at the chrome edges:
 *   1. Blur layer — full coverage, no mask. Form shapes underneath stay
 *      uniformly muted from header to dock.
 *   2. Tint layer — feathered at top/bottom via mask-image so the wash doesn't
 *      meet the header/footer chrome with a hard line.
 *
 * The overlay is fixed to the body region (not the scroll surface), so it
 * stays put while the form scrolls underneath.
 */
function PlaceholderOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <div
        className="absolute inset-0"
        style={{
          backdropFilter: "blur(1.5px)",
          WebkitBackdropFilter: "blur(1.5px)",
        }}
        aria-hidden
      />
      <div
        className="absolute inset-0 bg-foreground/[0.02]"
        style={{
          maskImage: "linear-gradient(to bottom, transparent 0, black 36px, black calc(100% - 36px), transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent 0, black 36px, black calc(100% - 36px), transparent 100%)",
        }}
        aria-hidden
      />
      <div className="relative flex justify-center pt-[44px]">
        <PlaceholderBadge />
      </div>
    </div>
  );
}

function PlaceholderBadge() {
  return (
    <div
      className={cn(
        "inline-flex max-w-[560px] items-center gap-[12px] rounded-[10px] border bg-card px-[16px] py-[12px]",
        "border-foreground/15",
        "shadow-[0_10px_28px_-8px_rgba(0,0,0,0.18)]",
      )}
      style={{ borderWidth: "0.5px" }}
    >
      <span className="shrink-0 rounded-[4px] bg-brand-yellow/45 px-[7px] py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-brand-brown">
        Placeholder
      </span>
      <span className="text-[13px] text-foreground" style={{ lineHeight: 1.5 }}>
        Builder UI below is illustrative — the design proposal is the chat → builder transition itself, not the form.
      </span>
    </div>
  );
}

function Header({
  showBackToChat,
  onBack,
  onSave,
  dim,
}: {
  showBackToChat?: boolean;
  onBack?: () => void;
  onSave?: () => void;
  dim?: boolean;
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl shrink-0 items-center gap-[14px] px-10 py-[8px]">
      {showBackToChat && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to chat"
          className="shrink-0 text-muted-foreground/70 hover:text-foreground transition-colors duration-100 ease-out cursor-pointer"
        >
          <ArrowLeftIcon size={16} aria-hidden />
        </button>
      )}
      <h1 className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground/85">
        Surface design wins from Trustpilot
      </h1>
      <button
        type="button"
        onClick={onSave}
        className={cn(
          "shrink-0 inline-flex items-center gap-[6px] rounded-[8px] border bg-transparent px-[12px] py-[6px]",
          "text-[12.5px] font-medium",
          "border-foreground/20 text-foreground/85",
          "transition-colors duration-150 ease-out cursor-pointer",
          "hover:bg-foreground hover:text-background hover:border-foreground",
          dim && "opacity-55 pointer-events-none",
        )}
        aria-hidden={dim || undefined}
      >
        <FloppyDiskIcon size={13} weight="regular" aria-hidden />
        Save
      </button>
    </div>
  );
}

function TitleBlock() {
  return (
    <div className="flex flex-col gap-[8px]">
      <input
        defaultValue="Surface design wins from Trustpilot"
        className={cn(
          "bg-transparent text-[22px] font-medium text-foreground outline-none",
          "placeholder:text-muted-foreground",
        )}
        style={{ lineHeight: 1.25 }}
        aria-label="Automation name"
      />
      <input
        defaultValue="Every five-star Trustpilot review mentioning design lands in #design-wins."
        className={cn(
          "bg-transparent text-[14px] text-muted-foreground outline-none",
          "placeholder:text-muted-foreground/60",
        )}
        style={{ lineHeight: 1.55 }}
        aria-label="Description"
      />
    </div>
  );
}

function TriggerSection() {
  return (
    <Section step="01" eyebrow="When" label="Trigger">
      <FieldRow label="Event">
        <MockSelect icon={<SparklesIcon size={14} />} value="New Trustpilot review" />
      </FieldRow>
      <FieldRow label="Rating">
        <Chip selected>Five stars</Chip>
        <Chip>Four and up</Chip>
        <Chip>Any rating</Chip>
      </FieldRow>
      <FieldRow label="Keyword">
        <TextInput defaultValue="design" placeholder="optional" aria-label="Keyword filter" />
      </FieldRow>
    </Section>
  );
}

function ActionSection() {
  return (
    <Section step="02" eyebrow="Do" label="Action">
      <FieldRow label="What">
        <MockSelect icon={<SlackBrandIcon size={14} />} value="Post a Slack message" />
      </FieldRow>
      <FieldRow label="Channel">
        <MockSelect icon={<HashIcon size={14} />} value="design-wins" />
      </FieldRow>
      <FieldRow label="Message" align="start">
        <SlackPreview />
      </FieldRow>
    </Section>
  );
}

function SettingsSection() {
  return (
    <Section step="03" eyebrow="How" label="Settings">
      <FieldRow label="Run">
        <div className="flex flex-wrap items-center gap-[8px]">
          <Radio selected>Immediately when triggered</Radio>
          <Radio>Batch daily</Radio>
        </div>
      </FieldRow>
      <FieldRow label="Notify me">
        <div className="flex items-center gap-[12px]">
          <Toggle on />
          <span className="text-[13px] text-muted-foreground">DM me when this fires</span>
        </div>
      </FieldRow>
    </Section>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────────

function Section({
  step,
  eyebrow,
  label,
  children,
}: {
  step: string;
  eyebrow: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-[14px]">
      <SectionHeading step={step} eyebrow={eyebrow} label={label} />
      <div className="rounded-[14px] border border-border bg-card p-[22px]" style={{ borderWidth: "0.5px" }}>
        <div className="flex flex-col gap-[14px]">{children}</div>
      </div>
    </section>
  );
}

function SectionHeading({ step, eyebrow, label }: { step: string; eyebrow: string; label: string }) {
  return (
    <div className="flex items-center gap-[12px]">
      <span
        className="font-mono text-[12px] font-medium tabular-nums text-muted-foreground/80"
        style={{ letterSpacing: "0.05em" }}
      >
        {step}
      </span>
      <span className="block h-px w-[18px] bg-border" aria-hidden />
      <span className="font-mono text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: "0.08em" }}>
        {eyebrow}
      </span>
      <span className="text-[16px] font-medium text-foreground leading-tight">{label}</span>
    </div>
  );
}

function FieldRow({
  label,
  children,
  align = "center",
}: {
  label: string;
  children: ReactNode;
  align?: "start" | "center";
}) {
  return (
    <div className={cn("flex gap-[16px]", align === "start" ? "items-start" : "items-center")}>
      <span
        className={cn("w-[120px] shrink-0 text-[12px] text-muted-foreground", align === "start" ? "pt-[10px]" : "")}
      >
        {label}
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-[8px]">{children}</div>
    </div>
  );
}

function MockSelect({ icon, value }: { icon: ReactNode; value: string }) {
  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-[10px] rounded-[10px] border border-border bg-background px-[14px] py-[9px]",
        "text-[13px] text-foreground hover:border-foreground/30 transition-colors duration-100 ease-out cursor-pointer",
      )}
      style={{ borderWidth: "0.5px" }}
    >
      <span className="text-muted-foreground" aria-hidden>
        {icon}
      </span>
      <span className="flex-1 text-left">{value}</span>
      <span className="text-muted-foreground/60 text-[11px]" aria-hidden>
        ▾
      </span>
    </button>
  );
}

function TextInput({
  defaultValue,
  placeholder,
  ...rest
}: {
  defaultValue?: string;
  placeholder?: string;
  "aria-label": string;
}) {
  return (
    <input
      defaultValue={defaultValue}
      placeholder={placeholder}
      {...rest}
      className={cn(
        "w-full rounded-[10px] border border-border bg-background px-[14px] py-[9px]",
        "text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none",
        "focus:border-foreground/30 transition-colors duration-100 ease-out",
      )}
      style={{ borderWidth: "0.5px" }}
    />
  );
}

function Chip({ children, selected }: { children: ReactNode; selected?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-[8px] border px-[12px] py-[6px] text-[12px] transition-colors duration-100 ease-out cursor-pointer",
        selected
          ? "border-[#dcdcd7] bg-[#ededeb] dark:border-white/15 dark:bg-white/10 text-foreground font-medium"
          : "border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/25",
      )}
      style={{ borderWidth: "0.5px" }}
    >
      {children}
    </button>
  );
}

function Radio({ children, selected }: { children: ReactNode; selected?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-[8px] rounded-[10px] border px-[12px] py-[7px] text-[12.5px] transition-colors duration-100 ease-out cursor-pointer",
        selected
          ? "border-[#dcdcd7] bg-[#ededeb] dark:border-white/15 dark:bg-white/10 text-foreground font-medium"
          : "border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/25",
      )}
      style={{ borderWidth: "0.5px" }}
    >
      <span
        className={cn(
          "flex h-[12px] w-[12px] items-center justify-center rounded-full border",
          selected ? "border-foreground" : "border-muted-foreground/50",
        )}
      >
        {selected && <span className="h-[5px] w-[5px] rounded-full bg-foreground" />}
      </span>
      {children}
    </button>
  );
}

function Toggle({ on }: { on?: boolean }) {
  return (
    <span
      className={cn(
        "flex h-[20px] w-[34px] items-center rounded-full transition-colors duration-150 ease-out",
        on ? "bg-foreground" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "h-[16px] w-[16px] rounded-full bg-background transition-transform duration-150 ease-out",
          on ? "translate-x-[16px]" : "translate-x-[2px]",
        )}
      />
    </span>
  );
}

function Token({ children }: { children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-[4px] bg-brand-yellow/35 px-[5px] py-[1px]",
        "font-mono text-[12px] text-brand-brown",
      )}
    >
      {children}
    </span>
  );
}

function SlackPreview() {
  return (
    <div
      className="w-full overflow-hidden rounded-[12px] border border-border bg-background"
      style={{ borderWidth: "0.5px" }}
    >
      {/* Channel header */}
      <div
        className="flex items-center gap-[8px] border-b border-border px-[14px] py-[10px]"
        style={{ borderBottomWidth: "0.5px" }}
      >
        <HashIcon size={12} className="text-muted-foreground" aria-hidden />
        <span className="font-mono text-[11px] text-muted-foreground">design-wins</span>
      </div>

      {/* Mock message */}
      <div className="flex gap-[10px] px-[14px] py-[12px]">
        <span
          className="mt-[1px] flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[6px] bg-brand-yellow"
          aria-hidden
        >
          <img src="/logos/sketch-icon-lightmode.png" alt="" aria-hidden className="h-[15px] w-[15px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
          <div className="flex items-baseline gap-[6px]">
            <span className="text-[13px] font-semibold text-foreground">Sketch</span>
            <span className="text-[11px] text-muted-foreground">12:42 PM</span>
          </div>
          <div className="flex flex-col gap-[6px] text-[13px] text-foreground" style={{ lineHeight: 1.55 }}>
            <p>
              <Token>★★★★★</Token> from <Token>{"{{review.reviewer_name}}"}</Token>
            </p>
            <p className="text-muted-foreground">
              <Token>{"{{review.text}}"}</Token>
            </p>
            <p className="text-[12px]">
              <Token>{"{{review.url}}"}</Token>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
