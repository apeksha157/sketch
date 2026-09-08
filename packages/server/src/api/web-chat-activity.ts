import type { WebChatProgressData, WebProgressItem } from "@sketch/shared";

export interface ActivityPart {
  type: "data-progress";
  id: string;
  data: WebChatProgressData;
}

export const MAX_ACTIVITY_DETAIL_BYTES = 256 * 1024;
export const MAX_COMPLETED_ACTIVITY_ITEMS = 512;

/** A bounded, ordered snapshot; updates keep each invocation in its original position. */
export class WebChatActivity {
  private readonly parts = new Map<string, ActivityPart>();
  private readonly calls = new Map<string, string>();
  private revision = 0;

  constructor(private readonly runId: string) {}

  record(key: string, data: WebChatProgressData): ActivityPart[] {
    const id = `${this.runId}:${key}`;
    const part: ActivityPart = {
      type: "data-progress",
      id,
      data: { ...data, items: data.items?.map((item) => ({ ...item, id, revision: ++this.revision })) },
    };
    this.parts.set(id, part);
    return [part, ...this.prune()];
  }

  enrich(toolCallId: string, data: WebChatProgressData): ActivityPart[] {
    const id = this.calls.get(toolCallId);
    const part = id ? this.parts.get(id) : undefined;
    const previous = part?.data.items?.[0];
    const item = data.items?.[0];
    if (!part || !previous || !item) return [];
    const next: ActivityPart = {
      ...part,
      data: {
        lines: data.lines,
        items: [
          {
            ...item,
            id: previous.id,
            status: previous.status,
            startedAt: previous.startedAt,
            endedAt: previous.endedAt,
            revision: ++this.revision,
          },
        ],
      },
    };
    this.parts.set(part.id, next);
    return [next, ...this.prune()];
  }

  start(toolCallId: string, startedAt: number, data: WebChatProgressData): ActivityPart[] {
    if (this.calls.has(toolCallId)) return [];
    const id = `${this.runId}:${toolCallId}`;
    const item = data.items?.[0];
    if (!item) return [];
    const next: WebProgressItem = { ...item, id, revision: ++this.revision, status: "running", startedAt };
    const part: ActivityPart = { type: "data-progress", id, data: { lines: data.lines, items: [next] } };
    this.calls.set(toolCallId, id);
    this.parts.set(id, part);
    return [part, ...this.prune()];
  }

  finish(
    toolCallId: string,
    status: Exclude<WebProgressItem["status"], "running" | undefined>,
    endedAt: number,
  ): ActivityPart[] {
    const id = this.calls.get(toolCallId);
    const part = id ? this.parts.get(id) : undefined;
    const item = part?.data.items?.[0];
    if (!part || !item || item.status !== "running") return [];
    const next = { ...part, data: { ...part.data, items: [{ ...item, status, endedAt, revision: ++this.revision }] } };
    this.parts.set(part.id, next);
    return [next, ...this.prune()];
  }

  finishPending(status: "cancelled" | "interrupted", endedAt: number): ActivityPart[] {
    return [...this.calls.keys()].flatMap((id) => this.finish(id, status, endedAt));
  }

  snapshot(): ActivityPart[] {
    return [...this.parts.values()];
  }

  private prune(): ActivityPart[] {
    const updates: ActivityPart[] = [];
    let detailBytes = this.snapshot().reduce(
      (total, part) => total + Buffer.byteLength(part.data.items?.[0]?.detail ?? ""),
      0,
    );
    const completed = this.snapshot().filter((part) => part.data.items?.[0]?.status !== "running");
    for (const part of [
      ...completed,
      ...this.snapshot().filter((entry) => entry.data.items?.[0]?.status === "running"),
    ]) {
      if (detailBytes <= MAX_ACTIVITY_DETAIL_BYTES) break;
      const item = part.data.items?.[0];
      if (!item?.detail) continue;
      detailBytes -= Buffer.byteLength(item.detail);
      const { detail: _detail, ...summary } = item;
      const next: ActivityPart = {
        ...part,
        data: { lines: [item.label], items: [{ ...summary, detailUnavailable: true, revision: ++this.revision }] },
      };
      this.parts.set(part.id, next);
      updates.push(next);
    }
    for (const part of completed.slice(0, Math.max(0, completed.length - MAX_COMPLETED_ACTIVITY_ITEMS))) {
      this.parts.delete(part.id);
      updates.push({ type: "data-progress", id: part.id, data: { lines: [], items: [] } });
      for (const [call, id] of this.calls) if (id === part.id) this.calls.delete(call);
    }
    return updates;
  }
}
