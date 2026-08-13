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
import { ArrowsLeftRightIcon, CheckIcon, UserFocusIcon, WhatsappLogoIcon, XIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { cn } from "@sketch/ui/lib/utils";
import { useState } from "react";
import { toast } from "sonner";
import { EntryList, SectionLabel } from "../entity-drawer/drawer-kit";

/** One WhatsApp group the contact has been seen in, with a recent excerpt to help place them. */
export interface WhatsAppGroupSighting {
  groupJid: string;
  groupName: string;
  messageCount: number;
  lastMessageAt: string;
  /** A recent message excerpt shown to the admin to aid identification. Not persisted/logged. */
  snippet: string | null;
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
        snippet: "I'll send the revised pricing by EOD — looping in Sanaa for the Thursday call.",
      },
      {
        groupJid: "g2",
        groupName: "Deal Room – APAC",
        messageCount: 12,
        lastMessageAt: "2026-08-08T10:00:00Z",
        snippet: "Confirmed, our team can support the Q3 rollout in Mumbai.",
      },
      {
        groupJid: "g3",
        groupName: "Founders ⚡",
        messageCount: 3,
        lastMessageAt: "2026-07-24T18:00:00Z",
        snippet: "Great meeting you all at the summit 🙏",
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
        snippet: "Sharing the deck now — let me know if the numbers on slide 6 look right.",
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
        snippet: "The cohort data is in the shared folder — pulling churn next.",
      },
      {
        groupJid: "g6",
        groupName: "Sketch WhatsApp test",
        messageCount: 33,
        lastMessageAt: "2026-08-13T06:00:00Z",
        snippet: "Testing — does the bot pick this up?",
      },
    ],
  },
];

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
    <span className="inline-flex max-w-[12rem] items-center truncate rounded-full border border-border bg-background/40 px-2 py-0.5 text-[10.5px] text-foreground/80">
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
      <div className="flex w-full items-start transition-colors hover:bg-foreground/10">
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
              className="shrink-0 text-muted-foreground"
            />
            {shownGroups.map((group) => (
              <GroupChip key={group.groupJid} name={group.groupName} />
            ))}
            {moreGroups > 0 ? <span className="text-[10.5px] text-muted-foreground">+{moreGroups} more</span> : null}
            {item.phoneE164 ? (
              <span className="ml-1 font-mono text-[10px] tracking-tight text-muted-foreground/70">
                {item.phoneE164}
              </span>
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
  const [phone, setPhone] = useState(item.phoneE164 ?? "");
  const [email, setEmail] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const trimmedName = name.trim();
  const initialName = (item.suggestion?.name ?? "").trim();
  const initialPhone = (item.phoneE164 ?? "").trim();
  const dirty = trimmedName !== initialName || phone.trim() !== initialPhone || email.trim().length > 0;
  const canSave = trimmedName.length > 0 && dirty;
  const hasGuess = item.suggestion !== null;
  const showSuggestionConfirm = hasGuess && !dirty;
  const confirmSuggestion = () => {
    onResolve(item.suggestion?.entityId ? `Merged into ${item.suggestion?.name}` : `Saved ${item.suggestion?.name}`);
  };
  const accent = "#f59e0b";
  const helper = item.suggestion
    ? "We've guessed a name below — confirm it, or merge them into someone you already know."
    : "Name this contact from the groups below, or merge them into someone you already know.";

  return (
    <>
      <div
        className="sticky top-0 z-10 border-b bg-background px-6 pb-4 pt-5"
        style={{ borderTopColor: accent, borderTopWidth: 3 }}
      >
        <div className="flex items-start gap-3">
          <IdentityAvatar item={item} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                Person
              </Badge>
              <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wider">
                <WhatsappLogoIcon size={10} weight="fill" />
                WhatsApp
              </Badge>
              <Badge
                variant="outline"
                className="border-amber-300 text-[10px] uppercase tracking-wider text-amber-700 dark:border-amber-700 dark:text-amber-400"
              >
                Unidentified
              </Badge>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-4">
        <div className="-mx-6 flex flex-col gap-3.5 border-b bg-muted/40 px-6 pb-5 pt-4 dark:bg-muted/20">
          <div className="flex flex-col gap-1.5">
            <SectionLabel className="font-medium">Name</SectionLabel>
            <Input
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder="Name this contact"
              aria-label="Name"
              className="h-10 bg-background font-serif text-[17px]"
              data-testid="wa-identity-name-input"
            />
            {showSuggestionConfirm ? (
              <button
                type="button"
                onClick={confirmSuggestion}
                className="inline-flex items-center gap-1.5 self-start rounded-full border border-emerald-400/60 bg-emerald-50/60 px-2.5 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100/70 dark:border-emerald-600/50 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/50"
                data-testid="wa-identity-confirm-suggestion"
              >
                <CheckIcon size={11} weight="bold" />
                {item.suggestion?.entityId ? "This is them" : "Use this name"}
              </button>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <SectionLabel className="font-medium">
              Phone <span className="normal-case tracking-normal opacity-70">(optional)</span>
            </SectionLabel>
            <Input
              value={phone}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              inputMode="tel"
              className="bg-background font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <SectionLabel className="font-medium">
              Email <span className="normal-case tracking-normal opacity-70">(optional)</span>
            </SectionLabel>
            <Input
              value={email}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              placeholder="name@company.com"
              inputMode="email"
              className="bg-background font-mono text-xs"
            />
          </div>
        </div>

        <div className="flex flex-col">
          <SectionLabel className="mb-1.5 font-medium">
            Seen in · {item.groups.length} {item.groups.length === 1 ? "group" : "groups"}
          </SectionLabel>
          <EntryList>
            {item.groups.map((group) => (
              <li key={group.groupJid} className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-sm bg-muted px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                    <WhatsappLogoIcon size={9} weight="fill" />
                    Group
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{group.groupName}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {group.messageCount} msgs · {formatRelativeTime(group.lastMessageAt)}
                  </span>
                </div>
                {group.snippet ? (
                  <p className="mt-1.5 border-l-2 border-border pl-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                    {group.snippet}
                  </p>
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
