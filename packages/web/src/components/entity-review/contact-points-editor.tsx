/**
 * Multi-value contact-point editor shared by the review drawers. A person carries
 * one required name (owned by the drawer header) plus repeatable phones and
 * emails.
 *
 * Fields auto-grow: there is always exactly one trailing empty input, and filling
 * it spawns the next one — the Apple Contacts pattern, so there is no "add"
 * button to design and no empty-field edge case to guard. A filled value can be
 * removed with its inline "×".
 *
 * `findMatch` powers duplicate detection (the "same contact point on two entities
 * → suggest a merge" concept). When an entered phone/email already belongs to
 * another entity, the row offers to merge into it instead of creating a second
 * record. In the prototype this is a mock lookup; the backend replaces it with a
 * contact-point search (e.g. `GET /api/entities/contact-points?value=…`).
 *
 * When a drawer already has a guessed identity, it passes `nameConfirm`; the Name
 * field then carries a green confirm tick (positive-inline-validation pattern) so
 * accepting the guess happens at the name itself, not by repurposing the footer's
 * primary button.
 */
import { CheckIcon, XIcon } from "@phosphor-icons/react";
import { Input } from "@sketch/ui/components/input";
import { cn } from "@sketch/ui/lib/utils";
import { useEffect } from "react";
import { SectionLabel } from "../entity-drawer/drawer-kit";

export type ContactKind = "phone" | "email";

export interface ContactMatch {
  entityId: string;
  name: string;
}

/** A single editable value, keyed so add/remove keeps stable React keys. */
export interface ContactRow {
  id: string;
  value: string;
}

let contactRowSeq = 0;
/** Wrap raw values as keyed rows for the editor's local list state. */
export function contactRows(values: string[]): ContactRow[] {
  return values.map((value) => ({ id: `cp-${contactRowSeq++}`, value }));
}

/** Trimmed, non-empty values — what a save actually persists. */
export function contactValues(rows: ContactRow[]): string[] {
  return rows.map((row) => row.value.trim()).filter((value) => value.length > 0);
}

const FIELD = {
  phone: { label: "Phone", placeholder: "+91 98765 43210", inputMode: "tel" as const },
  email: { label: "Email", placeholder: "name@company.com", inputMode: "email" as const },
};

function ContactList({
  kind,
  optional,
  rows,
  onChange,
  findMatch,
  onMergeSuggested,
}: {
  kind: ContactKind;
  optional?: boolean;
  rows: ContactRow[];
  onChange: (next: ContactRow[]) => void;
  findMatch?: (kind: ContactKind, value: string) => ContactMatch | null;
  onMergeSuggested?: (match: ContactMatch) => void;
}) {
  const field = FIELD[kind];
  const setValue = (id: string, value: string) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, value } : row)));
  const remove = (id: string) => onChange(rows.filter((row) => row.id !== id));

  /**
   * Keep exactly one trailing empty field. When every row holds a value (or the
   * list is empty), append a fresh blank; typing into that blank then grows the
   * next one. This is what replaces an explicit "add" button.
   */
  useEffect(() => {
    if (rows.every((row) => row.value.trim().length > 0)) {
      onChange([...rows, ...contactRows([""])]);
    }
  }, [rows, onChange]);

  return (
    <div className="flex flex-col gap-1.5">
      <SectionLabel className="font-medium">
        {field.label}
        {optional ? <span className="tracking-normal opacity-70"> (optional)</span> : null}
      </SectionLabel>
      <div className="flex flex-col gap-1.5">
        {rows.map((row, index) => {
          const trimmed = row.value.trim();
          const match = trimmed ? (findMatch?.(kind, trimmed) ?? null) : null;
          const canRemove = trimmed.length > 0;
          return (
            <div key={row.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <Input
                  value={row.value}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(row.id, e.target.value)}
                  placeholder={field.placeholder}
                  inputMode={field.inputMode}
                  aria-label={`${field.label} ${index + 1}`}
                  className="font-mono text-xs"
                />
                {canRemove ? (
                  <button
                    type="button"
                    onClick={() => remove(row.id)}
                    aria-label={`Remove ${field.label.toLowerCase()}`}
                    className="shrink-0 rounded p-1 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <XIcon size={12} />
                  </button>
                ) : null}
              </div>
              {match ? (
                <p className="flex flex-wrap items-center gap-x-1 pl-0.5 text-[10.5px] text-amber-600 dark:text-amber-400">
                  <span>
                    Already on <span className="font-medium">{match.name}</span>.
                  </span>
                  <button
                    type="button"
                    onClick={() => onMergeSuggested?.(match)}
                    className="font-medium underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300"
                  >
                    Merge them?
                  </button>
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ContactPointsEditor({
  name,
  onNameChange,
  namePlaceholder,
  nameConfirm,
  phones,
  emails,
  onPhonesChange,
  onEmailsChange,
  findMatch,
  onMergeSuggested,
}: {
  /** When `onNameChange` is provided, a required single-value Name field leads the form. */
  name?: string;
  onNameChange?: (value: string) => void;
  namePlaceholder?: string;
  /** When set, the Name field shows a green confirm tick that accepts a guessed identity. */
  nameConfirm?: { onConfirm: () => void; label: string } | null;
  phones: ContactRow[];
  emails: ContactRow[];
  onPhonesChange: (next: ContactRow[]) => void;
  onEmailsChange: (next: ContactRow[]) => void;
  findMatch?: (kind: ContactKind, value: string) => ContactMatch | null;
  onMergeSuggested?: (match: ContactMatch) => void;
}) {
  return (
    <div className="flex flex-col gap-3.5">
      {onNameChange ? (
        <div className="flex flex-col gap-1.5">
          <SectionLabel className="font-medium">Name</SectionLabel>
          <div className="relative">
            <Input
              value={name ?? ""}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onNameChange(e.target.value)}
              placeholder={namePlaceholder ?? "Full name"}
              aria-label="Name"
              className={cn("text-sm", nameConfirm ? "pr-11" : undefined)}
              data-testid="contact-name-input"
            />
            {nameConfirm ? (
              <button
                type="button"
                onClick={nameConfirm.onConfirm}
                aria-label={nameConfirm.label}
                title={nameConfirm.label}
                className="absolute inset-y-0 right-1.5 my-auto flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-white transition-colors hover:bg-emerald-700"
                data-testid="contact-name-confirm"
              >
                <CheckIcon size={13} weight="bold" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <ContactList
        kind="phone"
        rows={phones}
        onChange={onPhonesChange}
        findMatch={findMatch}
        onMergeSuggested={onMergeSuggested}
      />
      <ContactList
        kind="email"
        optional
        rows={emails}
        onChange={onEmailsChange}
        findMatch={findMatch}
        onMergeSuggested={onMergeSuggested}
      />
    </div>
  );
}
