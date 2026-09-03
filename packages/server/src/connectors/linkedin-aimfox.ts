import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { normalizePhoneCountryCode } from "../identity-normalization";
import {
  AimfoxClient,
  type AimfoxConversation,
  type AimfoxConversationListItem,
  type AimfoxLead,
  type AimfoxMessage,
} from "./aimfox-client";
import { type LinkedinAimfoxPersonSeed, buildPersonSeed } from "./linkedin-aimfox-mappers";
import { extractErrorMessage, runWithConcurrency, truncateErrorMessage } from "./sync-utils";
import type { ApiKeyCredentials, Connector, ConnectorCredentials, ContactPointSeed, SyncedItem } from "./types";
import { toEmailPrincipals } from "./types";

const DEFAULT_CONVERSATION_COUNT = 100;
const DEFAULT_MAX_INFLIGHT = 3;
const DEFAULT_SEGMENT_MAX_MESSAGES = 100;
const DEFAULT_SEGMENT_MAX_TOKENS = 4_000;
const SEGMENT_ALGORITHM_VERSION = 1;
const LINKEDIN_AIMFOX_CURSOR_VERSION = 1;

export interface LinkedinAimfoxScopeConfig extends Record<string, unknown> {
  accountIds: string[];
  maxConversations?: number;
  maxInflight?: number;
  segmentMaxMessages?: number;
  segmentMaxTokens?: number;
  contactPointDefaultRegion?: string;
}

interface LinkedinAimfoxCursorAccountState {
  highWatermark: string | null;
}

interface LinkedinAimfoxCursor {
  version: 1;
  accounts: Record<string, LinkedinAimfoxCursorAccountState>;
}

export interface LinkedinAimfoxSegmentManifest {
  segmentIndex: number;
  terminalMessageId: string;
  messageCount: number;
  algorithmVersion: number;
  sealed: boolean;
}

export interface OrderedMessage {
  identity: string;
  timestamp: string | null;
  message: AimfoxMessage;
}

export interface LinkedinAimfoxSegment {
  manifest: LinkedinAimfoxSegmentManifest;
  messages: OrderedMessage[];
}

interface ConversationCompletion {
  activity: string | null;
  expectedItems: number;
  persistedItems: number;
  failed: boolean;
}

interface AccountRunState {
  existingHighWatermark: string | null;
  conversations: Map<string, ConversationCompletion>;
}

interface ParsedLinkedinAimfoxScopeConfig {
  accountIds: string[];
  maxConversations: number;
  maxInflight: number;
  segmentMaxMessages: number;
  segmentMaxTokens: number;
  contactPointDefaultRegion?: string;
}

export class LinkedinAimfoxNoAccountsError extends Error {
  constructor() {
    super("No Aimfox LinkedIn accounts are connected for this API key");
    this.name = "LinkedinAimfoxNoAccountsError";
  }
}

function requireApiKeyCredentials(credentials: ConnectorCredentials): ApiKeyCredentials {
  if (credentials.type !== "api_key") throw new Error("LinkedIn Aimfox connector requires api_key credentials");
  if (!credentials.api_key?.trim()) throw new Error("Aimfox API key is required");
  return credentials;
}

export async function discoverLinkedinAimfoxScopeConfig(
  credentials: ConnectorCredentials,
  requestedScopeConfig?: Record<string, unknown>,
): Promise<LinkedinAimfoxScopeConfig> {
  const { api_key } = requireApiKeyCredentials(credentials);
  const accounts = await new AimfoxClient(api_key).listAccounts();
  const accountIds = [...new Set(accounts.map((account) => String(account.id)).filter(Boolean))].sort();
  if (accountIds.length === 0) throw new LinkedinAimfoxNoAccountsError();

  return { ...requestedScopeConfig, accountIds } as LinkedinAimfoxScopeConfig;
}

export function createLinkedinAimfoxConnector(): Connector {
  let currentCursor = emptyLinkedinAimfoxCursor();
  let runState = new Map<string, AccountRunState>();

  return {
    type: "linkedin_aimfox",
    perUserAuth: false,
    requiresOAuthClientSetup: false,
    syncIsCompleteSnapshot: false,
    promotableFileTypes: [],

    async validateCredentials(credentials) {
      await discoverLinkedinAimfoxScopeConfig(credentials);
    },

    async *sync(opts) {
      const { api_key } = requireApiKeyCredentials(opts.credentials);
      if (!opts.ownerEmail) throw new Error("LinkedIn Aimfox sync requires a connector owner email");
      const scopeConfig = parseScopeConfig(opts.scopeConfig);
      currentCursor = parseLinkedinAimfoxCursor(opts.cursor);
      runState = new Map();
      let remainingConversationBudget = scopeConfig.maxConversations;

      for (const accountId of scopeConfig.accountIds) {
        if (remainingConversationBudget <= 0) break;
        const accountState: AccountRunState = {
          existingHighWatermark: currentCursor.accounts[accountId]?.highWatermark ?? null,
          conversations: new Map(),
        };
        runState.set(accountId, accountState);
        const client = new AimfoxClient(api_key, { accountId });
        for await (const result of paginateConversationLeads(client, {
          accountHighWatermark: accountState.existingHighWatermark,
          maxConversations: remainingConversationBudget,
          maxInflight: scopeConfig.maxInflight,
          logger: opts.logger,
        })) {
          remainingConversationBudget--;
          const conversationUrn = result.conversation.conversation_urn;
          const activity = conversationLastContactedAt(result.conversation);

          if (!("lead" in result)) {
            accountState.conversations.set(conversationUrn, {
              activity,
              expectedItems: 0,
              persistedItems: 0,
              failed: true,
            });
            opts.logger.warn(
              { leadId: result.leadId, conversationUrn, err: result.error },
              "Failed to fetch LinkedIn Aimfox lead detail",
            );
            continue;
          }

          const seed = buildPersonSeed(result.lead);
          if (!seed) {
            accountState.conversations.set(conversationUrn, {
              activity,
              expectedItems: 0,
              persistedItems: 0,
              failed: false,
            });
            continue;
          }

          try {
            const items = await buildLinkedinSyncedItems(client, {
              accountId,
              conversation: result.conversation,
              ownerEmail: opts.ownerEmail,
              seed,
              segmentMaxMessages: scopeConfig.segmentMaxMessages,
              segmentMaxTokens: scopeConfig.segmentMaxTokens,
              contactPointDefaultRegion: scopeConfig.contactPointDefaultRegion,
              getExistingItemState: opts.getExistingItemState,
            });
            accountState.conversations.set(conversationUrn, {
              activity,
              expectedItems: items.length,
              persistedItems: 0,
              failed: false,
            });
            for (const item of items) yield item;
          } catch (err) {
            const error = truncateErrorMessage(extractErrorMessage(err));
            accountState.conversations.set(conversationUrn, {
              activity,
              expectedItems: 0,
              persistedItems: 0,
              failed: true,
            });
            opts.logger.warn({ leadId: result.leadId, conversationUrn, err: error }, "Failed to ingest Aimfox thread");
          }
        }
      }
    },

    onItemResult({ item, persisted }) {
      const checkpoint = readCheckpoint(item.sourceMeta);
      if (!checkpoint) return;
      const account = runState.get(checkpoint.accountId);
      const conversation = account?.conversations.get(checkpoint.conversationUrn);
      if (!conversation) return;
      if (persisted) conversation.persistedItems++;
      else conversation.failed = true;
    },

    async getCursor({ currentCursor: storedCursor }) {
      const next = cloneLinkedinAimfoxCursor(parseLinkedinAimfoxCursor(storedCursor));
      for (const [accountId, state] of runState) {
        next.accounts[accountId] = { highWatermark: persistedHighWatermark(state) };
      }
      return JSON.stringify(next);
    },
  };
}

type ConversationLeadResult =
  | { leadId: string; conversation: AimfoxConversationListItem; lead: AimfoxLead; error: null }
  | { leadId: string; conversation: AimfoxConversationListItem; error: string };

async function* paginateConversationLeads(
  client: AimfoxClient,
  opts: {
    accountHighWatermark: string | null;
    maxConversations: number;
    maxInflight: number;
    logger: Logger;
  },
): AsyncGenerator<ConversationLeadResult> {
  const conversations = await client.listConversations(opts.maxConversations);
  if (conversations.length >= opts.maxConversations) {
    opts.logger.warn(
      { count: conversations.length },
      "LinkedIn Aimfox conversation sync reached list cap; upstream pagination is unavailable",
    );
  }
  const highWatermark = opts.accountHighWatermark;
  const changedConversations = highWatermark
    ? conversations.filter((conversation) => conversationChangedSince(conversation, highWatermark))
    : conversations;
  const details: ConversationLeadResult[] = [];
  await runWithConcurrency(changedConversations, opts.maxInflight, async (conversation) => {
    const participant = conversationCounterpart(conversation);
    if (!participant?.id) {
      details.push({ leadId: "unknown", conversation, error: "LinkedIn conversation has no lead participant" });
      return;
    }
    const leadId = participant.id;
    try {
      details.push({ leadId, conversation, lead: await client.getLead(leadId), error: null });
    } catch (err) {
      details.push({ leadId, conversation, error: truncateErrorMessage(extractErrorMessage(err)) });
    }
  });
  details.sort((left, right) => {
    const leftActivity = conversationLastContactedAt(left.conversation) ?? "";
    const rightActivity = conversationLastContactedAt(right.conversation) ?? "";
    return (
      leftActivity.localeCompare(rightActivity) ||
      left.conversation.conversation_urn.localeCompare(right.conversation.conversation_urn)
    );
  });
  for (const detail of details) yield detail;
}

async function buildLinkedinSyncedItems(
  client: AimfoxClient,
  input: {
    accountId: string;
    conversation: AimfoxConversationListItem;
    ownerEmail: string;
    seed: LinkedinAimfoxPersonSeed;
    segmentMaxMessages: number;
    segmentMaxTokens: number;
    contactPointDefaultRegion?: string;
    getExistingItemState?: (providerFileId: string) => {
      sourceMeta: Record<string, unknown> | null;
      threadId: string | null;
    } | null;
  },
): Promise<SyncedItem[]> {
  const detail = await client.getConversation(input.conversation.conversation_urn);
  const messages = orderLinkedinMessages(input.conversation.conversation_urn, detail.messages);
  const profileItem = buildLinkedinProfileSyncedItem({ ...input, engaged: true });
  const manifests = loadExistingSealedManifests(input);
  const segments = buildLinkedinSegments(messages, manifests, {
    maxMessages: input.segmentMaxMessages,
    maxTokens: input.segmentMaxTokens,
  });
  return [
    profileItem,
    ...segments.map((segment) =>
      buildLinkedinConversationSyncedItem({
        accountId: input.accountId,
        conversation: input.conversation,
        ownerEmail: input.ownerEmail,
        profileProviderFileId: profileItem.providerFileId,
        seed: input.seed,
        segment,
      }),
    ),
  ];
}

function loadExistingSealedManifests(input: {
  accountId: string;
  conversation: AimfoxConversationListItem;
  getExistingItemState?: (providerFileId: string) => {
    sourceMeta: Record<string, unknown> | null;
    threadId: string | null;
  } | null;
}): LinkedinAimfoxSegmentManifest[] {
  const manifests: LinkedinAimfoxSegmentManifest[] = [];
  for (let segmentIndex = 0; segmentIndex < 10_000; segmentIndex++) {
    const providerFileId = linkedinSegmentProviderFileId(
      input.accountId,
      input.conversation.conversation_urn,
      segmentIndex,
    );
    const state = input.getExistingItemState?.(providerFileId);
    if (!state) break;
    const manifest = readSegmentManifest(state.sourceMeta);
    if (!manifest?.sealed) break;
    manifests.push(manifest);
  }
  return manifests;
}

export function buildLinkedinSegments(
  orderedMessages: OrderedMessage[],
  existingSealedManifests: LinkedinAimfoxSegmentManifest[],
  limits: { maxMessages: number; maxTokens: number },
): LinkedinAimfoxSegment[] {
  const segments: LinkedinAimfoxSegment[] = [];
  let offset = 0;
  for (const manifest of [...existingSealedManifests].sort((a, b) => a.segmentIndex - b.segmentIndex)) {
    if (manifest.segmentIndex !== segments.length) throw new Error("LinkedIn segment manifest index is not contiguous");
    const terminalIndex = orderedMessages.findIndex(
      (message, index) => index >= offset && message.identity === manifest.terminalMessageId,
    );
    if (terminalIndex < offset) throw new Error("LinkedIn sealed segment terminal message is missing");
    segments.push({ manifest, messages: orderedMessages.slice(offset, terminalIndex + 1) });
    offset = terminalIndex + 1;
  }

  while (offset < orderedMessages.length) {
    const segmentIndex = segments.length;
    const messages: OrderedMessage[] = [];
    let tokenCount = 0;
    while (offset < orderedMessages.length && messages.length < limits.maxMessages) {
      const message = orderedMessages[offset];
      const nextTokens = estimateMessageTokens(message.message);
      if (messages.length > 0 && tokenCount + nextTokens > limits.maxTokens) break;
      messages.push(message);
      tokenCount += nextTokens;
      offset++;
      if (tokenCount >= limits.maxTokens) break;
    }
    const terminal = messages.at(-1);
    if (!terminal) throw new Error("LinkedIn segmenter made no progress");
    const sealed =
      messages.length >= limits.maxMessages || tokenCount >= limits.maxTokens || offset < orderedMessages.length;
    segments.push({
      messages,
      manifest: {
        segmentIndex,
        terminalMessageId: terminal.identity,
        messageCount: messages.length,
        algorithmVersion: SEGMENT_ALGORITHM_VERSION,
        sealed,
      },
    });
  }
  return segments;
}

function buildLinkedinProfileSyncedItem(input: {
  accountId: string;
  conversation: AimfoxConversationListItem;
  ownerEmail: string;
  seed: LinkedinAimfoxPersonSeed;
  engaged: boolean;
  contactPointDefaultRegion?: string;
}): SyncedItem {
  const providerFileId = linkedinProfileProviderFileId(input.accountId, input.seed.leadId);
  const contactPoints = buildProfileContactPoints(
    input.seed,
    conversationLastContactedAt(input.conversation),
    input.contactPointDefaultRegion,
  );
  const personSeed = {
    name: input.seed.name,
    email: input.seed.emails[0],
    subtype: "external" as const,
    source: "aimfox",
    sourceId: input.seed.leadId,
    sourceUrl: input.seed.profileUrl,
    linkedinPublicIdentifier: input.seed.publicIdentifier,
    linkedinUrl: input.seed.profileUrl,
    emails: input.seed.emails,
    phones: input.seed.phones,
    company: {
      name: input.seed.currentCompanyName,
      slug: input.seed.currentCompanyUniversalName,
      linkedinUrl: input.seed.currentCompanyLinkedinUrl,
      websiteDomains: input.seed.currentCompanyWebsiteDomains,
      engaged: input.engaged,
    },
    enrichmentCandidate: input.seed.emails.length === 0,
    metadata: input.seed.metadata,
  };
  const content = renderLinkedinProfile(input.seed);
  const checkpoint = checkpointMeta(input.accountId, input.conversation.conversation_urn);
  return {
    providerFileId,
    providerUrl: input.seed.profileUrl,
    fileName: `LinkedIn profile - ${input.seed.name}`,
    fileType: "linkedin_profile",
    contentCategory: "structured",
    content,
    sourcePath: "LinkedIn / Profiles",
    sourceMeta: { linkedinAimfox: { ...checkpoint, kind: "profile" } },
    rollupGroupId: providerFileId,
    contentHash: sha256(JSON.stringify({ content, personSeed, contactPoints })),
    sourceCreatedAt: null,
    sourceUpdatedAt: conversationLastContactedAt(input.conversation),
    mimeType: "application/json",
    accessPrincipals: toEmailPrincipals([input.ownerEmail]),
    personSeeds: [personSeed],
    contactPoints,
  };
}

function buildLinkedinConversationSyncedItem(input: {
  accountId: string;
  conversation: AimfoxConversationListItem;
  ownerEmail: string;
  profileProviderFileId: string;
  seed: LinkedinAimfoxPersonSeed;
  segment: LinkedinAimfoxSegment;
}): SyncedItem {
  const content = renderConversationSegment(input.accountId, input.segment.messages);
  const firstTimestamp = input.segment.messages[0]?.timestamp ?? null;
  const lastTimestamp = input.segment.messages.at(-1)?.timestamp ?? null;
  return {
    providerFileId: linkedinSegmentProviderFileId(
      input.accountId,
      input.conversation.conversation_urn,
      input.segment.manifest.segmentIndex,
    ),
    threadId: `${input.accountId}:${input.conversation.conversation_urn}`,
    providerUrl: null,
    fileName: `LinkedIn conversation - ${input.seed.name} - ${input.segment.manifest.segmentIndex + 1}`,
    fileType: "linkedin_conversation",
    contentCategory: "document",
    content,
    sourcePath: `LinkedIn / ${input.seed.name}`,
    sourceMeta: {
      linkedinAimfox: {
        ...checkpointMeta(input.accountId, input.conversation.conversation_urn),
        kind: "conversation_segment",
        segmentManifest: input.segment.manifest,
      },
    },
    rollupGroupId: input.profileProviderFileId,
    contentHash: sha256(content),
    sourceCreatedAt: firstTimestamp,
    sourceUpdatedAt: lastTimestamp,
    mimeType: "text/plain",
    accessPrincipals: toEmailPrincipals([input.ownerEmail]),
    parentEntities: [
      {
        source: "aimfox",
        sourceId: input.seed.leadId,
        contextSnippet: `LinkedIn conversation with ${input.seed.name}`,
      },
    ],
  };
}

function buildProfileContactPoints(
  seed: LinkedinAimfoxPersonSeed,
  lastContactedAt: string | null,
  defaultRegion?: string,
): ContactPointSeed[] {
  const points: ContactPointSeed[] = [
    {
      subjectName: seed.name,
      subjectEmail: seed.emails[0],
      subjectSource: "aimfox",
      subjectSourceId: seed.leadId,
      kind: "linkedin",
      value: seed.publicIdentifier,
      displayValue: seed.profileUrl,
      source: "aimfox",
      lastContactedAt,
      makePrimary: true,
    },
  ];
  for (const [index, email] of seed.emails.entries()) {
    points.push({
      subjectName: seed.name,
      subjectEmail: seed.emails[0],
      subjectSource: "aimfox",
      subjectSourceId: seed.leadId,
      kind: "email",
      value: email,
      source: "aimfox",
      makePrimary: index === 0,
    });
  }
  for (const [index, phone] of seed.phones.entries()) {
    points.push({
      subjectName: seed.name,
      subjectEmail: seed.emails[0],
      subjectSource: "aimfox",
      subjectSourceId: seed.leadId,
      kind: "phone",
      value: phone.number,
      label: phone.type ?? null,
      source: "aimfox",
      makePrimary: index === 0,
      phoneCountry: normalizePhoneCountryCode(phone.country ?? defaultRegion) ?? null,
    });
  }
  return points;
}

function renderLinkedinProfile(seed: LinkedinAimfoxPersonSeed): string {
  return JSON.stringify(
    {
      name: seed.name,
      linkedinProfileUrl: seed.profileUrl,
      title: seed.title,
      company: seed.currentCompanyName,
      companyLinkedinUrl: seed.currentCompanyLinkedinUrl,
      location: seed.location,
      headline: seed.headline,
      emails: seed.emails,
      phones: seed.phones,
    },
    null,
    2,
  );
}

/**
 * Automated campaign messages remain part of the durable conversation record
 * and are labeled explicitly so retrieval can distinguish them from manual outreach.
 */
function renderConversationSegment(accountId: string, messages: OrderedMessage[]): string {
  return messages
    .map(({ identity, message, timestamp }) => {
      const direction = message.sender.id === accountId ? "outbound" : "inbound";
      const body = message.deleted ? "[Deleted message]" : (message.body ?? "").trim();
      return [
        `Message: ${identity}`,
        `Direction: ${direction}`,
        `At: ${timestamp ?? "unknown time"}`,
        `Sender: ${displaySenderName(message.sender)}`,
        `Automated: ${message.automated === true ? "yes" : "no"}`,
        `Edited: ${message.edited === true ? "yes" : "no"}`,
        "",
        body,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

export function orderLinkedinMessages(conversationUrn: string, messages: AimfoxMessage[]): OrderedMessage[] {
  const byIdentity = new Map<string, OrderedMessage>();
  for (const message of messages) {
    if (!message.deleted && !(message.body ?? "").trim()) continue;
    const identity = aimfoxMessageIdentity(conversationUrn, message);
    byIdentity.set(identity, { identity, timestamp: aimfoxTimestampToIso(message.created_at), message });
  }
  return [...byIdentity.values()].sort((left, right) => {
    const byTimestamp = (left.timestamp ?? "").localeCompare(right.timestamp ?? "");
    return byTimestamp || left.identity.localeCompare(right.identity);
  });
}

function estimateMessageTokens(message: AimfoxMessage): number {
  return Math.max(1, Math.ceil(((message.body?.length ?? 0) + message.sender.full_name.length + 80) / 4));
}

function aimfoxMessageIdentity(conversationUrn: string, message: AimfoxMessage): string {
  const stableId = message.urn ?? message.id ?? message.message_id;
  if (stableId?.trim()) return stableId.trim();
  return sha256(`${conversationUrn}|${message.created_at}|${message.sender.id}|${message.body ?? ""}`);
}

function displaySenderName(sender: AimfoxMessage["sender"]): string {
  const name = sender.full_name?.trim();
  if (name) return name;
  if (!sender.id || sender.id.startsWith("urn:")) return "Unknown sender";
  return sender.id;
}

function linkedinProfileProviderFileId(accountId: string, leadId: string): string {
  return `linkedin:${accountId}:profile:${leadId}`;
}

function linkedinSegmentProviderFileId(accountId: string, conversationUrn: string, segmentIndex: number): string {
  return `linkedin:${accountId}:${conversationUrn}:segment-${segmentIndex}`;
}

function checkpointMeta(accountId: string, conversationUrn: string) {
  return { accountId, conversationUrn };
}

function readCheckpoint(sourceMeta: Record<string, unknown> | undefined): {
  accountId: string;
  conversationUrn: string;
} | null {
  const value = sourceMeta?.linkedinAimfox;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const accountId = (value as Record<string, unknown>).accountId;
  const conversationUrn = (value as Record<string, unknown>).conversationUrn;
  return typeof accountId === "string" && typeof conversationUrn === "string" ? { accountId, conversationUrn } : null;
}

function readSegmentManifest(sourceMeta: Record<string, unknown> | null): LinkedinAimfoxSegmentManifest | null {
  const root = sourceMeta?.linkedinAimfox;
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  const raw = (root as Record<string, unknown>).segmentManifest;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.segmentIndex !== "number" ||
    typeof value.terminalMessageId !== "string" ||
    typeof value.messageCount !== "number" ||
    typeof value.algorithmVersion !== "number" ||
    typeof value.sealed !== "boolean"
  ) {
    return null;
  }
  return value as unknown as LinkedinAimfoxSegmentManifest;
}

function parseScopeConfig(value: Record<string, unknown>): ParsedLinkedinAimfoxScopeConfig {
  const accountIds = Array.isArray(value.accountIds)
    ? value.accountIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (accountIds.length === 0) throw new LinkedinAimfoxNoAccountsError();
  return {
    accountIds: [...new Set(accountIds)].sort(),
    maxConversations: positiveInteger(value.maxConversations, DEFAULT_CONVERSATION_COUNT),
    maxInflight: positiveInteger(value.maxInflight, DEFAULT_MAX_INFLIGHT),
    segmentMaxMessages: positiveInteger(value.segmentMaxMessages, DEFAULT_SEGMENT_MAX_MESSAGES),
    segmentMaxTokens: positiveInteger(value.segmentMaxTokens, DEFAULT_SEGMENT_MAX_TOKENS),
    contactPointDefaultRegion:
      typeof value.contactPointDefaultRegion === "string" ? value.contactPointDefaultRegion : undefined,
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseLinkedinAimfoxCursor(value: string | null): LinkedinAimfoxCursor {
  if (!value) return emptyLinkedinAimfoxCursor();
  try {
    const parsed = JSON.parse(value) as Partial<LinkedinAimfoxCursor>;
    if (parsed.version !== LINKEDIN_AIMFOX_CURSOR_VERSION || !parsed.accounts || typeof parsed.accounts !== "object") {
      return emptyLinkedinAimfoxCursor();
    }
    const accounts: Record<string, LinkedinAimfoxCursorAccountState> = {};
    for (const [accountId, state] of Object.entries(parsed.accounts)) {
      accounts[accountId] = {
        highWatermark:
          state && typeof state === "object" && typeof state.highWatermark === "string" ? state.highWatermark : null,
      };
    }
    return { version: LINKEDIN_AIMFOX_CURSOR_VERSION, accounts };
  } catch {
    return emptyLinkedinAimfoxCursor();
  }
}

function emptyLinkedinAimfoxCursor(): LinkedinAimfoxCursor {
  return { version: LINKEDIN_AIMFOX_CURSOR_VERSION, accounts: {} };
}

function cloneLinkedinAimfoxCursor(cursor: LinkedinAimfoxCursor): LinkedinAimfoxCursor {
  return {
    version: LINKEDIN_AIMFOX_CURSOR_VERSION,
    accounts: Object.fromEntries(
      Object.entries(cursor.accounts).map(([accountId, state]) => [accountId, { ...state }]),
    ),
  };
}

function persistedHighWatermark(state: AccountRunState): string | null {
  const completeActivities: string[] = [];
  const incompleteActivities: Array<string | null> = [];
  for (const conversation of state.conversations.values()) {
    if (!conversation.failed && conversation.persistedItems === conversation.expectedItems) {
      if (conversation.activity) completeActivities.push(conversation.activity);
    } else {
      incompleteActivities.push(conversation.activity);
    }
  }
  if (incompleteActivities.some((activity) => activity === null)) return state.existingHighWatermark;
  const globalWatermark = [
    ...completeActivities,
    ...incompleteActivities.filter((value): value is string => Boolean(value)),
  ]
    .sort()
    .at(-1);
  if (!globalWatermark) return state.existingHighWatermark;
  const oldestIncomplete = incompleteActivities
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(0);
  const bounded = oldestIncomplete && oldestIncomplete < globalWatermark ? oldestIncomplete : globalWatermark;
  return !state.existingHighWatermark || bounded > state.existingHighWatermark ? bounded : state.existingHighWatermark;
}

function conversationChangedSince(conversation: AimfoxConversationListItem, highWatermark: string): boolean {
  const activity = conversationLastContactedAt(conversation);
  return Boolean(activity && activity >= highWatermark);
}

function conversationCounterpart(conversation: AimfoxConversationListItem) {
  return conversation.participants.find((participant) => participant.id);
}

function conversationLastContactedAt(conversation: AimfoxConversationListItem): string | null {
  return aimfoxTimestampToIso(conversation.last_activity_at ?? conversation.last_message?.created_at ?? null);
}

function aimfoxTimestampToIso(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
