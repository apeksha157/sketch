import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { readLinkedinAimfoxManifest } from "../db/repositories/connectors";
import { normalizePhoneCountryCode } from "../identity-normalization";
import { maxIso } from "../timestamps";
import {
  AimfoxClient,
  type AimfoxConversation,
  type AimfoxConversationListItem,
  type AimfoxLead,
  type AimfoxMessage,
} from "./aimfox-client";
import {
  type LinkedinEnrichmentScope,
  type LinkedinVisibilityMode,
  normalizeLinkedinEnrichmentScopeConfig,
  parseLinkedinVisibilityScopeConfig,
} from "./enrichment/scope";
import { type LinkedinAimfoxPersonSeed, buildPersonSeed } from "./linkedin-aimfox-mappers";
import { extractErrorMessage, runWithConcurrency, truncateErrorMessage } from "./sync-utils";
import { renderTranscriptLine } from "./transcript";
import type { ApiKeyCredentials, Connector, ConnectorCredentials, ContactPointSeed, SyncedItem } from "./types";
import { toEmailPrincipals } from "./types";

const DEFAULT_MAX_INFLIGHT = 3;
const DEFAULT_SEGMENT_MAX_MESSAGES = 50;
const DEFAULT_SEGMENT_MAX_TOKENS = 4_000;
/**
 * A LinkedIn exchange is a burst of replies minutes to an hour apart; a
 * message sent after a meeting lands hours later. Four hours separates the
 * two so each exchange becomes its own dated row on the entity timeline,
 * interleaving correctly with calendar and meeting files.
 */
const DEFAULT_SEGMENT_GAP_HOURS = 4;
const SEGMENT_ALGORITHM_VERSION = 2;
const LINKEDIN_AIMFOX_CURSOR_VERSION = 2;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_BACKFILL_BUDGET = 100;
const DEFAULT_MAX_RPM = 60;
const MAX_INCREMENTAL_PAGES = 10;
const STALL_LIMIT = 3;
/**
 * Aimfox mirrors the LinkedIn inbox with some ingestion lag, so a message can
 * surface after our listing with a `last_activity_at` below a watermark we
 * just advanced. The watermark therefore never moves past `runAnchor − 6 h`;
 * the newest six hours of threads are re-listed every sync (two calls each,
 * hash-identical content, no re-index).
 */
const INCREMENTAL_OVERLAP_MS = 6 * HOUR_MS;

export interface LinkedinAimfoxScopeConfig extends Record<string, unknown> {
  accountIds: string[];
  backfillBudget?: number;
  backfillSince?: string;
  maxInflight?: number;
  maxRpm?: number;
  segmentMaxMessages?: number;
  segmentMaxTokens?: number;
  segmentGapHours?: number;
  contactPointDefaultRegion?: string;
  visibility?: LinkedinVisibilityMode;
  enrichment?: LinkedinEnrichmentScope;
}

/**
 * Two cursors per account. `highWatermark` walks forward and gates the
 * incremental pass (threads with activity at or after it). `backfillBefore`
 * walks backward through the inbox one budgeted page per sync until a page
 * comes back short (`backfillDone`). `backfillStalls` counts consecutive runs
 * where a failing thread held `backfillBefore` in place, so one dead thread
 * cannot starve the descent forever.
 */
interface LinkedinAimfoxCursorAccountState {
  highWatermark: string | null;
  watermarkStalls: number;
  backfillBefore: string | null;
  backfillDone: boolean;
  backfillStalls: number;
  directionVersion: number;
}

interface LinkedinAimfoxCursor {
  version: 2;
  accounts: Record<string, LinkedinAimfoxCursorAccountState>;
}

export interface LinkedinAimfoxSegmentManifest {
  segmentIndex: number;
  terminalMessageId: string;
  messageCount: number;
  algorithmVersion: number;
  sealed: boolean;
  inboundCount?: number;
  outboundCount?: number;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
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
  existing: LinkedinAimfoxCursorAccountState;
  ownerName: string;
  runAnchorMs: number;
  incremental: Map<string, ConversationCompletion>;
  backfill: Map<string, ConversationCompletion>;
  backfillAttempted: boolean;
  backfillPageShort: boolean;
  accountsWalked: number;
  threadsListed: number;
  threadsEmitted: number;
  threadsSkippedNoReply: number;
  threadsSkippedNoSeed: number;
  leadDetailFailures: number;
  buildFailures: number;
  pageCapHit: boolean;
}

export interface LinkedinAimfoxMeta {
  linkedinAimfox?: {
    accountId?: unknown;
    conversationUrn?: unknown;
    kind?: string;
    segmentManifest?: LinkedinAimfoxRawSegmentManifest;
  };
}

interface LinkedinAimfoxRawSegmentManifest {
  segmentIndex?: unknown;
  terminalMessageId?: unknown;
  messageCount?: unknown;
  algorithmVersion?: unknown;
  sealed?: unknown;
  inboundCount?: unknown;
  outboundCount?: unknown;
  lastInboundAt?: unknown;
  lastOutboundAt?: unknown;
}

interface ParsedLinkedinAimfoxScopeConfig {
  accountIds: string[];
  backfillBudget: number;
  backfillSinceMs: number | null;
  maxInflight: number;
  maxRpm: number;
  segmentMaxMessages: number;
  segmentMaxTokens: number;
  segmentGapMs: number;
  contactPointDefaultRegion?: string;
  visibility: LinkedinVisibilityMode;
}

interface IngestContext {
  client: AimfoxClient;
  accountId: string;
  state: AccountRunState;
  scopeConfig: ParsedLinkedinAimfoxScopeConfig;
  ownerEmail: string;
  logger: Logger;
  getExistingItemState?: (providerFileId: string) => {
    sourceMeta: Record<string, unknown> | null;
    threadId: string | null;
  } | null;
}

export interface LinkedinSegmentLimits {
  maxMessages: number;
  maxTokens: number;
  gapMs: number;
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

  return normalizeLinkedinEnrichmentScopeConfig({ ...requestedScopeConfig, accountIds }) as LinkedinAimfoxScopeConfig;
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

    /**
     * Two passes per account, sharing one ingest path and never touching the
     * same thread twice in a run. The incremental pass lists newest-first
     * down to the high watermark; the backfill pass takes one budgeted page
     * below `backfillBefore`. Both are anchored to a single `runAnchorMs`
     * so the cursor rules in `nextAccountCursor` reason about one snapshot.
     */
    async *sync(opts) {
      const { api_key } = requireApiKeyCredentials(opts.credentials);
      if (!opts.ownerEmail) throw new Error("LinkedIn Aimfox sync requires a connector owner email");
      const scopeConfig = parseScopeConfig(opts.scopeConfig);
      currentCursor = parseLinkedinAimfoxCursor(opts.cursor);
      runState = new Map();
      const runAnchorMs = Date.now();
      const ownerNames = await loadOwnerNames(api_key, scopeConfig.maxRpm, opts.logger);

      for (const accountId of scopeConfig.accountIds) {
        const existing = currentCursor.accounts[accountId] ?? emptyAccountCursor();
        const state: AccountRunState = {
          existing,
          ownerName: ownerNames.get(accountId) ?? `LinkedIn account ${accountId}`,
          runAnchorMs,
          incremental: new Map(),
          backfill: new Map(),
          backfillAttempted: false,
          backfillPageShort: false,
          accountsWalked: 1,
          threadsListed: 0,
          threadsEmitted: 0,
          threadsSkippedNoReply: 0,
          threadsSkippedNoSeed: 0,
          leadDetailFailures: 0,
          buildFailures: 0,
          pageCapHit: false,
        };
        runState.set(accountId, state);
        const client = new AimfoxClient(api_key, { accountId, maxRpm: scopeConfig.maxRpm });
        const context: IngestContext = {
          client,
          accountId,
          state,
          scopeConfig,
          ownerEmail: opts.ownerEmail,
          logger: opts.logger,
          getExistingItemState: opts.getExistingItemState,
        };
        const handled = new Set<string>();
        const refreshDirection = existing.directionVersion < 1;

        if (existing.highWatermark && !refreshDirection) {
          const changedResult = await listChangedConversations(
            client,
            existing.highWatermark,
            runAnchorMs,
            opts.logger,
          );
          const changed = changedResult.conversations;
          state.threadsListed += changedResult.threadsListed;
          state.pageCapHit ||= changedResult.pageCapHit;
          for (const conversation of changed) handled.add(conversation.conversation_urn);
          yield* ingestConversations(context, changed, state.incremental);
        }

        if (!existing.backfillDone || refreshDirection) {
          const before = refreshDirection
            ? runAnchorMs
            : existing.backfillBefore
              ? Date.parse(existing.backfillBefore)
              : runAnchorMs;
          const page = await listBackfillPage(client, {
            before,
            budget: refreshDirection ? Number.MAX_SAFE_INTEGER : scopeConfig.backfillBudget,
            sinceMs: refreshDirection ? null : scopeConfig.backfillSinceMs,
          });
          state.backfillAttempted = true;
          state.backfillPageShort = page.short;
          state.threadsListed += page.threadsListed;
          const fresh = page.conversations.filter((conversation) => !handled.has(conversation.conversation_urn));
          yield* ingestConversations(context, fresh, state.backfill);
        }
      }
    },

    onItemResult({ item, persisted }) {
      const checkpoint = readCheckpoint(item.sourceMeta);
      if (!checkpoint) return;
      const account = runState.get(checkpoint.accountId);
      const conversation =
        account?.incremental.get(checkpoint.conversationUrn) ?? account?.backfill.get(checkpoint.conversationUrn);
      if (!conversation) return;
      if (persisted) conversation.persistedItems++;
      else conversation.failed = true;
    },

    async getCursor({ currentCursor: storedCursor, logger }) {
      const next = cloneLinkedinAimfoxCursor(parseLinkedinAimfoxCursor(storedCursor));
      for (const [accountId, state] of runState) {
        next.accounts[accountId] = nextAccountCursor(state, accountId, logger);
      }
      return JSON.stringify(next);
    },

    getSyncDiagnostics() {
      return linkedinSyncDiagnostics(runState);
    },
  };
}

type ConversationLeadResult =
  | { leadId: string; conversation: AimfoxConversationListItem; lead: AimfoxLead; error: null }
  | { leadId: string; conversation: AimfoxConversationListItem; error: string };

/**
 * Newest-first pages from the run anchor down to the watermark. Stops on a
 * short page, on the first page whose oldest thread predates the watermark,
 * or at a page cap that no real inbox reaches between two syncs.
 */
async function listChangedConversations(
  client: AimfoxClient,
  highWatermark: string,
  runAnchorMs: number,
  logger: Logger,
): Promise<{ conversations: AimfoxConversationListItem[]; threadsListed: number; pageCapHit: boolean }> {
  const changed: AimfoxConversationListItem[] = [];
  const seen = new Set<string>();
  let before = runAnchorMs;
  let threadsListed = 0;
  let pageCapHit = false;
  for (let pageIndex = 0; pageIndex < MAX_INCREMENTAL_PAGES; pageIndex++) {
    const page = await client.listConversationsPage({ before, count: 100 });
    threadsListed += page.length;
    for (const conversation of page) {
      if (seen.has(conversation.conversation_urn)) continue;
      seen.add(conversation.conversation_urn);
      if (conversationChangedSince(conversation, highWatermark)) changed.push(conversation);
    }
    const oldest = oldestActivityMs(page);
    if (page.length < 100 || oldest === null || oldest >= before) break;
    if (new Date(oldest).toISOString() < highWatermark) break;
    before = oldest;
    if (pageIndex === MAX_INCREMENTAL_PAGES - 1) {
      pageCapHit = true;
      logger.warn({ pages: MAX_INCREMENTAL_PAGES }, "LinkedIn incremental listing hit the page cap");
    }
  }
  return { conversations: changed, threadsListed, pageCapHit };
}

/**
 * One backfill batch: up to `budget` threads strictly older than `before`,
 * fetched in pages of 100. `short` means the inbox ran out (or the age floor
 * was reached), which is what lets the cursor declare the backfill done.
 */
async function listBackfillPage(
  client: AimfoxClient,
  input: { before: number; budget: number; sinceMs: number | null },
): Promise<{ conversations: AimfoxConversationListItem[]; short: boolean; threadsListed: number }> {
  const conversations: AimfoxConversationListItem[] = [];
  const seen = new Set<string>();
  let before = input.before;
  let short = false;
  let threadsListed = 0;
  while (conversations.length < input.budget) {
    const count = Math.min(100, input.budget - conversations.length);
    const page = await client.listConversationsPage({ before, count });
    threadsListed += page.length;
    for (const conversation of page) {
      if (seen.has(conversation.conversation_urn)) continue;
      seen.add(conversation.conversation_urn);
      const activity = activityMs(conversation);
      if (input.sinceMs !== null && activity !== null && activity < input.sinceMs) {
        short = true;
        continue;
      }
      conversations.push(conversation);
    }
    const oldest = oldestActivityMs(page);
    if (page.length < count || oldest === null || oldest >= before) {
      short = true;
      break;
    }
    if (short) break;
    before = oldest;
  }
  return { conversations, short, threadsListed };
}

async function resolveConversationLeads(
  client: AimfoxClient,
  conversations: AimfoxConversationListItem[],
  maxInflight: number,
): Promise<ConversationLeadResult[]> {
  const details: ConversationLeadResult[] = [];
  await runWithConcurrency(conversations, maxInflight, async (conversation) => {
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
  return details;
}

async function* ingestConversations(
  context: IngestContext,
  conversations: AimfoxConversationListItem[],
  completions: Map<string, ConversationCompletion>,
): AsyncGenerator<SyncedItem> {
  const { client, accountId, state, scopeConfig, logger } = context;
  const results = await resolveConversationLeads(client, conversations, scopeConfig.maxInflight);
  for (const result of results) {
    const conversationUrn = result.conversation.conversation_urn;
    const activity = conversationLastContactedAt(result.conversation);

    if (!("lead" in result)) {
      completions.set(conversationUrn, { activity, expectedItems: 0, persistedItems: 0, failed: true });
      state.leadDetailFailures++;
      logger.warn(
        { leadId: result.leadId, conversationUrn, err: result.error },
        "Failed to fetch LinkedIn Aimfox lead detail",
      );
      continue;
    }

    const seed = buildPersonSeed(result.lead);
    if (!seed) {
      completions.set(conversationUrn, { activity, expectedItems: 0, persistedItems: 0, failed: false });
      state.threadsSkippedNoSeed++;
      logger.debug({ leadId: result.leadId, conversationUrn }, "LinkedIn thread has no usable lead seed; skipped");
      continue;
    }

    try {
      const items = await buildLinkedinSyncedItems(client, {
        accountId,
        ownerName: state.ownerName,
        conversation: result.conversation,
        ownerEmail: context.ownerEmail,
        seed,
        segmentLimits: {
          maxMessages: scopeConfig.segmentMaxMessages,
          maxTokens: scopeConfig.segmentMaxTokens,
          gapMs: scopeConfig.segmentGapMs,
        },
        contactPointDefaultRegion: scopeConfig.contactPointDefaultRegion,
        getExistingItemState: context.getExistingItemState,
        visibility: scopeConfig.visibility,
      });
      completions.set(conversationUrn, { activity, expectedItems: items.length, persistedItems: 0, failed: false });
      if (items.length === 0) {
        state.threadsSkippedNoReply++;
        logger.debug({ leadId: result.leadId, conversationUrn }, "LinkedIn thread has no reply yet; skipped");
      }
      if (items.length > 0) state.threadsEmitted++;
      for (const item of items) yield item;
    } catch (err) {
      const error = truncateErrorMessage(extractErrorMessage(err));
      completions.set(conversationUrn, { activity, expectedItems: 0, persistedItems: 0, failed: true });
      state.buildFailures++;
      logger.warn({ leadId: result.leadId, conversationUrn, err: error }, "Failed to ingest Aimfox thread");
    }
  }
}

/**
 * The `/accounts` endpoint is workspace-scoped, so one call names every
 * account in the sync. Names only decorate file headers and titles; a failure
 * here must never abort the sync or block cursor persistence, so it degrades
 * to the account id.
 */
async function loadOwnerNames(apiKey: string, maxRpm: number, logger: Logger): Promise<Map<string, string>> {
  try {
    const accounts = await new AimfoxClient(apiKey, { maxRpm }).listAccounts();
    return new Map(
      accounts
        .filter((account) => account.full_name?.trim())
        .map((account) => [String(account.id), account.full_name.trim()]),
    );
  } catch (err) {
    logger.warn(
      { err: truncateErrorMessage(extractErrorMessage(err)) },
      "Failed to load Aimfox account names; falling back to account ids",
    );
    return new Map();
  }
}

/**
 * A thread is indexed only once the lead has written back. Outbound-only
 * threads are campaign blasts nobody engaged with: no profile, no segments,
 * no person seed, no company mint. Returning no items still records the
 * conversation as complete, so the cursor advances past it; when the lead
 * replies later, the activity timestamp moves and the overlap cursor picks
 * the thread up in full.
 */
async function buildLinkedinSyncedItems(
  client: AimfoxClient,
  input: {
    accountId: string;
    ownerName: string;
    conversation: AimfoxConversationListItem;
    ownerEmail: string;
    seed: LinkedinAimfoxPersonSeed;
    segmentLimits: LinkedinSegmentLimits;
    contactPointDefaultRegion?: string;
    visibility: LinkedinVisibilityMode;
    getExistingItemState?: (providerFileId: string) => {
      sourceMeta: Record<string, unknown> | null;
      threadId: string | null;
    } | null;
  },
): Promise<SyncedItem[]> {
  const detail = await client.getConversation(input.conversation.conversation_urn);
  const messages = orderLinkedinMessages(input.conversation.conversation_urn, detail.messages);
  const hasReply = messages.some(({ message }) => message.sender.id !== input.accountId);
  if (!hasReply) return [];
  const profileItem = buildLinkedinProfileSyncedItem({
    ...input,
    engaged: hasReply,
    lastRepliedAt: conversationLastRepliedAt(messages, input.accountId),
  });
  const manifests = loadExistingSealedManifests(input);
  const segments = buildLinkedinSegments(messages, manifests, input.segmentLimits, input.accountId);
  return [
    profileItem,
    ...segments.map((segment) =>
      buildLinkedinConversationSyncedItem({
        accountId: input.accountId,
        ownerName: input.ownerName,
        conversation: input.conversation,
        ownerEmail: input.ownerEmail,
        profileProviderFileId: profileItem.providerFileId,
        seed: input.seed,
        segment,
        visibility: input.visibility,
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

/**
 * Cuts the ordered thread into bursts. A new segment starts when the gap from
 * the last dated message exceeds `gapMs`, or the message/token caps hit.
 * Sealed manifests replay first and their boundaries never move; only the
 * open tail is re-cut. Null-timestamp messages sort last and neither open
 * nor close a gap, so they can only ever join the open tail.
 */
export function buildLinkedinSegments(
  orderedMessages: OrderedMessage[],
  existingSealedManifests: LinkedinAimfoxSegmentManifest[],
  limits: LinkedinSegmentLimits,
  accountId?: string,
): LinkedinAimfoxSegment[] {
  const segments: LinkedinAimfoxSegment[] = [];
  let offset = 0;
  for (const manifest of [...existingSealedManifests].sort((a, b) => a.segmentIndex - b.segmentIndex)) {
    if (manifest.segmentIndex !== segments.length) throw new Error("LinkedIn segment manifest index is not contiguous");
    const terminalIndex = orderedMessages.findIndex(
      (message, index) => index >= offset && message.identity === manifest.terminalMessageId,
    );
    if (terminalIndex < offset) throw new Error("LinkedIn sealed segment terminal message is missing");
    const messages = orderedMessages.slice(offset, terminalIndex + 1);
    segments.push({ manifest: fillSegmentDirection(manifest, messages, accountId), messages });
    offset = terminalIndex + 1;
  }

  while (offset < orderedMessages.length) {
    const segmentIndex = segments.length;
    const messages: OrderedMessage[] = [];
    let tokenCount = 0;
    let lastDatedMs: number | null = null;
    while (offset < orderedMessages.length && messages.length < limits.maxMessages) {
      const message = orderedMessages[offset];
      const nextTokens = estimateMessageTokens(message.message);
      if (messages.length > 0 && tokenCount + nextTokens > limits.maxTokens) break;
      const messageMs = message.timestamp ? Date.parse(message.timestamp) : null;
      if (messages.length > 0 && messageMs !== null && lastDatedMs !== null && messageMs - lastDatedMs > limits.gapMs) {
        break;
      }
      messages.push(message);
      tokenCount += nextTokens;
      if (messageMs !== null) lastDatedMs = messageMs;
      offset++;
      if (tokenCount >= limits.maxTokens) break;
    }
    const terminal = messages.at(-1);
    if (!terminal) throw new Error("LinkedIn segmenter made no progress");
    const sealed =
      messages.length >= limits.maxMessages || tokenCount >= limits.maxTokens || offset < orderedMessages.length;
    const manifest = {
      segmentIndex,
      terminalMessageId: terminal.identity,
      messageCount: messages.length,
      algorithmVersion: SEGMENT_ALGORITHM_VERSION,
      sealed,
    };
    segments.push({ messages, manifest: fillSegmentDirection(manifest, messages, accountId) });
  }
  return segments;
}

function fillSegmentDirection(
  manifest: LinkedinAimfoxSegmentManifest,
  messages: OrderedMessage[],
  accountId: string | undefined,
): LinkedinAimfoxSegmentManifest {
  if (!accountId) return manifest;
  if (
    manifest.inboundCount !== undefined &&
    manifest.outboundCount !== undefined &&
    manifest.lastInboundAt !== undefined &&
    manifest.lastOutboundAt !== undefined
  ) {
    return manifest;
  }
  const direction = segmentDirectionStats(messages, accountId);
  return {
    ...manifest,
    inboundCount: manifest.inboundCount ?? direction.inboundCount,
    outboundCount: manifest.outboundCount ?? direction.outboundCount,
    lastInboundAt: manifest.lastInboundAt ?? direction.lastInboundAt,
    lastOutboundAt: manifest.lastOutboundAt ?? direction.lastOutboundAt,
  };
}

function segmentDirectionStats(messages: OrderedMessage[], accountId: string) {
  let inboundCount = 0;
  let outboundCount = 0;
  let lastInboundAt: string | null = null;
  let lastOutboundAt: string | null = null;
  for (const { message, timestamp } of messages) {
    if (message.sender.id !== accountId) {
      inboundCount++;
      lastInboundAt = maxIso(lastInboundAt, timestamp);
    } else {
      outboundCount++;
      lastOutboundAt = maxIso(lastOutboundAt, timestamp);
    }
  }
  return { inboundCount, outboundCount, lastInboundAt, lastOutboundAt };
}

function buildLinkedinProfileSyncedItem(input: {
  accountId: string;
  conversation: AimfoxConversationListItem;
  ownerEmail: string;
  seed: LinkedinAimfoxPersonSeed;
  engaged: boolean;
  lastRepliedAt?: string | null;
  contactPointDefaultRegion?: string;
  visibility: LinkedinVisibilityMode;
}): SyncedItem {
  const providerFileId = linkedinProfileProviderFileId(input.accountId, input.seed.leadId);
  const contactPoints = buildProfileContactPoints(
    input.seed,
    conversationLastContactedAt(input.conversation),
    input.lastRepliedAt ?? null,
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
    accessPrincipals: linkedinAccessPrincipals(input.visibility, input.ownerEmail),
    personSeeds: [personSeed],
    parentEntities: [
      {
        source: "aimfox",
        sourceId: input.seed.leadId,
        contextSnippet: `LinkedIn profile of ${input.seed.name}`,
      },
    ],
    contactPoints,
  };
}

function buildLinkedinConversationSyncedItem(input: {
  accountId: string;
  ownerName: string;
  conversation: AimfoxConversationListItem;
  ownerEmail: string;
  profileProviderFileId: string;
  seed: LinkedinAimfoxPersonSeed;
  segment: LinkedinAimfoxSegment;
  visibility: LinkedinVisibilityMode;
}): SyncedItem {
  const content = renderConversationSegment({
    ownerName: input.ownerName,
    leadName: input.seed.name,
    messages: input.segment.messages,
  });
  const dated = input.segment.messages.filter((message) => message.timestamp !== null);
  const firstTimestamp = dated[0]?.timestamp ?? null;
  const lastTimestamp = dated.at(-1)?.timestamp ?? null;
  return {
    providerFileId: linkedinSegmentProviderFileId(
      input.accountId,
      input.conversation.conversation_urn,
      input.segment.manifest.segmentIndex,
    ),
    threadId: `${input.accountId}:${input.conversation.conversation_urn}`,
    providerUrl: null,
    fileName: segmentFileName(input.ownerName, input.seed.name, firstTimestamp, lastTimestamp),
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
    accessPrincipals: linkedinAccessPrincipals(input.visibility, input.ownerEmail),
    parentEntities: [
      {
        source: "aimfox",
        sourceId: input.seed.leadId,
        contextSnippet: `LinkedIn conversation with ${input.seed.name}`,
      },
    ],
  };
}

/**
 * Workspace visibility emits an explicit empty grant list so each touched file
 * clears stale owner stamps through syncItemAccess. Legacy and owner mode keep
 * the creator's Sketch email as the only per-file principal.
 */
function linkedinAccessPrincipals(visibility: LinkedinVisibilityMode, ownerEmail: string) {
  return visibility === "workspace" ? [] : toEmailPrincipals([ownerEmail]);
}

function buildProfileContactPoints(
  seed: LinkedinAimfoxPersonSeed,
  lastContactedAt: string | null,
  lastRepliedAt: string | null,
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
      lastRepliedAt,
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
 * WhatsApp-shaped transcript: a one-line header, then one `[time] Name: body`
 * line per message. Message ids, direction and edit flags stay out of the
 * content — segment boundaries live in `sourceMeta`, and the sender name
 * already says who spoke. Automated campaign messages remain in the record
 * and carry an `(automated)` tag so retrieval can tell a blast from a reply.
 */
function renderConversationSegment(input: { ownerName: string; leadName: string; messages: OrderedMessage[] }): string {
  const lines = input.messages.map(({ message, timestamp }) =>
    renderTranscriptLine({
      at: formatTranscriptTime(timestamp),
      name: displaySenderName(message.sender),
      tag: message.automated === true ? "automated" : null,
      text: message.deleted ? "[Deleted message]" : (message.body ?? "").trim(),
    }),
  );
  return `LinkedIn conversation: ${input.ownerName} <> ${input.leadName}\n\nTranscript:\n${lines.join("\n")}`;
}

function formatTranscriptTime(iso: string | null): string {
  if (!iso) return "unknown time";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function segmentFileName(
  ownerName: string,
  leadName: string,
  firstTimestamp: string | null,
  lastTimestamp: string | null,
): string {
  const title = `LinkedIn: ${ownerName} <> ${leadName}`;
  const from = firstTimestamp?.slice(0, 10);
  const to = lastTimestamp?.slice(0, 10);
  if (!from) return title;
  return to && to !== from ? `${title} · ${from} to ${to}` : `${title} · ${from}`;
}

/**
 * Dated messages sort by timestamp, then identity. Messages without a usable
 * timestamp sort after every dated one, so a late-arriving undated message
 * can only ever join the open tail rather than rewrite a sealed segment.
 */
export function orderLinkedinMessages(conversationUrn: string, messages: AimfoxMessage[]): OrderedMessage[] {
  const byIdentity = new Map<string, OrderedMessage>();
  const ordinals = new Map<string, number>();
  for (const message of messages) {
    const ordinalKey = `${message.created_at}|${message.sender.id}`;
    const ordinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, ordinal + 1);
    if (!message.deleted && !(message.body ?? "").trim()) continue;
    const identity = aimfoxMessageIdentity(conversationUrn, message, ordinal);
    byIdentity.set(identity, { identity, timestamp: aimfoxTimestampToIso(message.created_at), message });
  }
  return [...byIdentity.values()].sort((left, right) => {
    if (left.timestamp === null || right.timestamp === null) {
      if (left.timestamp === right.timestamp) return left.identity.localeCompare(right.identity);
      return left.timestamp === null ? 1 : -1;
    }
    return left.timestamp.localeCompare(right.timestamp) || left.identity.localeCompare(right.identity);
  });
}

function estimateMessageTokens(message: AimfoxMessage): number {
  return Math.max(1, Math.ceil(((message.body?.length ?? 0) + message.sender.full_name.length + 80) / 4));
}

/**
 * The fallback identity (no provider id) must survive edits and deletes, or a
 * sealed segment's terminal message could vanish and fail the thread forever.
 * So it hashes only immutable coordinates: the message's position among
 * API-order messages sharing the same sender and timestamp, never the body.
 */
function aimfoxMessageIdentity(conversationUrn: string, message: AimfoxMessage, ordinal: number): string {
  const stableId = message.urn ?? message.id ?? message.message_id;
  if (stableId?.trim()) return stableId.trim();
  return sha256(`${conversationUrn}|${message.created_at}|${message.sender.id}|${ordinal}`);
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
  const value = (sourceMeta as LinkedinAimfoxMeta | undefined)?.linkedinAimfox;
  const accountId = value?.accountId;
  const conversationUrn = value?.conversationUrn;
  return typeof accountId === "string" && typeof conversationUrn === "string" ? { accountId, conversationUrn } : null;
}

function readSegmentManifest(sourceMeta: Record<string, unknown> | null): LinkedinAimfoxSegmentManifest | null {
  const value = readLinkedinAimfoxManifest(sourceMeta) as LinkedinAimfoxRawSegmentManifest | null;
  if (!value) return null;
  if (
    typeof value.segmentIndex !== "number" ||
    typeof value.terminalMessageId !== "string" ||
    typeof value.messageCount !== "number" ||
    typeof value.algorithmVersion !== "number" ||
    typeof value.sealed !== "boolean"
  ) {
    return null;
  }
  return {
    segmentIndex: value.segmentIndex,
    terminalMessageId: value.terminalMessageId,
    messageCount: value.messageCount,
    algorithmVersion: value.algorithmVersion,
    sealed: value.sealed,
    inboundCount: typeof value.inboundCount === "number" ? value.inboundCount : undefined,
    outboundCount: typeof value.outboundCount === "number" ? value.outboundCount : undefined,
    lastInboundAt:
      typeof value.lastInboundAt === "string" || value.lastInboundAt === null ? value.lastInboundAt : undefined,
    lastOutboundAt:
      typeof value.lastOutboundAt === "string" || value.lastOutboundAt === null ? value.lastOutboundAt : undefined,
  };
}

function parseScopeConfig(value: Record<string, unknown>): ParsedLinkedinAimfoxScopeConfig {
  const accountIds = Array.isArray(value.accountIds)
    ? value.accountIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (accountIds.length === 0) throw new LinkedinAimfoxNoAccountsError();
  return {
    accountIds: [...new Set(accountIds)].sort(),
    backfillBudget: positiveInteger(value.backfillBudget, DEFAULT_BACKFILL_BUDGET),
    backfillSinceMs: isoToMs(value.backfillSince),
    maxInflight: positiveInteger(value.maxInflight, DEFAULT_MAX_INFLIGHT),
    maxRpm: positiveInteger(value.maxRpm, DEFAULT_MAX_RPM),
    segmentMaxMessages: positiveInteger(value.segmentMaxMessages, DEFAULT_SEGMENT_MAX_MESSAGES),
    segmentMaxTokens: positiveInteger(value.segmentMaxTokens, DEFAULT_SEGMENT_MAX_TOKENS),
    segmentGapMs: positiveInteger(value.segmentGapHours, DEFAULT_SEGMENT_GAP_HOURS) * HOUR_MS,
    contactPointDefaultRegion:
      typeof value.contactPointDefaultRegion === "string" ? value.contactPointDefaultRegion : undefined,
    visibility: parseLinkedinVisibilityScopeConfig(value),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isoToMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function activityMs(conversation: AimfoxConversationListItem): number | null {
  const iso = conversationLastContactedAt(conversation);
  return iso ? Date.parse(iso) : null;
}

function oldestActivityMs(page: AimfoxConversationListItem[]): number | null {
  let oldest: number | null = null;
  for (const conversation of page) {
    const ms = activityMs(conversation);
    if (ms !== null && (oldest === null || ms < oldest)) oldest = ms;
  }
  return oldest;
}

/**
 * Cursor upgrades reset the account: a v1 cursor knew only a watermark and
 * had never walked the inbox, so the only correct v2 state is "start over".
 */
function parseLinkedinAimfoxCursor(value: string | null): LinkedinAimfoxCursor {
  if (!value) return emptyLinkedinAimfoxCursor();
  try {
    const parsed = JSON.parse(value) as Partial<LinkedinAimfoxCursor>;
    if (parsed.version !== LINKEDIN_AIMFOX_CURSOR_VERSION || !parsed.accounts || typeof parsed.accounts !== "object") {
      return emptyLinkedinAimfoxCursor();
    }
    const accounts: Record<string, LinkedinAimfoxCursorAccountState> = {};
    for (const [accountId, raw] of Object.entries(parsed.accounts)) {
      const state = raw && typeof raw === "object" ? (raw as Partial<LinkedinAimfoxCursorAccountState>) : {};
      accounts[accountId] = {
        highWatermark: typeof state.highWatermark === "string" ? state.highWatermark : null,
        watermarkStalls: typeof state.watermarkStalls === "number" ? state.watermarkStalls : 0,
        backfillBefore: typeof state.backfillBefore === "string" ? state.backfillBefore : null,
        backfillDone: state.backfillDone === true,
        backfillStalls: typeof state.backfillStalls === "number" ? state.backfillStalls : 0,
        directionVersion: typeof state.directionVersion === "number" ? state.directionVersion : 0,
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

function emptyAccountCursor(): LinkedinAimfoxCursorAccountState {
  return {
    highWatermark: null,
    watermarkStalls: 0,
    backfillBefore: null,
    backfillDone: false,
    backfillStalls: 0,
    directionVersion: 1,
  };
}

function cloneLinkedinAimfoxCursor(cursor: LinkedinAimfoxCursor): LinkedinAimfoxCursor {
  return {
    version: LINKEDIN_AIMFOX_CURSOR_VERSION,
    accounts: Object.fromEntries(
      Object.entries(cursor.accounts).map(([accountId, state]) => [accountId, { ...state }]),
    ),
  };
}

function linkedinSyncDiagnostics(runState: Map<string, AccountRunState>) {
  const totals = {
    accountsWalked: 0,
    threadsListed: 0,
    threadsEmitted: 0,
    threadsSkippedNoReply: 0,
    threadsSkippedNoSeed: 0,
    leadDetailFailures: 0,
    buildFailures: 0,
    pageCapHit: false,
  };
  for (const state of runState.values()) {
    totals.accountsWalked += state.accountsWalked;
    totals.threadsListed += state.threadsListed;
    totals.threadsEmitted += state.threadsEmitted;
    totals.threadsSkippedNoReply += state.threadsSkippedNoReply;
    totals.threadsSkippedNoSeed += state.threadsSkippedNoSeed;
    totals.leadDetailFailures += state.leadDetailFailures;
    totals.buildFailures += state.buildFailures;
    totals.pageCapHit ||= state.pageCapHit;
  }
  return totals;
}

function isComplete(conversation: ConversationCompletion): boolean {
  return !conversation.failed && conversation.persistedItems === conversation.expectedItems;
}

/**
 * Forward cursor. Advances to the newest activity seen, but never past the
 * oldest thread that did not fully persist, so a failure is re-fetched next
 * run; `>=` on the read side makes the boundary thread itself overlap.
 */
function persistedHighWatermark(
  existingHighWatermark: string | null,
  conversations: Map<string, ConversationCompletion>,
): string | null {
  const completeActivities: string[] = [];
  const incompleteActivities: Array<string | null> = [];
  for (const conversation of conversations.values()) {
    if (isComplete(conversation)) {
      if (conversation.activity) completeActivities.push(conversation.activity);
    } else {
      incompleteActivities.push(conversation.activity);
    }
  }
  if (incompleteActivities.some((activity) => activity === null)) return existingHighWatermark;
  const globalWatermark = [
    ...completeActivities,
    ...incompleteActivities.filter((value): value is string => Boolean(value)),
  ]
    .sort()
    .at(-1);
  if (!globalWatermark) return existingHighWatermark;
  const oldestIncomplete = incompleteActivities
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(0);
  const bounded = oldestIncomplete && oldestIncomplete < globalWatermark ? oldestIncomplete : globalWatermark;
  return !existingHighWatermark || bounded > existingHighWatermark ? bounded : existingHighWatermark;
}

function datedActivities(entries: Array<[string, ConversationCompletion]>): string[] {
  return entries
    .map(([, conversation]) => conversation.activity)
    .filter((value): value is string => Boolean(value))
    .sort();
}

/**
 * Combines both passes into the next cursor.
 *
 * Watermark: from the incremental pass alone, by the hold-at-oldest-incomplete
 * rule, capped at `runAnchor − INCREMENTAL_OVERLAP_MS`. With no watermark yet
 * it is seeded from the newest *complete* thread of the first backfill page
 * — backfill failures belong to the backfill cursor, not here, or one dead
 * thread at the top would force every newer thread to be re-fetched each run.
 *
 * Backfill: descends to the page minimum when every thread persisted, holds
 * just above the newest incomplete thread otherwise.
 *
 * Both cursors carry a stall counter: after `STALL_LIMIT` consecutive runs
 * held in place by the same failures, they give up on those threads and
 * move, with a warning naming the urns.
 */
function nextAccountCursor(
  state: AccountRunState,
  accountId: string,
  logger: Logger,
): LinkedinAimfoxCursorAccountState {
  const { existing } = state;
  const watermarkEntries = [...(existing.highWatermark ? state.incremental : state.backfill).entries()];
  const newestComplete = datedActivities(watermarkEntries.filter(([, c]) => isComplete(c))).at(-1) ?? null;
  const held = persistedHighWatermark(existing.highWatermark, new Map(watermarkEntries));
  let candidate = existing.highWatermark ? held : newestComplete;
  let watermarkStalls = 0;
  if (existing.highWatermark && held === existing.highWatermark && newestComplete && newestComplete > held) {
    watermarkStalls = existing.watermarkStalls + 1;
    if (watermarkStalls >= STALL_LIMIT) {
      logger.warn(
        {
          accountId,
          conversationUrns: watermarkEntries.filter(([, c]) => !isComplete(c)).map(([urn]) => urn),
          stalls: watermarkStalls,
        },
        "LinkedIn incremental cursor giving up on threads that failed repeatedly",
      );
      candidate = newestComplete;
      watermarkStalls = 0;
    }
  }
  const bound = new Date(state.runAnchorMs - INCREMENTAL_OVERLAP_MS).toISOString();
  const capped = candidate && candidate > bound ? bound : candidate;
  const highWatermark =
    capped && (!existing.highWatermark || capped > existing.highWatermark) ? capped : existing.highWatermark;

  if (existing.backfillDone || !state.backfillAttempted) {
    return { ...existing, highWatermark, watermarkStalls, directionVersion: 1 };
  }

  const entries = [...state.backfill.entries()];
  const incomplete = entries.filter(([, conversation]) => !isComplete(conversation));
  const pageMin = datedActivities(entries).at(0) ?? null;
  const newestIncomplete = datedActivities(incomplete).at(-1) ?? null;

  let backfillBefore = existing.backfillBefore;
  let backfillDone = false;
  let backfillStalls = 0;
  if (newestIncomplete) {
    backfillBefore = new Date(Date.parse(newestIncomplete) + 1).toISOString();
    if (backfillBefore === existing.backfillBefore) {
      backfillStalls = existing.backfillStalls + 1;
      if (backfillStalls >= STALL_LIMIT) {
        logger.warn(
          { accountId, conversationUrns: incomplete.map(([urn]) => urn), stalls: backfillStalls },
          "LinkedIn backfill giving up on threads that failed repeatedly",
        );
        backfillBefore = pageMin ?? backfillBefore;
        backfillDone = state.backfillPageShort;
        backfillStalls = 0;
      }
    }
  } else {
    backfillBefore = pageMin ?? existing.backfillBefore;
    backfillDone = state.backfillPageShort;
  }
  return { highWatermark, watermarkStalls, backfillBefore, backfillDone, backfillStalls, directionVersion: 1 };
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

function conversationLastRepliedAt(messages: OrderedMessage[], accountId: string): string | null {
  let lastRepliedAt: string | null = null;
  for (const { message, timestamp } of messages) {
    if (message.sender.id !== accountId) lastRepliedAt = maxIso(lastRepliedAt, timestamp);
  }
  return lastRepliedAt;
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
