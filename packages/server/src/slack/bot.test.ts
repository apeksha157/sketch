import { describe, expect, it, vi } from "vitest";
import { SYSTEM_MESSAGE_SUBTYPES, SlackBot, clipForSlackLoading } from "./bot";

describe("SYSTEM_MESSAGE_SUBTYPES", () => {
  it("blocks channel-membership system messages that carry a user field", () => {
    for (const subtype of [
      "channel_join",
      "channel_leave",
      "channel_topic",
      "channel_purpose",
      "channel_name",
      "channel_archive",
      "channel_unarchive",
      "channel_posting_permissions",
    ]) {
      expect(SYSTEM_MESSAGE_SUBTYPES.has(subtype)).toBe(true);
    }
  });

  it("lets user-content subtypes through", () => {
    expect(SYSTEM_MESSAGE_SUBTYPES.has("file_share")).toBe(false);
    expect(SYSTEM_MESSAGE_SUBTYPES.has("thread_broadcast")).toBe(false);
  });
});

describe("clipForSlackLoading", () => {
  it("returns text unchanged when within the 50-code-point limit", () => {
    const input = '📖 Read: "a.ts"';
    expect(clipForSlackLoading(input)).toBe(input);
  });

  it("returns text unchanged at exactly 50 code points", () => {
    const input = "a".repeat(50);
    expect(clipForSlackLoading(input)).toBe(input);
  });

  it("clips to 50 code points with a trailing ellipsis when over the limit", () => {
    const input = `📖 Read: "${"x".repeat(60)}"`;
    const result = clipForSlackLoading(input);
    expect(Array.from(result)).toHaveLength(50);
    expect(result.endsWith("…")).toBe(true);
  });

  it("counts emojis as single code points so the clip is grapheme-safe", () => {
    const input = `${"📖".repeat(60)}`;
    const result = clipForSlackLoading(input);
    expect(Array.from(result)).toHaveLength(50);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("SlackBot.stripBotMention", () => {
  const botId = "U123BOT";

  it("strips mention at start of message", () => {
    expect(SlackBot.stripBotMention("<@U123BOT> hello", botId)).toBe("hello");
  });

  it("strips mention in middle of message", () => {
    expect(SlackBot.stripBotMention("hey <@U123BOT> hello", botId)).toBe("hey hello");
  });

  it("returns original text when no mention present", () => {
    expect(SlackBot.stripBotMention("hello", botId)).toBe("hello");
  });

  it("returns empty string when message is only a mention", () => {
    expect(SlackBot.stripBotMention("<@U123BOT>", botId)).toBe("");
  });

  it("strips multiple mentions", () => {
    expect(SlackBot.stripBotMention("<@U123BOT> do <@U123BOT> this", botId)).toBe("do this");
  });

  it("does not strip mentions of other users", () => {
    expect(SlackBot.stripBotMention("<@U999OTHER> hello", botId)).toBe("<@U999OTHER> hello");
  });
});

describe("SlackBot pagination", () => {
  function makeBot() {
    const list = vi.fn();
    const members = vi.fn();
    const bot = Object.assign(Object.create(SlackBot.prototype), {
      app: { client: { conversations: { list, members } } },
    }) as SlackBot;
    return { bot, list, members };
  }

  it.each([
    ["immediate repeat", ["A", "A"]],
    ["cursor cycle", ["A", "B", "A"]],
  ])("rejects channel pagination with %s", async (_name, cursors) => {
    const { bot, list } = makeBot();
    for (const cursor of cursors) {
      list.mockResolvedValueOnce({ ok: true, channels: [{ id: "C1" }], response_metadata: { next_cursor: cursor } });
    }
    list.mockResolvedValue({ ok: true, channels: [] });

    await expect(bot.listChannels()).rejects.toThrow(/cursor/i);
    expect(list).toHaveBeenCalledTimes(cursors.length);
  });

  it.each([
    ["immediate repeat", ["A", "A"]],
    ["cursor cycle", ["A", "B", "A"]],
  ])("rejects member pagination with %s", async (_name, cursors) => {
    const { bot, members } = makeBot();
    for (const cursor of cursors) {
      members.mockResolvedValueOnce({ ok: true, members: ["U1"], response_metadata: { next_cursor: cursor } });
    }
    members.mockResolvedValue({ ok: true, members: [] });

    await expect(bot.listChannelMembers("C1")).rejects.toThrow(/cursor/i);
    expect(members).toHaveBeenCalledTimes(cursors.length);
  });

  it("rejects a failed member page instead of returning partial members", async () => {
    const { bot, members } = makeBot();
    members
      .mockResolvedValueOnce({ ok: true, members: ["U1"], response_metadata: { next_cursor: "A" } })
      .mockResolvedValueOnce({ ok: false, error: "channel_not_found" });

    await expect(bot.listChannelMembers("C1")).rejects.toThrow("channel_not_found");
  });

  it("propagates a later member page exception", async () => {
    const { bot, members } = makeBot();
    const error = new Error("Slack unavailable");
    members
      .mockResolvedValueOnce({ ok: true, members: ["U1"], response_metadata: { next_cursor: "A" } })
      .mockRejectedValueOnce(error);

    await expect(bot.listChannelMembers("C1")).rejects.toBe(error);
  });

  it("returns all channel pages with their membership and visibility", async () => {
    const { bot, list } = makeBot();
    list
      .mockResolvedValueOnce({
        ok: true,
        channels: [{ id: "C1", name: "general", is_member: true }, { name: "missing-id" }],
        response_metadata: { next_cursor: "A" },
      })
      .mockResolvedValueOnce({
        ok: true,
        channels: [{ id: "C2", is_private: true, is_member: false }],
        response_metadata: { next_cursor: "" },
      });

    await expect(bot.listChannels()).resolves.toEqual([
      { id: "C1", name: "general", type: "public_channel", isMember: true },
      { id: "C2", name: "unknown", type: "private_channel", isMember: false },
    ]);
    expect(list).toHaveBeenNthCalledWith(1, {
      exclude_archived: true,
      limit: 200,
      types: "public_channel,private_channel",
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      exclude_archived: true,
      limit: 200,
      types: "public_channel,private_channel",
      cursor: "A",
    });
  });

  it("returns deduplicated members after all pages succeed", async () => {
    const { bot, members } = makeBot();
    members
      .mockResolvedValueOnce({ ok: true, members: ["U1", "U2"], response_metadata: { next_cursor: "A" } })
      .mockResolvedValueOnce({ ok: true, members: ["U2", "U3"], response_metadata: { next_cursor: "" } });

    await expect(bot.listChannelMembers("C1")).resolves.toEqual(["U1", "U2", "U3"]);
    expect(members).toHaveBeenNthCalledWith(1, { channel: "C1", limit: 1000 });
    expect(members).toHaveBeenNthCalledWith(2, { channel: "C1", limit: 1000, cursor: "A" });
  });
});
