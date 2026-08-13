/**
 * WhatsApp identity review — folds unidentified WhatsApp contacts into the
 * existing "Needs your review" queue.
 *
 * When a WhatsApp group is indexed, every unknown participant is auto-minted as
 * a person entity named by its raw phone/LID (`projectWhatsAppRosterPerson` on
 * the server). Those people already exist in the graph — they just have no human
 * name yet. This surface lets an admin put a name to them, leading with the
 * GROUPS the contact appears in (the recognizable signal) rather than the LID or
 * masked number, which no human can map on sight.
 *
 * ⚠️ FRONTEND PROTOTYPE — no backend yet. The types below are the contract a
 * backend developer implements; {@link WHATSAPP_IDENTITY_MOCK} stands in for the
 * list endpoint, and the resolve actions are stubbed to local state + a toast.
 * When the backend lands:
 *   - Replace {@link useWhatsAppIdentityReview} with a real query, e.g.
 *     `GET /api/whatsapp/identities?state=unidentified` returning
 *     `WhatsAppIdentityReviewItem[]`.
 *   - inline confirm ("This is them" / "Use this name", shown beside the name
 *     only while the guess is untouched) → accept our suggestion as-is: merges
 *     into the suggested entity when the suggestion carries one, else PATCHes the
 *     guessed name (an unedited Save).
 *   - "Save"         → PATCH the placeholder entity's (edited) name + POST
 *     contact-points (`POST /api/entities/:entityId/contact-points`, kinds
 *     email/phone). Active only once a field changes.
 *   - "Merge"        → `POST /api/entities/merges { survivorId, loserId }` with
 *     the placeholder entity as the loser.
 *   - "Dismiss"      → mark the identity reviewed so it stops surfacing.
 *   - The drawer's "Seen in" + suggestion need a new query over
 *     `whatsapp_group_participants` + `conversation_messages` (no endpoint today).
 */
import { EntityPicker } from "@/components/entity-picker";
import { EntityAvatar } from "@/lib/entity-ui";
import { formatRelativeTime } from "@/routes/files/file-list";
import {
  ArrowsLeftRightIcon,
  CheckIcon,
  PhoneIcon,
  UserFocusIcon,
  WhatsappLogoIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { cn } from "@sketch/ui/lib/utils";
import { useState } from "react";
import { toast } from "sonner";
import { EntryList, SectionLabel } from "../entity-drawer/drawer-kit";
import {
  type ContactKind,
  type ContactMatch,
  ContactPointsEditor,
  type ContactRow,
  contactRows,
  contactValues,
} from "./contact-points-editor";

/** One WhatsApp group the contact has been seen in, with recent excerpts to help place them. */
export interface WhatsAppGroupSighting {
  groupJid: string;
  groupName: string;
  messageCount: number;
  lastMessageAt: string;
  /** A few recent message excerpts (most recent first) shown to aid identification. Backend caps the count. */
  snippets: string[];
}

/** Our best guess at who this identity belongs to — an existing entity (merge target) or just a name. */
export interface WhatsAppIdentitySuggestion {
  /** Existing entity we think this is (the merge target), when we have one; null = name only. */
  entityId: string | null;
  name: string;
  confidence: "likely" | "possibly";
  reason: string;
}

/** An unidentified WhatsApp person entity awaiting a name. The placeholder entity already exists. */
export interface WhatsAppIdentityReviewItem {
  id: string;
  /** The placeholder person entity that already exists (currently named by its phone/LID). */
  entityId: string;
  /** E.164 number when captured; UI may prettify. Null when only a LID is known. */
  phoneE164: string | null;
  lid: string | null;
  groups: WhatsAppGroupSighting[];
  suggestion: WhatsAppIdentitySuggestion | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export const WHATSAPP_IDENTITY_MOCK: WhatsAppIdentityReviewItem[] = [
  {
    id: "wa-1",
    entityId: "wa-entity-1",
    phoneE164: "+91 98765 43210",
    lid: "4790…6283@lid",
    firstSeenAt: "2026-07-20T09:00:00Z",
    lastSeenAt: "2026-08-11T14:00:00Z",
    suggestion: {
      entityId: "person-rohan",
      name: "Rohan Mehta",
      confidence: "likely",
      reason:
        "Appears in Pfizer RFP alongside 4 of his known contacts, and this number matches the one in his email signature.",
    },
    groups: [
      {
        groupJid: "g1",
        groupName: "Pfizer RFP",
        messageCount: 42,
        lastMessageAt: "2026-08-11T14:00:00Z",
        snippets: [
          "I'll send the revised pricing by EOD — looping in Sanaa for the Thursday call.",
          "Can we push the review to 3pm? It clashes with the Pfizer standup.",
          "Final deck is uploaded — the numbers we agreed on are on slide 12.",
        ],
      },
      {
        groupJid: "g2",
        groupName: "Deal Room – APAC",
        messageCount: 12,
        lastMessageAt: "2026-08-08T10:00:00Z",
        snippets: [
          "Confirmed, our team can support the Q3 rollout in Mumbai.",
          "Legal cleared the MSA this morning — good to countersign.",
        ],
      },
      {
        groupJid: "g3",
        groupName: "Founders ⚡",
        messageCount: 3,
        lastMessageAt: "2026-07-24T18:00:00Z",
        snippets: ["Great meeting you all at the summit 🙏", "Let's grab coffee next week — I'm in town till Friday."],
      },
    ],
  },
  {
    id: "wa-2",
    entityId: "wa-entity-2",
    phoneE164: "+44 7700 900412",
    lid: "6621…4409@lid",
    firstSeenAt: "2026-08-12T09:00:00Z",
    lastSeenAt: "2026-08-12T13:00:00Z",
    suggestion: null,
    groups: [
      {
        groupJid: "g4",
        groupName: "Oliver Wyman × Canvas",
        messageCount: 8,
        lastMessageAt: "2026-08-12T13:00:00Z",
        snippets: [
          "Sharing the deck now — let me know if the numbers on slide 6 look right.",
          "Thanks for the intro — we'll circle back with our POV by Monday.",
        ],
      },
    ],
  },
  {
    id: "wa-3",
    entityId: "wa-entity-3",
    phoneE164: null,
    lid: "8134…7751@lid",
    firstSeenAt: "2026-08-13T04:00:00Z",
    lastSeenAt: "2026-08-13T08:00:00Z",
    suggestion: {
      entityId: null,
      name: "Aisha Khan",
      confidence: "possibly",
      reason: "Shares a display name with an Aisha Khan in the Redseer group, but we haven't seen a phone number yet.",
    },
    groups: [
      {
        groupJid: "g5",
        groupName: "Redseer diligence",
        messageCount: 19,
        lastMessageAt: "2026-08-13T08:00:00Z",
        snippets: [
          "The cohort data is in the shared folder — pulling churn next.",
          "Retention looks stronger than the last cut — I'll annotate the deltas.",
        ],
      },
      {
        groupJid: "g6",
        groupName: "Sketch WhatsApp test",
        messageCount: 33,
        lastMessageAt: "2026-08-13T06:00:00Z",
        snippets: ["Testing — does the bot pick this up?", "Second test, adding a reaction now."],
      },
    ],
  },
];

/**
 * Prototype stand-in for backend duplicate detection: a contact-point lookup
 * keyed by value. When an admin enters a phone/email that already belongs to
 * another entity, the drawer offers to merge into it instead of minting a second
 * record — the "two entities that share a contact point are the same person"
 * concept. The backend replaces this with a real search over existing contact
 * points. Seeded so `wa-2`'s pre-filled number already resolves to a person.
 */
const KNOWN_CONTACT_POINTS: Array<{ kind: ContactKind; value: string; entityId: string; name: string }> = [
  { kind: "phone", value: "+44 7700 900412", entityId: "person-nadia", name: "Nadia Rahman" },
  { kind: "email", value: "nadia.rahman@owl.com", entityId: "person-nadia", name: "Nadia Rahman" },
];

const normalizeContactPoint = (value: string) => value.replace(/\s+/g, "").toLowerCase();

function findContactMatch(kind: ContactKind, value: string): ContactMatch | null {
  const needle = normalizeContactPoint(value);
  const hit = KNOWN_CONTACT_POINTS.find((cp) => cp.kind === kind && normalizeContactPoint(cp.value) === needle);
  return hit ? { entityId: hit.entityId, name: hit.name } : null;
}

/**
 * Prototype data source. Only surfaces on person-scoped queues (WhatsApp
 * identities are people). Returns the local mock plus a `resolve` that
 * optimistically drops a row and toasts — the stand-in for the real mutations.
 */
/**
 * Experimental gate for the WhatsApp-identity review surface. Off by default,
 * so the feature is completely invisible — no rows in the "Needs your review"
 * band, no rows in the Review tab, no drawer. Flip to `true` for design review.
 *
 * Note: CLAUDE.md describes a server-side `EXPERIMENTAL_FLAG` surfaced to the
 * web as `setupStatus.experimentalFlag`, but neither exists in the current
 * codebase — there is no frontend feature-flag plumbing, and the sibling review
 * queue is gated purely by whether the server returns rows. This feature is
 * frontend-only mock data, so it carries its own local switch. When the backend
 * lands, delete this constant and let real server-driven visibility gate it, the
 * way {@link GhostReviewRow} already does.
 */
export const WHATSAPP_IDENTITY_REVIEW_ENABLED = false;

export function useWhatsAppIdentityReview(types: string[]): {
  items: WhatsAppIdentityReviewItem[];
  resolve: (id: string, message: string) => void;
} {
  const enabled = WHATSAPP_IDENTITY_REVIEW_ENABLED && (types.length === 0 || types.includes("person"));
  const [items, setItems] = useState<WhatsAppIdentityReviewItem[]>(() => (enabled ? WHATSAPP_IDENTITY_MOCK : []));
  const resolve = (id: string, message: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
    toast.success(message);
  };
  return { items, resolve };
}

function IdentityAvatar({ item, size }: { item: WhatsAppIdentityReviewItem; size: "sm" | "lg" }) {
  if (item.suggestion) {
    return (
      <EntityAvatar entity={{ id: item.entityId, name: item.suggestion.name, sourceType: "person" }} size={size} />
    );
  }
  const dim = size === "lg" ? "h-12 w-12" : "h-6 w-6";
  const icon = size === "lg" ? 20 : 13;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border border-dashed border-border bg-muted text-muted-foreground",
        dim,
      )}
    >
      <UserFocusIcon size={icon} />
    </span>
  );
}

function GroupChip({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-[12rem] items-center truncate rounded-full border border-border bg-background/40 px-2 py-0.5 text-[10.5px] text-foreground/80 transition-colors group-hover:border-foreground/20 group-hover:bg-background/80">
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * One WhatsApp identity row inside the review queue. Line 1 mirrors the plain
 * review row (avatar · name · muted note · caret · actions) so the whole column
 * aligns; line 2 carries the evidence — a quiet channel glyph, the groups as the
 * recognizable anchor, then the muted phone. The primary action (Merge when we
 * already have an entity to fold this into, otherwise Add) opens the drawer,
 * where the guess is checked against the group history before anything commits.
 */
export function WhatsAppIdentityRow({
  item,
  onOpen,
  onResolve,
}: {
  item: WhatsAppIdentityReviewItem;
  onOpen: () => void;
  onResolve: (message: string) => void;
}) {
  const hasSuggestion = item.suggestion !== null;
  const name = item.suggestion?.name ?? "Unidentified contact";
  const note = hasSuggestion ? `${item.suggestion?.confidence} this person` : "needs a name";
  const primaryLabel = item.suggestion?.entityId ? "Merge" : "Add";
  const shownGroups = item.groups.slice(0, 2);
  const moreGroups = item.groups.length - shownGroups.length;

  return (
    <div className="border-b border-border/60 last:border-b-0" data-testid={`wa-identity-row-${item.id}`}>
      <div className="group flex w-full items-start transition-colors hover:bg-foreground/10">
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2 text-left">
          <div className="flex w-full items-center gap-2">
            <IdentityAvatar item={item} size="sm" />
            <span
              className={cn(
                "shrink-0 truncate text-[12.5px] font-medium",
                hasSuggestion ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {name}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{note}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            <WhatsappLogoIcon
              size={13}
              weight="fill"
              aria-label="WhatsApp"
              className="shrink-0 text-muted-foreground transition-all duration-200 group-hover:scale-110 group-hover:text-[#25D366]"
            />
            {shownGroups.map((group) => (
              <GroupChip key={group.groupJid} name={group.groupName} />
            ))}
            {moreGroups > 0 ? <span className="text-[10.5px] text-muted-foreground">+{moreGroups} more</span> : null}
            {item.phoneE164 ? (
              <>
                <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />
                <PhoneIcon size={13} weight="fill" aria-label="Phone" className="shrink-0 text-muted-foreground" />
                <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-background/40 px-2 py-0.5 font-mono text-[10px] tracking-tight text-muted-foreground">
                  {item.phoneE164}
                </span>
              </>
            ) : null}
          </div>
        </button>
        <span className="flex shrink-0 items-center gap-0.5 py-2 pr-3">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:underline"
          >
            {primaryLabel}
          </button>
          <span className="text-muted-foreground/40">·</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onResolve("Dismissed");
            }}
            className="px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Dismiss
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * Right-hand identify drawer for one WhatsApp contact. The name/phone/email form
 * leads as the primary action (the contact is unidentified — you're giving them
 * an identity), and the groups it's been seen in follow as the evidence you use
 * to fill it. Merge into an existing person stays a footer action.
 */
export function WhatsAppIdentityDrawer({
  item,
  onClose,
  onResolve,
}: {
  item: WhatsAppIdentityReviewItem | null;
  onClose: () => void;
  onResolve: (id: string, message: string) => void;
}) {
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[720px]">
        <SheetTitle className="sr-only">{item ? "Identify WhatsApp contact" : "Review"}</SheetTitle>
        <SheetDescription className="sr-only">
          Identify an unknown WhatsApp contact from the groups and messages it appears in, then save their details or
          merge them into someone you already know.
        </SheetDescription>
        {item ? (
          <WhatsAppIdentityBody
            key={item.id}
            item={item}
            onResolve={(message) => {
              onResolve(item.id, message);
              onClose();
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function WhatsAppIdentityBody({
  item,
  onResolve,
}: {
  item: WhatsAppIdentityReviewItem;
  onResolve: (message: string) => void;
}) {
  const [name, setName] = useState(item.suggestion?.name ?? "");
  const [phones, setPhones] = useState<ContactRow[]>(() => contactRows([item.phoneE164 ?? ""]));
  const [emails, setEmails] = useState<ContactRow[]>(() => contactRows([]));
  const [mergeOpen, setMergeOpen] = useState(false);
  const trimmedName = name.trim();
  const initialName = (item.suggestion?.name ?? "").trim();
  const initialPhone = (item.phoneE164 ?? "").trim();
  const phoneValues = contactValues(phones);
  const emailValues = contactValues(emails);
  const hasPhone = phoneValues.length > 0;
  const dirty = trimmedName !== initialName || phoneValues.join("|") !== initialPhone || emailValues.length > 0;
  const canSave = trimmedName.length > 0 && hasPhone && dirty;
  const hasGuess = item.suggestion !== null;
  const showSuggestionConfirm = hasGuess && !dirty;
  const confirmSuggestion = () => {
    onResolve(item.suggestion?.entityId ? `Merged into ${item.suggestion?.name}` : `Saved ${item.suggestion?.name}`);
  };
  const accent = "#f59e0b";

  return (
    <>
      <div
        className="sticky top-0 z-10 border-b bg-background px-6 pb-4 pt-5"
        style={{ borderTopColor: accent, borderTopWidth: 3 }}
      >
        <div className="flex items-start gap-3">
          <IdentityAvatar item={item} size="lg" />
          <div className="min-w-0 flex-1">
            <h2
              className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5"
              data-testid="wa-identity-display-name"
            >
              <span
                className={cn(
                  "min-w-0 max-w-full truncate font-serif text-[20px] leading-tight",
                  trimmedName.length === 0
                    ? "text-muted-foreground/50"
                    : showSuggestionConfirm
                      ? "text-foreground/85"
                      : "text-foreground",
                )}
              >
                {trimmedName.length > 0 ? name : "Unidentified contact"}
              </span>
              {showSuggestionConfirm ? (
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400">
                  ({item.suggestion?.confidence === "likely" ? "Likely" : "Possibly"})
                </span>
              ) : null}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                Person
              </Badge>
              <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wider">
                <WhatsappLogoIcon size={10} weight="fill" className="text-[#25D366]" />
                WhatsApp
              </Badge>
              <Badge
                variant="outline"
                className="border-amber-300 text-[10px] uppercase tracking-wider text-amber-700 dark:border-amber-700 dark:text-amber-400"
              >
                Unidentified
              </Badge>
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
        <ContactPointsEditor
          name={name}
          onNameChange={setName}
          namePlaceholder="Name this contact"
          nameConfirm={
            showSuggestionConfirm
              ? {
                  onConfirm: confirmSuggestion,
                  label: item.suggestion?.entityId ? "This is them" : "Use this name",
                }
              : null
          }
          phones={phones}
          emails={emails}
          onPhonesChange={setPhones}
          onEmailsChange={setEmails}
          findMatch={findContactMatch}
          onMergeSuggested={(match) => onResolve(`Merged into ${match.name}`)}
        />

        <div className="flex flex-col">
          <SectionLabel className="mb-1.5 font-medium">
            Seen in · {item.groups.length} {item.groups.length === 1 ? "group" : "groups"}
          </SectionLabel>
          <EntryList>
            {item.groups.map((group) => (
              <li key={group.groupJid} className="px-3.5 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                    {group.groupName}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/60">
                    {group.messageCount} msgs · {formatRelativeTime(group.lastMessageAt)}
                  </span>
                </div>
                {group.snippets.length > 0 ? (
                  <div className="mt-2 flex flex-col gap-1.5 border-l border-border pl-3">
                    {group.snippets.map((snippet) => (
                      <p
                        key={`${group.groupJid}:${snippet}`}
                        className="text-[12px] leading-relaxed text-muted-foreground"
                      >
                        {snippet}
                      </p>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </EntryList>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t bg-background px-6 py-3">
        <Button
          size="sm"
          onClick={() => onResolve(trimmedName ? `Saved ${trimmedName}` : "Saved")}
          disabled={!canSave}
          className="h-7 gap-1 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700"
          data-testid="wa-identity-add"
        >
          <CheckIcon size={12} weight="bold" />
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setMergeOpen(true)}
          className="h-7 gap-1 text-[11px]"
          data-testid="wa-identity-merge"
        >
          <ArrowsLeftRightIcon size={12} />
          Merge
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onResolve("Dismissed")}
          className="ml-auto h-7 gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          data-testid="wa-identity-dismiss"
        >
          <XIcon size={12} />
          Dismiss
        </Button>
      </div>

      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Merge this contact into…</DialogTitle>
            <DialogDescription>
              Pick the person this WhatsApp contact already is. Their number and group history fold into that entity —
              no new person is created.
            </DialogDescription>
          </DialogHeader>
          <EntityPicker
            entityType="person"
            onPick={(entityId) => {
              setMergeOpen(false);
              onResolve(`Merged into ${entityId}`);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
