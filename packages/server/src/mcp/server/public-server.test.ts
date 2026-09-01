import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendTargetMessage } from "../../agent/tools/types";
import { generateApiToken, getApiTokenDisplayPrefix, hashApiToken } from "../../auth/api-token";
import { createApiTokenRepository } from "../../db/repositories/api-tokens";
import { createSettingsRepository } from "../../db/repositories/settings";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createApp } from "../../http";
import type { SlackBot } from "../../slack/bot";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";
import type { WhatsAppRuntime } from "../../whatsapp/runtime";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

async function createPatForUser(
  input: {
    name?: string;
    email?: string;
    whatsappNumber?: string;
  } = {},
) {
  const settings = createSettingsRepository(db);
  await settings.create();
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const users = createUserRepository(db);
  const user = await users.create({
    name: input.name ?? "MCP User",
    email: input.email ?? "mcp@example.com",
    emailVerified: true,
    ...(input.whatsappNumber ? { whatsappNumber: input.whatsappNumber } : {}),
  });
  const plaintext = generateApiToken();
  await createApiTokenRepository(db).create({
    userId: user.id,
    name: "Claude Code",
    tokenHash: hashApiToken(plaintext),
    prefix: getApiTokenDisplayPrefix(plaintext),
  });
  return { token: plaintext, user };
}

async function createPat() {
  return (await createPatForUser()).token;
}

function mcpHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Protocol-Version": "2025-03-26",
  };
}

async function callMcpTool(
  token: string,
  app: ReturnType<typeof createApp>,
  name: string,
  args: Record<string, unknown>,
) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: mcpHeaders(token),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result: { content: Array<{ type: "text"; text: string }>; isError?: boolean };
  };
}

async function seedSlackMembership(channelId: string, slackUserId: string, email: string) {
  await createSettingsRepository(db).update({ slackTeamId: "T-MCP" });
  await db
    .insertInto("slack_channel_participants")
    .values({ channel_id: channelId, slack_user_id: slackUserId })
    .execute();
  await db
    .insertInto("slack_user_sync_state")
    .values({
      team_id: "T-MCP",
      slack_user_id: slackUserId,
      email,
      inactive_at: null,
    })
    .execute();
}

async function seedWhatsAppGroupMembership(groupJid: string, participantJid: string, lid: string) {
  await db.insertInto("whatsapp_groups").values({ jid: groupJid, name: "MCP Group", description: null }).execute();
  await db
    .insertInto("whatsapp_group_participants")
    .values({
      id: `${groupJid}:${participantJid}`,
      group_jid: groupJid,
      observation_key: lid,
      participant_jid: participantJid,
      phone_e164: null,
      lid,
      admin_role: null,
    })
    .execute();
}

describe("public MCP server", () => {
  it("is available and advertises OAuth discovery", async () => {
    const app = createApp(db, createTestConfig({}), { logger: createTestLogger() });
    const res = await app.request("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");
  });

  it("rejects non-Sketch PAT bearer tokens", async () => {
    const app = createApp(db, createTestConfig({}), { logger: createTestLogger() });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders("sk_live_wrong"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("lists the public sketch tools for a valid PAT", async () => {
    const token = await createPat();
    const app = createApp(db, createTestConfig({}), { logger: createTestLogger() });

    const res = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders(token),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "sketch_get_entity_context",
      "sketch_get_file_content",
      "sketch_search",
      "sketch_search_delivery_targets",
      "sketch_search_entities",
      "sketch_send_message",
    ]);
  });

  it("sends a Slack channel message when the token user is a verified member", async () => {
    const { token } = await createPatForUser({ email: "mcp@example.com" });
    await seedSlackMembership("C-MCP", "U-MCP", "mcp@example.com");
    const sendTargetMessage = vi.fn<SendTargetMessage>(async () => ({ messageRef: "1700000000.000100" }));
    const slack = { listChannels: async () => [] } as unknown as SlackBot;
    const app = createApp(db, createTestConfig({}), {
      logger: createTestLogger(),
      getSlack: () => slack,
      sendTargetMessage,
    });

    const body = await callMcpTool(token, app, "sketch_send_message", {
      platform: "slack",
      targetId: "C-MCP",
      message: "hello channel",
      threadTs: "1699999999.000900",
    });

    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0]?.text ?? "{}")).toMatchObject({
      status: "sent",
      platform: "slack",
      targetType: "channel",
      targetId: "C-MCP",
      threadTs: "1699999999.000900",
      messageRef: "1700000000.000100",
    });
    expect(sendTargetMessage).toHaveBeenCalledExactlyOnceWith({
      platform: "slack",
      targetType: "channel",
      targetId: "C-MCP",
      message: "hello channel",
      threadTs: "1699999999.000900",
    });
    await vi.waitFor(async () => {
      const row = await db
        .selectFrom("external_mcp_tool_calls")
        .select("success")
        .where("tool_name", "=", "sketch_send_message")
        .executeTakeFirst();
      expect(row?.success).toBe(1);
    });
  });

  it("fails closed when sending to a target without known membership", async () => {
    const { token } = await createPatForUser({ email: "mcp@example.com" });
    const sendTargetMessage = vi.fn<SendTargetMessage>(async () => ({ messageRef: "1700000000.000100" }));
    const app = createApp(db, createTestConfig({}), { logger: createTestLogger(), sendTargetMessage });

    const body = await callMcpTool(token, app, "sketch_send_message", {
      platform: "slack",
      targetId: "C-NOT-A-MEMBER",
      message: "do not send",
    });

    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("not a known member");
    expect(sendTargetMessage).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      const row = await db
        .selectFrom("external_mcp_tool_calls")
        .select("success")
        .where("tool_name", "=", "sketch_send_message")
        .executeTakeFirst();
      expect(row?.success).toBe(0);
    });
  });

  it("sends a WhatsApp group message using full token-user principals", async () => {
    const { token, user } = await createPatForUser({
      email: "mcp@example.com",
      whatsappNumber: "+15550001111",
    });
    await db.updateTable("users").set({ whatsapp_lid: "12345@lid" }).where("id", "=", user.id).execute();
    await seedWhatsAppGroupMembership("120363000000001@g.us", "12345@lid", "12345@lid");
    const sendTargetMessage = vi.fn<SendTargetMessage>(async () => ({ messageRef: "wamid-1" }));
    const whatsappRuntime = { isConnected: true } as WhatsAppRuntime;
    const app = createApp(db, createTestConfig({}), {
      logger: createTestLogger(),
      whatsappRuntime,
      sendTargetMessage,
    });

    const body = await callMcpTool(token, app, "sketch_send_message", {
      platform: "whatsapp",
      targetId: "120363000000001@g.us",
      message: "hello group",
    });

    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0]?.text ?? "{}")).toMatchObject({
      status: "sent",
      platform: "whatsapp",
      targetType: "group",
      targetId: "120363000000001@g.us",
      messageRef: "wamid-1",
    });
    expect(sendTargetMessage).toHaveBeenCalledExactlyOnceWith({
      platform: "whatsapp",
      targetType: "group",
      targetId: "120363000000001@g.us",
      message: "hello group",
    });
  });

  it("rate limits by token even when the forwarded IP changes", async () => {
    const token = await createPat();
    const app = createApp(db, createTestConfig({}), { logger: createTestLogger() });
    const statuses: number[] = [];
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);

    try {
      for (let i = 0; i < 61; i += 1) {
        const res = await app.request("/mcp", {
          method: "POST",
          headers: {
            ...mcpHeaders(token),
            "x-forwarded-for": `203.0.113.${i}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/list" }),
        });
        statuses.push(res.status);
      }
    } finally {
      nowSpy.mockRestore();
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(60);
    expect(statuses.at(-1)).toBe(429);
  });
});
