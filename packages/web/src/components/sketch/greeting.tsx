/**
 * Greeting — §4.3. Centered, single line, 22px/500, letter-spacing -0.01em.
 *
 * Variety design (see MEMORY: "Personalization across the product"):
 *   - Time of day picks a bucket (morning / afternoon / evening / night).
 *   - Each bucket has a pool of 6–8 greeting templates.
 *   - Each template can substitute one of: first name, role title, a playful
 *     designation, or nothing — so the same user sees different framings across
 *     visits. Pick is stable for the lifetime of a mount.
 *   - Punctuation is baked into each template so commas, em-dashes, and
 *     question marks render correctly without string-stitching.
 *
 * Note: never use "Sketch" as a verb in copy (see MEMORY: terminology).
 */
import { cn } from "@sketch/ui/lib/utils";
import { useMemo } from "react";

type Role = "admin" | "member";

type Subject =
  | { kind: "name"; value: string }
  | { kind: "role"; value: string }
  | { kind: "designation"; value: string }
  | { kind: "none" };

interface GreetingContext {
  firstName: string;
  role?: Role;
}

/**
 * A greeting template renders to a complete string given a subject. The
 * template controls its own punctuation so commas/dashes stay correct
 * regardless of which subject (or none) is chosen.
 */
type Template = (subject: Subject) => string;

function withSubject(prefix: string, sep: ",", fallback: string, subject: Subject): string {
  if (subject.kind === "none") return `${fallback}.`;
  return `${prefix}${sep} ${subject.value}.`;
}

const MORNING: Template[] = [
  (s) => withSubject("Morning", ",", "Good morning", s),
  (s) => withSubject("Good morning", ",", "Good morning", s),
  (s) => (s.kind === "none" ? "Rise and shine." : `Rise and shine, ${s.value}.`),
  (s) => (s.kind === "none" ? "Up early today." : `Up early today, ${s.value}.`),
  (s) => (s.kind === "none" ? "Fresh start." : `Fresh start, ${s.value}.`),
  () => "Good morning!",
];

const AFTERNOON: Template[] = [
  (s) => withSubject("Good afternoon", ",", "Good afternoon", s),
  (s) => withSubject("Afternoon", ",", "Good afternoon", s),
  (s) => (s.kind === "none" ? "Hope your day's going well." : `Hope your day's going well, ${s.value}.`),
  (s) => (s.kind === "none" ? "How's it going?" : `How's it going, ${s.value}?`),
  (s) => withSubject("Hi", ",", "Hello there", s),
  () => "Hope you're having a solid one.",
];

const EVENING: Template[] = [
  (s) => withSubject("Evening", ",", "Good evening", s),
  (s) => withSubject("Good evening", ",", "Good evening", s),
  (s) => withSubject("Welcome back", ",", "Welcome back", s),
  (s) => (s.kind === "none" ? "Hope you had a good day." : `Hope you had a good day, ${s.value}.`),
  (s) => withSubject("Hi", ",", "Hello there", s),
  () => "Wrapping up the day?",
];

const NIGHT: Template[] = [
  (s) => (s.kind === "none" ? "Still up?" : `Still up, ${s.value}?`),
  (s) => (s.kind === "none" ? "Burning the midnight oil." : `Burning the midnight oil, ${s.value}.`),
  (s) => (s.kind === "none" ? "Late one." : `Late one, ${s.value}.`),
  (s) => withSubject("Hi", ",", "Hello there", s),
  () => "It's late — anything urgent?",
];

const ADMIN_DESIGNATIONS = ["captain", "chief", "boss", "skipper"];
const MEMBER_DESIGNATIONS = ["team", "friend"];

function bucketFor(hour: number): Template[] {
  if (hour >= 5 && hour < 11) return MORNING;
  if (hour >= 11 && hour < 17) return AFTERNOON;
  if (hour >= 17 && hour < 22) return EVENING;
  return NIGHT;
}

function pickSubject(ctx: GreetingContext): Subject {
  // Weighted: 55% name · 20% role title · 15% playful designation · 10% none.
  const roll = Math.random();
  if (roll < 0.55) return { kind: "name", value: ctx.firstName };
  if (roll < 0.75 && ctx.role) {
    return { kind: "role", value: ctx.role === "admin" ? "Admin" : "team" };
  }
  if (roll < 0.9) {
    const pool = ctx.role === "member" ? MEMBER_DESIGNATIONS : ADMIN_DESIGNATIONS;
    return { kind: "designation", value: pool[Math.floor(Math.random() * pool.length)] };
  }
  return { kind: "none" };
}

function pickTemplate(hour: number): Template {
  const bucket = bucketFor(hour);
  return bucket[Math.floor(Math.random() * bucket.length)];
}

export interface GreetingProps {
  firstName: string;
  role?: Role;
  /** Override for tests / Storybook. Defaults to `new Date()`. */
  now?: Date;
  className?: string;
}

/**
 * Subtitle pool — short, context-aware line that sits under the greeting.
 * Matches the existing /old/home/member shape ("Heads down on 1 task with 2 more
 * waiting"). Light personalization; will swap to real workspace data when the
 * detection signals land (see MEMORY: "Personalization across the product").
 */
const SUBTITLES = [
  "Sketch is ready when you are.",
  "Pick up where you left off.",
  "Anything else needs a nudge today?",
  "A few things ran while you were away.",
  "Try a chip below, or just type.",
];

function pickSubtitle(): string {
  return SUBTITLES[Math.floor(Math.random() * SUBTITLES.length)];
}

export function Greeting({ firstName, role, now, className }: GreetingProps) {
  const { headline, subtitle } = useMemo(() => {
    const hour = (now ?? new Date()).getHours();
    const template = pickTemplate(hour);
    const subject = pickSubject({ firstName, role });
    return { headline: template(subject), subtitle: pickSubtitle() };
  }, [firstName, role, now]);

  return (
    <div className={cn("flex flex-col", className)}>
      <h1
        className="text-[28px] font-semibold text-foreground leading-[1.15]"
        style={{ letterSpacing: "-0.02em" }}
      >
        {headline}
      </h1>
      <p className="mt-2 text-[15px] text-muted-foreground leading-[1.45]">{subtitle}</p>
    </div>
  );
}
