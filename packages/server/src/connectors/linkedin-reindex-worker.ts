import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Config } from "../config";
import { createConnectorRepository } from "../db/repositories/connectors";
import {
  type LinkedinReindexEnqueueRow,
  type LinkedinReindexRow,
  createLinkedinReindexRepository,
  linkedinReindexConversationKey,
} from "../db/repositories/linkedin-reindex";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";
import { AimfoxClient, AimfoxError, type AimfoxMessage } from "./aimfox-client";
import { resolveLinkedinChunkEngineEnabled } from "./enrichment/scope";
import { linkedinProfileProviderFileId } from "./linkedin-aimfox";
import { buildPersonSeed } from "./linkedin-aimfox-mappers";
import { LINKEDIN_CONVERSATION_FILE_TYPE } from "./linkedin-emission";
import {
  LEGACY_LINKEDIN_SEGMENT_PROVIDER_FILE_ID_PATTERN,
  ingestLinkedinConversation,
  parseLinkedinProviderConversationId,
} from "./linkedin-ingest";
import { extractErrorMessage, truncateErrorMessage } from "./sync-utils";

export const LINKEDIN_REINDEX_TICK_MS = 5_000;
export const LINKEDIN_REINDEX_BATCH = 25;
export const LINKEDIN_REINDEX_RETRY_BASE_MS = 30_000;
const DEFAULT_MAX_RPM = 60;
/** One tenant's whole inbox, well past the 2.6k legacy rows the largest live account holds. */
const ENQUEUE_SCAN_LIMIT = 20_000;

/**
 * Aimfox no longer serves the thread; retrying cannot help, and the legacy files must stay.
 *
 * 403 is deliberately absent: a WAF challenge, a lapsed plan or a briefly
 * revoked key answers 403 on every call, so treating it as terminal would fail
 * a whole tenant's queue over a window that heals on its own.
 */
const TERMINAL_AIMFOX_STATUSES = new Set([404, 410]);

export type LinkedinSyncRequestOutcome = "started" | "busy" | "unavailable";

export interface LinkedinReindexConnector {
  id: string;
  scopeConfig: Record<string, unknown>;
}

export interface LinkedinReindexWorkerOptions {
  db: Kysely<DB>;
  logger: Logger;
  appConfig?: Partial<Pick<Config, "LINKEDIN_CHUNK_ENGINE_ENABLED" | "LINKEDIN_CHUNK_REINDEX_HISTORY_ON_STARTUP">>;
  /** Every enabled LinkedIn connector, with the scope config the engine switch lives in. */
  listConnectors: () => Promise<LinkedinReindexConnector[]>;
  /** The workspace Aimfox key for one connector, or null when it cannot be resolved. */
  resolveApiKey: (connectorConfigId: string) => Promise<string | null>;
  /** Drives the sync that cuts and publishes what this worker ingested. */
  requestSync?: (connectorConfigId: string) => Promise<LinkedinSyncRequestOutcome>;
  now?: () => number;
  tickMs?: number;
  batchSize?: number;
}

export interface LinkedinReindexEnqueueResult {
  conversationsQueued: number;
  conversationsSkipped: number;
}

export interface LinkedinReindexQueueResult extends LinkedinReindexEnqueueResult {
  /** Rows that had spent their retry budget and this press put back on the ladder. */
  conversationsRearmed: number;
}

/**
 * The conversations still cut by the pre-engine segmenter, and the lead each
 * one belongs to.
 *
 * A legacy segment file carries the conversation in `thread_id` and its
 * profile file's id in `rollup_group_id`, so one scan of `indexed_files` names
 * every candidate and recovers the lead id the worker needs — no Aimfox call
 * and no dependence on the provider listing, which is precisely what the
 * touch-driven cutover could not reach. Conversations already queued are
 * skipped, which makes the button safe to press twice.
 *
 * The single entry point for both triggers: the Manage dialog's button and the
 * startup flag call exactly this.
 */
export async function enqueueLinkedinReindex(
  db: Kysely<DB>,
  connectorConfigId: string,
  logger?: Logger,
): Promise<LinkedinReindexEnqueueResult> {
  const threads = await createConnectorRepository(db).listLiveThreadRollupsByProviderFileIdPattern({
    connectorConfigId,
    fileType: LINKEDIN_CONVERSATION_FILE_TYPE,
    providerFileIdPattern: LEGACY_LINKEDIN_SEGMENT_PROVIDER_FILE_ID_PATTERN,
    limit: ENQUEUE_SCAN_LIMIT,
  });
  if (threads.length >= ENQUEUE_SCAN_LIMIT) {
    logger?.info(
      { connectorId: connectorConfigId, scanLimit: ENQUEUE_SCAN_LIMIT },
      "LinkedIn reindex scan hit its limit; press re-index again once this batch drains to queue the rest",
    );
  }

  const runId = randomUUID();
  const candidates = new Map<string, LinkedinReindexEnqueueRow>();
  for (const thread of threads) {
    const parsed = parseLinkedinProviderConversationId(thread.threadId);
    if (!parsed) continue;
    const key = linkedinReindexConversationKey(parsed.accountId, parsed.conversationUrn);
    const leadId = parseLinkedinProfileLeadId(parsed.accountId, thread.rollupGroupId);
    const existing = candidates.get(key);
    if (existing) {
      existing.leadId ??= leadId;
      continue;
    }
    candidates.set(key, {
      runId,
      connectorConfigId,
      accountId: parsed.accountId,
      conversationUrn: parsed.conversationUrn,
      leadId,
    });
  }

  const repo = createLinkedinReindexRepository(db);
  const queued = await repo.listQueuedConversations({
    connectorConfigId,
    conversationUrns: [...candidates.values()].map((row) => row.conversationUrn),
  });
  const fresh = [...candidates].filter(([key]) => !queued.has(key)).map(([, row]) => row);
  const conversationsQueued = await repo.enqueue(fresh);
  return { conversationsQueued, conversationsSkipped: candidates.size - conversationsQueued };
}

/** The lead id a profile file's provider id ends with, or null when the anchor is not one. */
function parseLinkedinProfileLeadId(accountId: string, rollupGroupId: string | null): string | null {
  if (!rollupGroupId) return null;
  const prefix = linkedinProfileProviderFileId(accountId, "");
  return rollupGroupId.startsWith(prefix) ? rollupGroupId.slice(prefix.length) || null : null;
}

/** The counterpart of a conversation is whoever is not the account: the lead. */
function counterpartLeadId(accountId: string, messages: AimfoxMessage[]): string | null {
  for (const message of messages) {
    const senderId = message.sender?.id;
    if (senderId && senderId !== accountId) return senderId;
  }
  return null;
}

function readMaxRpm(scopeConfig: Record<string, unknown>): number {
  const value = scopeConfig.maxRpm;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_RPM;
}

/**
 * Refetches every queued conversation from Aimfox and ingests it into the
 * shared conversation tables, so the chunk engine has something to re-cut.
 *
 * The shape is `SlackBackfillWorker`'s — start/stop/kick/drain, a retry ladder
 * that parks in `exhausted` until a boot or a press re-arms it, and a sync
 * asked for only by a drain that actually fetched something — because the
 * constraint is the same: work measured in minutes of paced provider calls
 * cannot live inside a request or one sync run. What it does per row is not:
 * two Aimfox calls and one ingest, with no ranges, threads or graph cursor,
 * because a LinkedIn conversation is fetched whole.
 */
export class LinkedinReindexWorker {
  private readonly repo;
  private readonly now: () => number;
  private readonly ownerNamesByKey = new Map<string, Map<string, string>>();
  private readonly apiKeysByConnector = new Map<string, string | null>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private rerun = false;
  private running = false;
  private syncRequestInFlight = false;
  private syncRequestPending = false;

  constructor(private readonly options: LinkedinReindexWorkerOptions) {
    this.repo = createLinkedinReindexRepository(options.db);
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.kick(), this.options.tickMs ?? LINKEDIN_REINDEX_TICK_MS);
    this.timer.unref?.();
    void this.reconcile()
      .catch((error) => this.options.logger.warn({ error }, "LinkedIn reindex reconciliation failed"))
      .then(() => this.kick());
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }

  async kick(): Promise<void> {
    if (!this.running) return;
    if (this.active) {
      this.rerun = true;
      await this.active;
      return;
    }
    this.active = this.drain().catch((error) => {
      this.options.logger.error({ error }, "LinkedIn reindex worker failed");
    });
    const current = this.active;
    await current;
    this.active = null;
    if (this.rerun) {
      this.rerun = false;
      await this.kick();
    }
  }

  /**
   * Boot reconciliation re-arms rows that spent their attempt budget, and —
   * only under `LINKEDIN_CHUNK_REINDEX_HISTORY_ON_STARTUP` — enqueues every
   * connector's remaining legacy conversations through the same entry point
   * the button uses, so the deployment-wide trigger is not a second mechanism.
   *
   * Rows already sitting in `fetched` owe a sync: the previous process fetched
   * them and died before asking. That ask is made once here rather than on
   * every tick, because a row that never reaches `complete` would otherwise
   * drive a full sync every tick for the life of the process.
   */
  async reconcile(): Promise<{ rearmed: number; queued: number }> {
    const rearmed = await this.repo.rearmExhausted(new Date(this.now()).toISOString());
    if ((await this.repo.countFetched()) > 0) this.syncRequestPending = true;
    if (this.options.appConfig?.LINKEDIN_CHUNK_REINDEX_HISTORY_ON_STARTUP !== true) {
      return { rearmed, queued: 0 };
    }
    let queued = 0;
    for (const connector of await this.options.listConnectors()) {
      if (!this.engineEnabled(connector)) continue;
      const result = await enqueueLinkedinReindex(this.options.db, connector.id, this.options.logger);
      queued += result.conversationsQueued;
      this.options.logger.info(
        { connectorId: connector.id, ...result },
        "Queued a LinkedIn reindex from the startup flag",
      );
    }
    return { rearmed, queued };
  }

  /**
   * The button's path: re-arm, enqueue through the shared entry point, then
   * wake the drain.
   *
   * Re-arming first is what makes a second press mean something. A row that
   * spent its retry budget parks in `exhausted`, which still counts as queued,
   * so enqueue would skip it and only the next boot would ever move it — an
   * operator watching "N still on the old chunker" would press the button and
   * be told there is nothing to do.
   */
  async queueReindex(connectorConfigId: string): Promise<LinkedinReindexQueueResult> {
    const conversationsRearmed = await this.repo.rearmExhausted(new Date(this.now()).toISOString(), connectorConfigId);
    const result = await enqueueLinkedinReindex(this.options.db, connectorConfigId, this.options.logger);
    if (result.conversationsQueued > 0 || conversationsRearmed > 0) void this.kick();
    return { ...result, conversationsRearmed };
  }

  engineEnabled(connector: LinkedinReindexConnector): boolean {
    return resolveLinkedinChunkEngineEnabled({
      scopeConfig: connector.scopeConfig,
      envDefault: this.options.appConfig?.LINKEDIN_CHUNK_ENGINE_ENABLED,
    });
  }

  /**
   * Batches until the queue is empty, then asks for a sync when this drain
   * actually moved a conversation into `fetched`: a sync already past those
   * conversations would otherwise leave them ingested but uncut until the
   * scheduler happens to run again.
   *
   * The gate is what this drain did, never how many rows sit in `fetched`. A
   * row parks there for as long as nothing can drain it — the engine switched
   * off mid-reindex, an account dropped from `accountIds`, a conversation the
   * runner cuts no window for — and a count would then request a full sync on
   * every tick, forever, competing with this worker for the same rpm budget.
   */
  private async drain(): Promise<void> {
    this.ownerNamesByKey.clear();
    this.apiKeysByConnector.clear();
    while (this.running) {
      const batch = await this.repo.claimPending(
        new Date(this.now()).toISOString(),
        this.options.batchSize ?? LINKEDIN_REINDEX_BATCH,
      );
      if (batch.length === 0) break;
      if (!(await this.stepBatch(batch))) break;
    }
    if (this.running && this.syncRequestPending) this.requestSyncs();
  }

  /**
   * A connector whose key cannot be resolved parks its rows on the retry ladder
   * rather than failing them: a rotated credential is transient, and the
   * conversation still holds the live legacy files this is meant to replace.
   * The batch reports whether anything actually moved, so a drain cannot spin
   * on rows nothing can advance.
   */
  private async stepBatch(batch: LinkedinReindexRow[]): Promise<boolean> {
    const connectors = new Map((await this.options.listConnectors()).map((entry) => [entry.id, entry]));
    let advanced = false;
    for (const row of batch) {
      if (!this.running) break;
      const connector = connectors.get(row.connector_config_id);
      const apiKey = connector ? await this.apiKey(connector.id) : null;
      if (!connector || !apiKey) {
        await this.recordFailure(row, "LinkedIn connector credentials are unavailable");
        continue;
      }
      advanced = true;
      await this.stepRow(row, connector, apiKey);
    }
    return advanced;
  }

  /**
   * One conversation: the thread, then its lead, then one transaction that
   * ingests the messages as `history` and records the fetch. The two writes
   * share a transaction so a crash can never leave a row marked fetched with
   * nothing for the engine to cut.
   *
   * The thread is fetched first because it also names the lead: a legacy file
   * whose rollup anchor was lost still yields the counterpart's id from any
   * inbound message, and without a lead there is no roster to chunk under.
   */
  private async stepRow(row: LinkedinReindexRow, connector: LinkedinReindexConnector, apiKey: string): Promise<void> {
    const nowIso = new Date(this.now()).toISOString();
    const maxRpm = readMaxRpm(connector.scopeConfig);
    const client = new AimfoxClient(apiKey, { accountId: row.account_id, maxRpm });
    try {
      const detail = await client.getConversation(row.conversation_urn);
      const leadId = row.lead_id ?? counterpartLeadId(row.account_id, detail.messages);
      if (!leadId) {
        await this.repo.markFailed(row.id, "LinkedIn conversation has no lead participant", nowIso);
        return;
      }
      const lead = await client.getLead(leadId);
      const leadName = buildPersonSeed(lead)?.name ?? lead.full_name?.trim() ?? leadId;
      const ownerName =
        (await this.ownerNames(apiKey, maxRpm)).get(row.account_id) ?? `LinkedIn account ${row.account_id}`;
      await this.options.db.transaction().execute(async (trx) => {
        await ingestLinkedinConversation({
          db: trx,
          accountId: row.account_id,
          conversationUrn: row.conversation_urn,
          leadName,
          messages: detail.messages,
          source: "history",
        });
        await createLinkedinReindexRepository(trx).markFetched({
          id: row.id,
          leadId,
          leadName,
          ownerName,
          now: nowIso,
        });
      });
      this.syncRequestPending = true;
    } catch (error) {
      if (error instanceof AimfoxError && TERMINAL_AIMFOX_STATUSES.has(error.status)) {
        await this.repo.markFailed(row.id, extractErrorMessage(error), nowIso);
        this.options.logger.warn(
          { connectorId: row.connector_config_id, accountId: row.account_id, status: error.status },
          "LinkedIn reindex gave up on a conversation Aimfox no longer serves",
        );
        return;
      }
      await this.recordFailure(row, extractErrorMessage(error));
    }
  }

  /**
   * One credential resolution per connector per drain. Each one is a database
   * read plus a decrypt, and a drain steps thousands of rows belonging to a
   * handful of connectors. A resolution that came back empty is cached too: it
   * will not heal inside one drain, and the rows park on the retry ladder.
   */
  private async apiKey(connectorConfigId: string): Promise<string | null> {
    const cached = this.apiKeysByConnector.get(connectorConfigId);
    if (cached !== undefined) return cached;
    const resolved = await this.options.resolveApiKey(connectorConfigId);
    this.apiKeysByConnector.set(connectorConfigId, resolved);
    return resolved;
  }

  /** One `/accounts` call per key per drain; names only decorate files, so a failure degrades. */
  private async ownerNames(apiKey: string, maxRpm: number): Promise<Map<string, string>> {
    const cached = this.ownerNamesByKey.get(apiKey);
    if (cached) return cached;
    let names = new Map<string, string>();
    try {
      const accounts = await new AimfoxClient(apiKey, { maxRpm }).listAccounts();
      names = new Map(
        accounts
          .filter((account) => account.full_name?.trim())
          .map((account) => [String(account.id), account.full_name.trim()]),
      );
    } catch (error) {
      this.options.logger.warn(
        { err: truncateErrorMessage(extractErrorMessage(error)) },
        "Failed to load Aimfox account names for the LinkedIn reindex",
      );
    }
    this.ownerNamesByKey.set(apiKey, names);
    return names;
  }

  private async recordFailure(row: LinkedinReindexRow, error: string): Promise<void> {
    const phase = await this.repo.recordFailure({
      id: row.id,
      error,
      now: new Date(this.now()).toISOString(),
      retryAt: new Date(this.now() + LINKEDIN_REINDEX_RETRY_BASE_MS * (row.attempts + 1)).toISOString(),
    });
    this.options.logger.warn(
      { connectorId: row.connector_config_id, accountId: row.account_id, phase },
      "LinkedIn reindex conversation failed",
    );
  }

  /**
   * One sync per connector whose engine is on, fired without being awaited.
   *
   * `stop()` waits on the drain, and a LinkedIn sync runs inline for minutes.
   * Awaiting the ask here would hold a deploy open past the container's stop
   * timeout, and the SIGKILL that follows lands mid-sync — leaving the
   * connector `syncing` for an hour, which is an hour of this worker being
   * told `busy`. `SlackBackfillWorker` fires its request for the same reason.
   *
   * A connector already syncing is the one case worth retrying: it may have
   * passed these conversations before the fetch landed, so the ask is kept for
   * a later tick rather than dropped, which would strand them until the
   * scheduler runs.
   */
  private requestSyncs(): void {
    const request = this.options.requestSync;
    if (!request) {
      this.syncRequestPending = false;
      return;
    }
    if (this.syncRequestInFlight) return;
    this.syncRequestInFlight = true;
    void this.runSyncRequests(request)
      .catch((error) => {
        this.syncRequestPending = false;
        this.options.logger.warn({ error }, "LinkedIn sync request from the reindex worker failed");
      })
      .finally(() => {
        this.syncRequestInFlight = false;
      });
  }

  private async runSyncRequests(
    request: (connectorConfigId: string) => Promise<LinkedinSyncRequestOutcome>,
  ): Promise<void> {
    let busy = false;
    for (const connector of await this.options.listConnectors()) {
      if (!this.engineEnabled(connector)) continue;
      if ((await request(connector.id)) === "busy") busy = true;
    }
    if (!busy) this.syncRequestPending = false;
  }
}
