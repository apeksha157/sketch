import { describe, expect, it } from "vitest";
import { mapSlackBotReplyToInsert, mapSlackMessageToInsert } from "./message-mapper";

const TS = "1699000000.000100";

describe("Slack message mapper", () => {
  it("produces the same dedup tuple for a live capture and a history backfill of one message", () => {
    const live = mapSlackMessageToInsert(
      { ts: TS, userId: "U1", text: "ship it", threadTs: null, isDm: false },
      { conversationId: 7, senderName: "Asha", addressedToSketch: true },
    );
    const history = mapSlackMessageToInsert(
      { ts: TS, userId: "U1", text: "ship it", threadTs: null },
      { conversationId: 7, senderName: "Asha", addressedToSketch: false, source: "history", backfillRangeId: "r1" },
    );
    expect([live.conversationId, live.providerMessageId, live.senderJid, live.isBot]).toEqual([
      history.conversationId,
      history.providerMessageId,
      history.senderJid,
      history.isBot,
    ]);
    expect(live.providerThreadId).toEqual(TS);
    expect(history.source).toEqual("history");
    expect(history.backfillRangeId).toEqual("r1");
  });

  it("maps Sketch's own replies to the bot identity from either path", () => {
    const live = mapSlackBotReplyToInsert({ conversationId: 7, messageRef: TS, text: "done", threadTs: TS });
    const history = mapSlackBotReplyToInsert({
      conversationId: 7,
      messageRef: TS,
      text: "done",
      threadTs: TS,
      source: "history",
      backfillRangeId: "r1",
    });
    expect(live.senderJid).toEqual("bot");
    expect(live.isBot).toBe(true);
    expect([history.senderJid, history.isBot, history.providerMessageId]).toEqual([
      live.senderJid,
      live.isBot,
      live.providerMessageId,
    ]);
  });

  it("falls back to the bot id as sender and stores the attachment placeholder", () => {
    const mapped = mapSlackMessageToInsert(
      { ts: TS, botId: "B1", text: "" },
      { conversationId: 7, senderName: "Jira", addressedToSketch: false, hasAttachments: true },
    );
    expect(mapped.senderJid).toEqual("B1");
    expect(mapped.text).toEqual("See attached files.");
  });

  it("treats a thread reply as a reply on both paths", () => {
    const mapped = mapSlackMessageToInsert(
      { ts: "1699000000.000200", userId: "U2", text: "agreed", threadTs: TS },
      { conversationId: 7, senderName: "Bo", addressedToSketch: false, source: "history" },
    );
    expect(mapped.isThreadReply).toBe(true);
    expect(mapped.providerThreadId).toEqual(TS);
    expect(mapped.providerParentMessageId).toEqual(TS);
  });
});
