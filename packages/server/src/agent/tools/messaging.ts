import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { normalizeWhatsAppIdentityLid, normalizeWhatsAppIdentityPhone } from "../../identity-normalization";
import { ChatHistoryAccessResolver, type ProviderTargetRef, providerTargetKey } from "./chat-search";
import { blankToUndefined } from "./optional-params";
import type { SelectableUser, SketchMcpDeps, ToolResult } from "./types";

function detectPlatform(recipient: SelectableUser): "slack" | "whatsapp" | null {
  if (recipient.slack_user_id) return "slack";
  if (recipient.whatsapp_number) return "whatsapp";
  return null;
}

function formatUserMatch(user: SelectableUser, matchedBy: string) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    slackUserId: user.slack_user_id,
    channels: [...(user.slack_user_id ? ["slack"] : []), ...(user.whatsapp_number ? ["whatsapp"] : [])],
    matchedBy,
  };
}

function extractSlackUserId(query: string): string | null {
  const mentionMatch = query.trim().match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch) return mentionMatch[1];
  const rawSlackIdMatch = query.trim().match(/^[A-Z][A-Z0-9]{4,}$/i);
  return rawSlackIdMatch ? rawSlackIdMatch[0] : null;
}

function looksLikeEmail(query: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(query.trim());
}

type WhatsAppIdentifier =
  | { lid: string | null; phoneE164: string | null; lookupLid: true; lookupPhone: true }
  | { lid: null; phoneE164: string; lookupLid: false; lookupPhone: true };

interface WhatsAppContactResult {
  name?: string;
  phoneE164?: string;
  lid?: string;
  source: "entity" | "group_participant";
  registered: false;
}

function extractWhatsAppIdentifier(query: string): WhatsAppIdentifier | null {
  const trimmed = query.trim();
  const mentionMatch = trimmed.match(/^@[\u200B-\u200F\uFEFF]*(\d{6,})$/u);
  if (mentionMatch) {
    const digits = mentionMatch[1];
    return {
      lid: normalizeWhatsAppIdentityLid(`${digits}@lid`),
      phoneE164: normalizeWhatsAppIdentityPhone(`+${digits}`),
      lookupLid: true,
      lookupPhone: true,
    };
  }

  const jidMatch = trimmed.match(/^(\d{6,})(?::\d+)?@(lid|s\.whatsapp\.net)$/iu);
  if (jidMatch) {
    const digits = jidMatch[1];
    return {
      lid: normalizeWhatsAppIdentityLid(`${digits}@lid`),
      phoneE164: normalizeWhatsAppIdentityPhone(`+${digits}`),
      lookupLid: true,
      lookupPhone: true,
    };
  }

  const plusPhone = normalizeWhatsAppIdentityPhone(trimmed);
  if (trimmed.startsWith("+") && plusPhone) {
    return { lid: null, phoneE164: plusPhone, lookupLid: false, lookupPhone: true };
  }

  if (/^\d{10,15}$/u.test(trimmed)) {
    const phoneE164 = normalizeWhatsAppIdentityPhone(`+${trimmed}`);
    return phoneE164 ? { lid: null, phoneE164, lookupLid: false, lookupPhone: true } : null;
  }

  return null;
}

function isPhoneShapedName(value: string | null | undefined): boolean {
  if (!value) return false;
  return normalizeWhatsAppIdentityPhone(value) !== null || /^\+?\d[\d\s().-]{6,}$/u.test(value.trim());
}

function pushWhatsAppContact(
  contacts: WhatsAppContactResult[],
  seen: Set<string>,
  contact: WhatsAppContactResult,
): void {
  const key = `${contact.source}:${contact.lid ?? ""}:${contact.phoneE164 ?? ""}:${contact.name ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  contacts.push(contact);
}

async function findUnregisteredWhatsAppContacts(
  identifier: WhatsAppIdentifier | null,
  db: SketchMcpDeps["db"],
): Promise<WhatsAppContactResult[]> {
  if (!identifier || !db) return [];
  const contacts: WhatsAppContactResult[] = [];
  const seen = new Set<string>();
  const contactPointFilters: Array<{ kind: "whatsapp_lid" | "whatsapp" | "phone"; value: string }> = [];
  if (identifier.lookupLid && identifier.lid) contactPointFilters.push({ kind: "whatsapp_lid", value: identifier.lid });
  if (identifier.lookupPhone && identifier.phoneE164) {
    contactPointFilters.push({ kind: "whatsapp", value: identifier.phoneE164 });
    contactPointFilters.push({ kind: "phone", value: identifier.phoneE164 });
  }

  for (const filter of contactPointFilters) {
    const rows = await db
      .selectFrom("entity_contact_points")
      .innerJoin("entities", "entities.id", "entity_contact_points.entity_id")
      .select([
        "entities.name",
        "entity_contact_points.kind",
        "entity_contact_points.value",
        "entity_contact_points.display_value",
      ])
      .where("entity_contact_points.kind", "=", filter.kind)
      .where("entity_contact_points.value", "=", filter.value)
      .where("entities.source_type", "=", "person")
      .where("entities.status", "!=", "archived")
      .where("entities.deleted_at", "is", null)
      .orderBy("entities.name", "asc")
      .orderBy("entities.id", "asc")
      .execute();

    for (const row of rows) {
      const phoneE164 =
        row.kind === "phone" || row.kind === "whatsapp"
          ? normalizeWhatsAppIdentityPhone(row.value)
          : normalizeWhatsAppIdentityPhone(row.display_value);
      const lid = row.kind === "whatsapp_lid" ? normalizeWhatsAppIdentityLid(row.value) : undefined;
      pushWhatsAppContact(contacts, seen, {
        ...(isPhoneShapedName(row.name) ? {} : { name: row.name }),
        ...(phoneE164 ? { phoneE164 } : {}),
        ...(lid ? { lid } : {}),
        source: "entity",
        registered: false,
      });
    }
  }

  if (identifier.lookupLid && identifier.lid) {
    const participantRows = await db
      .selectFrom("whatsapp_group_participants")
      .select(["participant_jid", "phone_e164", "lid"])
      .where((eb) => eb.or([eb("lid", "=", identifier.lid), eb("participant_jid", "=", identifier.lid ?? "")]))
      .orderBy("last_seen_at", "desc")
      .execute();
    for (const row of participantRows) {
      const phoneE164 = normalizeWhatsAppIdentityPhone(row.phone_e164);
      const lid = normalizeWhatsAppIdentityLid(row.lid ?? row.participant_jid);
      pushWhatsAppContact(contacts, seen, {
        ...(phoneE164 ? { phoneE164 } : {}),
        ...(lid ? { lid } : {}),
        source: "group_participant",
        registered: false,
      });
    }
  }

  return contacts;
}

async function deliverMessageToUser(
  params: { recipientUserId: string; message: string; storeInInbox?: boolean },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "userRepo" | "sendDm" | "currentUserId">,
): Promise<
  | { status: "sent"; recipient: SelectableUser; platform: "slack" | "whatsapp"; inboxMessageId?: string }
  | { status: "skipped" | "failed"; error: string; recipient?: SelectableUser }
> {
  if (!deps.userRepo || !deps.sendDm || !deps.currentUserId) {
    return { status: "failed", error: "messaging is not available in this context." };
  }
  if (params.recipientUserId === deps.currentUserId) {
    return { status: "failed", error: "cannot send a message to yourself." };
  }

  const recipient = await deps.userRepo.findById(params.recipientUserId);
  if (!recipient) return { status: "failed", error: "user not found." };

  const platform = detectPlatform(recipient);
  if (!platform) {
    return { status: "failed", error: `${recipient.name} has no connected channel (Slack or WhatsApp).`, recipient };
  }

  const delivery = await deps.sendDm({
    userId: params.recipientUserId,
    platform,
    message: params.message,
    ...(platform === "whatsapp"
      ? {
          senderUserId: deps.currentUserId,
          storeInInbox: params.storeInInbox !== false,
          inboxKind: "note",
        }
      : {}),
  });
  const { channelId, messageRef } = delivery;

  let inboxMessageId: string | undefined = delivery.inboxMessageId;
  if (params.storeInInbox !== false && !inboxMessageId) {
    if (!deps.inboxMessagesRepo) {
      return { status: "failed", error: "Inbox storage is not available in this context.", recipient };
    }
    const inboxMessage = await deps.inboxMessagesRepo.create({
      senderUserId: deps.currentUserId,
      recipientUserId: params.recipientUserId,
      message: params.message,
      platform,
      channelId,
      messageRef,
    });
    inboxMessageId = inboxMessage.id;
  }

  return { status: "sent", recipient, platform, inboxMessageId };
}

export interface SendMessageTarget {
  platform: "slack" | "whatsapp";
  targetType: "channel" | "group";
  targetId: string;
}

export interface SendMessageParams {
  message: string;
  recipientUserId?: string;
  target?: SendMessageTarget;
  threadTs?: string;
}

const sendMessageTargetSchema = z
  .object({
    platform: z.enum(["slack", "whatsapp"]).describe("The platform the target belongs to."),
    targetType: z
      .enum(["channel", "group"])
      .describe("Use 'channel' for Slack and 'group' for WhatsApp. Other combinations are rejected."),
    targetId: z
      .string()
      .describe("The targetId returned by SearchDeliveryTargets. Never guess a channel ID or group JID."),
  })
  .describe("The channel or group to post in, exactly as returned by SearchDeliveryTargets.");

export type SendMessageDeps = Pick<
  SketchMcpDeps,
  "inboxMessagesRepo" | "userRepo" | "sendDm" | "sendTargetMessage" | "currentUserId" | "db" | "conversationContext"
>;

/** Structural slice of ChatHistoryAccessResolver so callers can inject a stub. */
export interface SendMessageTargetAccess {
  authorizedProviderTargets: (targets: ProviderTargetRef[]) => Promise<Set<string>>;
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

const THREAD_TS_SCOPE_ERROR = "threadTs can only be used with a Slack channel target.";

/**
 * A blank value carries no identity — an empty threadTs names no thread and an
 * empty recipientUserId names no person — so it means "absent", not "invalid".
 * Rejecting it produced an unrecoverable loop: the tool told the model to omit
 * the field, and the model could only re-send the same empty string.
 */
function normalizeSendMessageParams(params: SendMessageParams): SendMessageParams {
  return {
    ...params,
    threadTs: blankToUndefined(params.threadTs),
    recipientUserId: blankToUndefined(params.recipientUserId),
  };
}

function validateTarget(target: SendMessageTarget, threadTs: string | undefined): string | null {
  if (!target.targetId.trim()) {
    return "target.targetId is required. Use SearchDeliveryTargets to find the channel or group first.";
  }
  if (target.platform === "slack" && target.targetType !== "channel") {
    return "A Slack target must use targetType 'channel'.";
  }
  if (target.platform === "whatsapp" && target.targetType !== "group") {
    return "A WhatsApp target must use targetType 'group'.";
  }
  if (threadTs !== undefined && target.platform !== "slack") return THREAD_TS_SCOPE_ERROR;
  return null;
}

/**
 * Posting into a shared destination is allowed only when the person who asked
 * is a member of it, checked before the send so a denial never leaks content.
 * Membership comes from the same passive rosters chat history uses, so a very
 * recent join may not be visible yet.
 */
async function sendToTarget(
  params: SendMessageParams & { target: SendMessageTarget },
  deps: SendMessageDeps,
  access: SendMessageTargetAccess,
): Promise<ToolResult> {
  const { target, threadTs } = params;
  const invalid = validateTarget(target, threadTs);
  if (invalid) return toolError(invalid);

  if (!deps.sendTargetMessage) {
    return toolError("Sending to a channel or group is not available in this context.");
  }
  if (!deps.db || !deps.currentUserId) {
    return toolError("Sending to a channel or group requires an authenticated requesting user.");
  }

  const authorized = await access.authorizedProviderTargets([{ platform: target.platform, targetId: target.targetId }]);
  if (!authorized.has(providerTargetKey({ platform: target.platform, targetId: target.targetId }))) {
    return toolError(
      "the person you are working for is not a known member of that channel or group, so Sketch will not post there. Ask them to confirm the target with SearchDeliveryTargets. If they joined very recently, it can take a short while before the membership is seen.",
    );
  }

  try {
    const { messageRef } = await deps.sendTargetMessage({
      platform: target.platform,
      targetType: target.targetType,
      targetId: target.targetId,
      message: params.message,
      ...(threadTs ? { threadTs } : {}),
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "sent",
            platform: target.platform,
            targetType: target.targetType,
            targetId: target.targetId,
            ...(threadTs ? { threadTs } : {}),
            ...(messageRef ? { messageRef } : {}),
          }),
        },
      ],
    };
  } catch (error) {
    return toolError(error instanceof Error ? error.message : "Unknown error");
  }
}

export async function handleSendMessage(
  rawParams: SendMessageParams,
  deps: SendMessageDeps,
  access: SendMessageTargetAccess = new ChatHistoryAccessResolver(deps),
): Promise<ToolResult> {
  const params = normalizeSendMessageParams(rawParams);
  if (!params.message.trim()) {
    return toolError("message must not be empty.");
  }
  if (params.recipientUserId !== undefined && params.target !== undefined) {
    return toolError("set only one of recipientUserId or target, not both.");
  }
  if (params.target !== undefined) {
    return sendToTarget({ ...params, target: params.target }, deps, access);
  }
  if (params.recipientUserId === undefined) {
    return toolError("set exactly one of recipientUserId (for a direct message) or target (for a channel or group).");
  }
  if (params.threadTs !== undefined) return toolError(THREAD_TS_SCOPE_ERROR);

  const result = await deliverMessageToUser(
    { recipientUserId: params.recipientUserId, message: params.message, storeInInbox: true },
    deps,
  );
  if (result.status !== "sent") {
    return toolError(result.error);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          inboxMessageId: result.inboxMessageId,
          recipientName: result.recipient.name,
          status: "sent",
        }),
      },
    ],
  };
}

export async function handleSendMessageToTarget(
  rawParams: SendMessageParams,
  deps: SendMessageDeps,
  access: SendMessageTargetAccess = new ChatHistoryAccessResolver(deps),
): Promise<ToolResult> {
  const params = normalizeSendMessageParams(rawParams);
  if (!params.message.trim()) return toolError("message must not be empty.");
  if (params.recipientUserId !== undefined) return toolError("set only target for channel or group posting.");
  if (params.target === undefined) return toolError("target is required for channel or group posting.");
  return sendToTarget({ ...params, target: params.target }, deps, access);
}

export const searchUsersToolSchema = {
  queries: z.array(z.string()).describe("Names, emails, Slack mentions, or Slack user IDs to resolve."),
};

export type SearchUsersArgs = { queries: string[] };

export async function handleSearchUsers(
  params: SearchUsersArgs,
  deps: Pick<SketchMcpDeps, "userRepo" | "currentUserId" | "db">,
): Promise<ToolResult> {
  if (!deps.userRepo) {
    return { content: [{ type: "text" as const, text: "User search is not available in this context." }] };
  }

  const results: Array<{
    query: string;
    matches: Array<Record<string, unknown>>;
    whatsappContacts?: WhatsAppContactResult[];
  }> = [];

  for (const query of params.queries) {
    const matches: Array<Record<string, unknown>> = [];
    let whatsappContacts: WhatsAppContactResult[] = [];
    const seen = new Set<string>();
    const slackUserId = extractSlackUserId(query);
    const trimmedQuery = query.trim();
    const whatsappIdentifier = extractWhatsAppIdentifier(trimmedQuery);

    const pushMatch = (user: SelectableUser | undefined, matchedBy: string) => {
      if (!user || user.id === deps.currentUserId || seen.has(user.id)) return;
      seen.add(user.id);
      matches.push(formatUserMatch(user, matchedBy));
    };

    if (slackUserId) {
      pushMatch(await deps.userRepo.findBySlackId?.(slackUserId), "slack_user_id");
    }

    if (whatsappIdentifier?.lookupLid && whatsappIdentifier.lid) {
      pushMatch(await deps.userRepo.findByWhatsappLid?.(whatsappIdentifier.lid), "whatsapp_lid");
    }

    if (whatsappIdentifier?.lookupPhone && whatsappIdentifier.phoneE164) {
      pushMatch(await deps.userRepo.findByWhatsappNumber?.(whatsappIdentifier.phoneE164), "whatsapp_number");
    }

    if (matches.length === 0) {
      whatsappContacts = await findUnregisteredWhatsAppContacts(whatsappIdentifier, deps.db);
    }

    if (looksLikeEmail(trimmedQuery)) {
      pushMatch(await deps.userRepo.findByEmail?.(trimmedQuery), "exact_email");
    }

    pushMatch(await deps.userRepo.findByExactName?.(trimmedQuery, deps.currentUserId), "exact_name");

    const prefixMatches = deps.userRepo.searchByNamePrefix
      ? await deps.userRepo.searchByNamePrefix(trimmedQuery, 5, deps.currentUserId)
      : [];
    for (const user of prefixMatches) {
      pushMatch(user, "prefix_name");
    }

    if (trimmedQuery.length >= 3) {
      const substringMatches = deps.userRepo.searchByNameSubstring
        ? await deps.userRepo.searchByNameSubstring(trimmedQuery, 5, deps.currentUserId)
        : [];
      for (const user of substringMatches) {
        pushMatch(user, "substring_name");
      }
    }

    results.push({ query, matches, ...(whatsappContacts.length > 0 ? { whatsappContacts } : {}) });
  }

  return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
}

export async function handleSendMessageToUsers(
  params: { recipientUserIds: string[]; message: string; storeInInbox?: boolean },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "userRepo" | "sendDm" | "currentUserId">,
): Promise<ToolResult> {
  if (!params.message.trim()) {
    return toolError("message must not be empty.");
  }
  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  for (const recipientUserId of params.recipientUserIds) {
    if (seen.has(recipientUserId)) {
      results.push({ recipientUserId, status: "skipped", error: "Duplicate recipient in request" });
      continue;
    }
    seen.add(recipientUserId);

    try {
      const result = await deliverMessageToUser(
        { recipientUserId, message: params.message, storeInInbox: params.storeInInbox },
        deps,
      );

      if (result.status === "sent") {
        results.push({
          recipientUserId,
          recipientName: result.recipient.name,
          status: "sent",
          platform: result.platform,
          ...(result.inboxMessageId ? { inboxMessageId: result.inboxMessageId } : {}),
        });
      } else {
        results.push({
          recipientUserId,
          recipientName: result.recipient?.name,
          status: result.status,
          error: result.error,
        });
      }
    } catch (error) {
      results.push({
        recipientUserId,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
}

export function createMessagingTools(deps: SketchMcpDeps) {
  return [
    tool(
      "SearchUsers",
      "Resolve names, emails, Slack mentions/IDs, WhatsApp phone numbers, and WhatsApp mention IDs (@<digits>) into tenant users; unregistered WhatsApp contacts are reported separately.",
      searchUsersToolSchema,
      async (params) => handleSearchUsers(params, deps),
    ),

    tool(
      "SendMessage",
      "Send one direct message to a team member. A DM goes out on the person's connected channel and the same text is also stored as a one-way inbox item, so their agent can see it on their next private chat.",
      {
        message: z.string().describe("The exact message text to send."),
        recipientUserId: z.string().optional().describe("The user ID from GetTeamDirectory. Use this to send a DM."),
      },
      async (params) => {
        const rawParams = normalizeSendMessageParams(params as SendMessageParams);
        if (rawParams.target !== undefined || rawParams.threadTs !== undefined) {
          return toolError("channel and group posting requires SendMessageToTarget.");
        }
        return handleSendMessage(rawParams, deps);
      },
    ),

    tool(
      "SendMessageToTarget",
      "Post one message in a Slack channel or WhatsApp group. First resolve the destination with SearchDeliveryTargets and pass its platform, targetType, and targetId. The person you are working for must be a member of the destination.",
      {
        message: z.string().describe("The exact message text to send."),
        target: sendMessageTargetSchema,
        threadTs: z
          .string()
          .optional()
          .describe(
            "Slack thread timestamp to reply in. Only valid with a Slack channel target. Omit it or pass an empty string to post a top-level message.",
          ),
      },
      async (params) => handleSendMessageToTarget(params, deps),
    ),

    tool(
      "SendMessageToUsers",
      "Send the same DM to multiple team members. When storeInInbox is true, the sent message is also stored as a one-way inbox item for each successful recipient.",
      {
        recipientUserIds: z.array(z.string()).describe("The recipient user IDs to message."),
        message: z.string().describe("The exact message text to send to every recipient."),
        storeInInbox: z
          .boolean()
          .optional()
          .describe(
            "Whether to store the sent message in each recipient's inbox. Defaults to true. WhatsApp out-of-window content is always parked in the inbox regardless of this setting so it is not lost.",
          ),
      },
      async (params) => handleSendMessageToUsers(params, deps),
    ),
  ];
}
