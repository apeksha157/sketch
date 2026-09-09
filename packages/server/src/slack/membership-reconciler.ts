import type { Kysely } from "kysely";
import { createSlackChannelParticipantsRepository } from "../db/repositories/slack-channel-participants";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";
import type { SlackBot } from "./bot";

export const SLACK_MEMBERSHIP_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SLACK_MEMBERSHIP_FRESHNESS_MS = 48 * 60 * 60 * 1000;

export class SlackMembershipReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private sweepRequested = false;
  private readonly requestedChannels = new Set<string>();
  private readonly channelMutations = new Map<string, Promise<void>>();
  private readonly channelVersions = new Map<string, number>();
  private readonly activeSnapshotStartedAt = new Map<string, number>();
  private connectionVersion = 0;
  private readonly participants;

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      logger: Pick<Logger, "info" | "warn">;
      getSlack: () => Pick<SlackBot, "listChannelMembers" | "listChannels"> | null;
      intervalMs?: number;
    },
  ) {
    this.participants = createSlackChannelParticipantsRepository(deps.db);
  }

  start(): void {
    if (this.timer) return;
    const startWake = () => {
      void this.wake().catch((err) => {
        this.deps.logger.warn({ err }, "Slack membership reconciliation failed");
      });
    };
    this.timer = setInterval(startWake, this.deps.intervalMs ?? SLACK_MEMBERSHIP_RECONCILIATION_INTERVAL_MS);
    this.timer.unref();
    startWake();
  }

  wake(): Promise<void> {
    this.sweepRequested = true;
    return this.drain();
  }

  refreshChannel(channelId: string): Promise<void> {
    this.requestedChannels.add(channelId);
    return this.drain();
  }

  private drain(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      while (this.sweepRequested || this.requestedChannels.size > 0) {
        const discover = this.sweepRequested;
        this.sweepRequested = false;
        const channelIds = new Set(this.requestedChannels);
        this.requestedChannels.clear();
        await this.run(channelIds, discover);
      }
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending?.catch(() => undefined);
    await Promise.allSettled(this.channelMutations.values());
  }

  recordParticipantJoined(channelId: string, slackUserId: string): Promise<void> {
    return this.recordParticipantMutation(channelId, () => this.participants.upsert(channelId, slackUserId));
  }

  recordParticipantObserved(channelId: string, slackUserId: string): Promise<void> {
    const snapshotStartedAt = this.activeSnapshotStartedAt.get(channelId);
    const observedAt = new Date(
      Math.max(Date.now(), snapshotStartedAt === undefined ? 0 : snapshotStartedAt + 1),
    ).toISOString();
    return this.enqueueChannelMutation(channelId, () => this.participants.upsert(channelId, slackUserId, observedAt));
  }

  recordParticipantLeft(channelId: string, slackUserId: string): Promise<void> {
    return this.recordParticipantMutation(channelId, () => this.participants.remove(channelId, slackUserId));
  }

  async clearAllParticipants(): Promise<void> {
    this.connectionVersion += 1;
    this.sweepRequested = false;
    this.requestedChannels.clear();
    await Promise.allSettled(this.channelMutations.values());
    await this.participants.clearAll();
  }

  private async run(channelIds: Set<string>, discover: boolean): Promise<void> {
    const slack = this.deps.getSlack();
    if (!slack) return;
    const connectionVersion = this.connectionVersion;
    const isCurrentConnection = () => this.connectionVersion === connectionVersion && this.deps.getSlack() === slack;
    if (discover) {
      const rows = await this.deps.db
        .selectFrom("conversations")
        .select("provider_conversation_id")
        .distinct()
        .where("platform", "=", "slack")
        .where("kind", "=", "channel")
        .execute();
      for (const row of rows) channelIds.add(row.provider_conversation_id);
      try {
        for (const channel of await slack.listChannels()) {
          if (channel.isMember) channelIds.add(channel.id);
        }
      } catch (err) {
        this.deps.logger.warn({ err }, "Slack membership channel discovery failed");
      }
    }
    let refreshed = 0;
    for (const channelId of [...channelIds].sort()) {
      if (!isCurrentConnection()) return;
      const snapshotStartedAtMs = Date.now();
      this.activeSnapshotStartedAt.set(channelId, snapshotStartedAtMs);
      try {
        const version = this.channelVersions.get(channelId) ?? 0;
        const members = await slack.listChannelMembers(channelId);
        if (members.length === 0) {
          this.deps.logger.warn({ channelId }, "Skipped empty Slack channel participant refresh");
          continue;
        }
        await this.enqueueChannelMutation(channelId, async () => {
          if (!isCurrentConnection()) return;
          if ((this.channelVersions.get(channelId) ?? 0) !== version) {
            this.requestedChannels.add(channelId);
            return;
          }
          await this.participants.replaceChannelRoster(
            channelId,
            members,
            new Date(Math.max(Date.now(), snapshotStartedAtMs + 1)).toISOString(),
            new Date(snapshotStartedAtMs).toISOString(),
          );
          refreshed += 1;
          this.deps.logger.info(
            { channelId, memberCount: members.length, trigger: discover ? "sweep" : "targeted" },
            "Slack channel membership roster refreshed",
          );
        });
      } catch (err) {
        this.deps.logger.warn({ err, channelId }, "Slack channel participant refresh failed");
      } finally {
        if (this.activeSnapshotStartedAt.get(channelId) === snapshotStartedAtMs) {
          this.activeSnapshotStartedAt.delete(channelId);
        }
      }
    }
    this.deps.logger.info(
      { eligibleChannels: channelIds.size, refreshedChannels: refreshed },
      "Slack membership reconciled",
    );
  }

  private recordParticipantMutation(channelId: string, mutation: () => Promise<void>): Promise<void> {
    this.channelVersions.set(channelId, (this.channelVersions.get(channelId) ?? 0) + 1);
    return this.enqueueChannelMutation(channelId, mutation);
  }

  private enqueueChannelMutation(channelId: string, mutation: () => Promise<void>): Promise<void> {
    const prior = this.channelMutations.get(channelId) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(mutation);
    this.channelMutations.set(channelId, current);
    const cleanup = () => {
      if (this.channelMutations.get(channelId) === current) {
        this.channelMutations.delete(channelId);
      }
    };
    void current.then(cleanup, cleanup);
    return current;
  }
}
