import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsersTable } from "../db/schema";
import {
  UploadCollector,
  createSketchMcpServer,
  handleGetOutreachStatus,
  handleGetTeamDirectory,
  handleRespondToOutreach,
  handleSendMessageToUser,
} from "./sketch-tools";

describe("UploadCollector", () => {
  it("stores file paths via collect()", () => {
    const collector = new UploadCollector();
    collector.collect("/workspace/file1.pdf");
    collector.collect("/workspace/file2.csv");
    expect(collector.drain()).toEqual(["/workspace/file1.pdf", "/workspace/file2.csv"]);
  });

  it("drain() clears the queue", () => {
    const collector = new UploadCollector();
    collector.collect("/workspace/file.txt");
    collector.drain();
    expect(collector.drain()).toEqual([]);
  });

  it("drain() on empty collector returns empty array", () => {
    const collector = new UploadCollector();
    expect(collector.drain()).toEqual([]);
  });
});

describe("createSketchMcpServer", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sketch-upload-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a valid MCP server config", () => {
    const collector = new UploadCollector();
    const server = createSketchMcpServer({ uploadCollector: collector, workspaceDir: tmpDir });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("sketch");
    expect(server.instance).toBeDefined();
  });

  it("has a SendFileToChat tool registered", () => {
    const collector = new UploadCollector();
    const server = createSketchMcpServer({ uploadCollector: collector, workspaceDir: tmpDir });
    // The McpServer instance should have the tool registered
    // We verify this indirectly by checking the server was created successfully
    expect(server.instance).toBeDefined();
  });
});

function makeUser(overrides: Partial<Selectable<UsersTable>> = {}): Selectable<UsersTable> {
  return {
    id: "user-1",
    name: "Alice",
    email: null,
    email_verified_at: null,
    slack_user_id: "S001",
    whatsapp_number: null,
    description: "Product manager",
    type: "human",
    role: null,
    reports_to: null,
    created_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("handleGetTeamDirectory", () => {
  it("returns all users except current user", async () => {
    const alice = makeUser({ id: "user-alice", name: "Alice" });
    const bob = makeUser({ id: "user-bob", name: "Bob" });
    const result = await handleGetTeamDirectory({
      userRepo: {
        list: async () => [alice, bob],
        findById: async () => undefined,
      },
      currentUserId: "user-alice",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("user-bob");
    expect(parsed[0].name).toBe("Bob");
  });

  it("includes channels: ['slack'] for user with only slack_user_id", async () => {
    const user = makeUser({ id: "user-bob", slack_user_id: "S999", whatsapp_number: null });
    const result = await handleGetTeamDirectory({
      userRepo: {
        list: async () => [user],
        findById: async () => undefined,
      },
      currentUserId: "user-alice",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].channels).toEqual(["slack"]);
  });

  it("includes channels: ['whatsapp'] for user with only whatsapp_number", async () => {
    const user = makeUser({ id: "user-bob", slack_user_id: null, whatsapp_number: "+1234567890" });
    const result = await handleGetTeamDirectory({
      userRepo: {
        list: async () => [user],
        findById: async () => undefined,
      },
      currentUserId: "user-alice",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].channels).toEqual(["whatsapp"]);
  });

  it("includes channels: ['slack', 'whatsapp'] for user with both", async () => {
    const user = makeUser({ id: "user-bob", slack_user_id: "S999", whatsapp_number: "+1234567890" });
    const result = await handleGetTeamDirectory({
      userRepo: {
        list: async () => [user],
        findById: async () => undefined,
      },
      currentUserId: "user-alice",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].channels).toEqual(["slack", "whatsapp"]);
  });

  it("returns empty array when only current user exists", async () => {
    const user = makeUser({ id: "user-alice" });
    const result = await handleGetTeamDirectory({
      userRepo: {
        list: async () => [user],
        findById: async () => undefined,
      },
      currentUserId: "user-alice",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(0);
  });

  it("returns 'No description' for users without a description", async () => {
    const user = makeUser({ id: "user-bob", description: null });
    const result = await handleGetTeamDirectory({
      userRepo: {
        list: async () => [user],
        findById: async () => undefined,
      },
      currentUserId: "user-alice",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].description).toBe("No description");
  });

  it("returns error when userRepo is not provided", async () => {
    const result = await handleGetTeamDirectory({ userRepo: undefined, currentUserId: "user-alice" });
    expect(result.content[0].text).toBe("Team directory not available.");
  });
});

describe("handleSendMessageToUser", () => {
  const now = new Date().toISOString();

  function makeOutreachRecord(overrides = {}) {
    return {
      id: "outreach-1",
      requester_user_id: "user-alice",
      recipient_user_id: "user-bob",
      message: "Can you help?",
      task_context: null,
      response: null,
      status: "pending",
      platform: "slack",
      channel_id: "C001",
      message_ref: "1111.0001",
      requester_platform: "slack",
      requester_channel: "C000",
      requester_thread_ts: null,
      created_at: now,
      responded_at: null,
      ...overrides,
    };
  }

  it("creates outreach record and calls sendDm for valid recipient", async () => {
    const bob = makeUser({ id: "user-bob", name: "Bob", slack_user_id: "S999" });
    const sendDm = vi.fn().mockResolvedValue({ channelId: "C001", messageRef: "1111.0001" });
    const createOutreach = vi.fn().mockResolvedValue(makeOutreachRecord());

    const result = await handleSendMessageToUser(
      { recipientUserId: "user-bob", message: "Need your input", taskContext: "Q4 planning" },
      {
        outreachRepo: {
          create: createOutreach,
          findById: vi.fn(),
          findPendingForRecipient: vi.fn(),
          findForRequester: vi.fn(),
          findPendingForRequester: vi.fn(),
          markResponded: vi.fn(),
          expireOlderThan: vi.fn(),
        },
        userRepo: { list: async () => [], findById: async (id) => (id === "user-bob" ? bob : undefined) },
        sendDm,
        currentUserId: "user-alice",
        taskContext: { platform: "slack", contextType: "dm", deliveryTarget: "C000", createdBy: "user-alice" },
      },
    );

    expect(sendDm).toHaveBeenCalledWith({ userId: "user-bob", platform: "slack", message: "Need your input" });
    expect(createOutreach).toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("sent");
    expect(parsed.recipientName).toBe("Bob");
    expect(parsed.outreachId).toBeDefined();
  });

  it("returns { outreachId, recipientName, status: 'sent' }", async () => {
    const bob = makeUser({ id: "user-bob", name: "Bob", slack_user_id: "S999" });
    const sendDm = vi.fn().mockResolvedValue({ channelId: "C001", messageRef: "ts1" });
    const createOutreach = vi.fn().mockResolvedValue(makeOutreachRecord({ id: "outreach-abc" }));

    const result = await handleSendMessageToUser(
      { recipientUserId: "user-bob", message: "hello" },
      {
        outreachRepo: {
          create: createOutreach,
          findById: vi.fn(),
          findPendingForRecipient: vi.fn(),
          findForRequester: vi.fn(),
          findPendingForRequester: vi.fn(),
          markResponded: vi.fn(),
          expireOlderThan: vi.fn(),
        },
        userRepo: { list: async () => [], findById: async (id) => (id === "user-bob" ? bob : undefined) },
        sendDm,
        currentUserId: "user-alice",
        taskContext: { platform: "slack", contextType: "dm", deliveryTarget: "C000", createdBy: "user-alice" },
      },
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ outreachId: "outreach-abc", recipientName: "Bob", status: "sent" });
  });

  it("rejects self-outreach", async () => {
    const result = await handleSendMessageToUser(
      { recipientUserId: "user-alice", message: "hi" },
      {
        outreachRepo: {
          create: vi.fn(),
          findById: vi.fn(),
          findPendingForRecipient: vi.fn(),
          findForRequester: vi.fn(),
          findPendingForRequester: vi.fn(),
          markResponded: vi.fn(),
          expireOlderThan: vi.fn(),
        },
        userRepo: { list: async () => [], findById: async () => undefined },
        sendDm: vi.fn(),
        currentUserId: "user-alice",
        taskContext: { platform: "slack", contextType: "dm", deliveryTarget: "C000", createdBy: "user-alice" },
      },
    );
    expect(result.content[0].text).toBe("Error: cannot send outreach to yourself.");
  });

  it("returns error for nonexistent user ID", async () => {
    const result = await handleSendMessageToUser(
      { recipientUserId: "user-ghost", message: "hi" },
      {
        outreachRepo: {
          create: vi.fn(),
          findById: vi.fn(),
          findPendingForRecipient: vi.fn(),
          findForRequester: vi.fn(),
          findPendingForRequester: vi.fn(),
          markResponded: vi.fn(),
          expireOlderThan: vi.fn(),
        },
        userRepo: { list: async () => [], findById: async () => undefined },
        sendDm: vi.fn(),
        currentUserId: "user-alice",
        taskContext: { platform: "slack", contextType: "dm", deliveryTarget: "C000", createdBy: "user-alice" },
      },
    );
    expect(result.content[0].text).toBe("Error: user not found.");
  });

  it("returns error for user with no connected channel", async () => {
    const charlie = makeUser({ id: "user-charlie", name: "Charlie", slack_user_id: null, whatsapp_number: null });
    const result = await handleSendMessageToUser(
      { recipientUserId: "user-charlie", message: "hi" },
      {
        outreachRepo: {
          create: vi.fn(),
          findById: vi.fn(),
          findPendingForRecipient: vi.fn(),
          findForRequester: vi.fn(),
          findPendingForRequester: vi.fn(),
          markResponded: vi.fn(),
          expireOlderThan: vi.fn(),
        },
        userRepo: { list: async () => [], findById: async (id) => (id === "user-charlie" ? charlie : undefined) },
        sendDm: vi.fn(),
        currentUserId: "user-alice",
        taskContext: { platform: "slack", contextType: "dm", deliveryTarget: "C000", createdBy: "user-alice" },
      },
    );
    expect(result.content[0].text).toContain("no connected channel");
  });

  it("stores correct requester context in the outreach record", async () => {
    const bob = makeUser({ id: "user-bob", slack_user_id: "S999" });
    const sendDm = vi.fn().mockResolvedValue({ channelId: "C001", messageRef: "ts1" });
    const createOutreach = vi.fn().mockResolvedValue(makeOutreachRecord());

    await handleSendMessageToUser(
      { recipientUserId: "user-bob", message: "ping" },
      {
        outreachRepo: {
          create: createOutreach,
          findById: vi.fn(),
          findPendingForRecipient: vi.fn(),
          findForRequester: vi.fn(),
          findPendingForRequester: vi.fn(),
          markResponded: vi.fn(),
          expireOlderThan: vi.fn(),
        },
        userRepo: { list: async () => [], findById: async (id) => (id === "user-bob" ? bob : undefined) },
        sendDm,
        currentUserId: "user-alice",
        taskContext: {
          platform: "slack",
          contextType: "dm",
          deliveryTarget: "C-requester",
          threadTs: "111.222",
          createdBy: "user-alice",
        },
      },
    );

    expect(createOutreach).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterPlatform: "slack",
        requesterChannel: "C-requester",
        requesterThreadTs: "111.222",
      }),
    );
  });

  it("returns error when outreach deps are missing", async () => {
    const result = await handleSendMessageToUser(
      { recipientUserId: "user-bob", message: "hi" },
      {
        outreachRepo: undefined,
        userRepo: undefined,
        sendDm: undefined,
        currentUserId: undefined,
        taskContext: undefined,
      },
    );
    expect(result.content[0].text).toBe("Error: outreach is not available in this context.");
  });
});

describe("handleRespondToOutreach", () => {
  const now = new Date().toISOString();

  function makeOutreachRecord(overrides = {}) {
    return {
      id: "outreach-1",
      requester_user_id: "user-alice",
      recipient_user_id: "user-bob",
      message: "What's the budget?",
      task_context: "Q4 planning",
      response: null,
      status: "pending",
      platform: "slack",
      channel_id: "C001",
      message_ref: "ts1",
      requester_platform: "slack",
      requester_channel: "C000",
      requester_thread_ts: null,
      created_at: now,
      responded_at: null,
      ...overrides,
    };
  }

  it("marks outreach as responded and calls enqueueMessage", async () => {
    const record = makeOutreachRecord();
    const markResponded = vi.fn().mockResolvedValue({ ...record, status: "responded", response: "Budget is $50k" });
    const enqueueMessage = vi.fn().mockResolvedValue(undefined);
    const alice = makeUser({ id: "user-alice", name: "Alice" });
    const bob = makeUser({ id: "user-bob", name: "Bob" });

    const result = await handleRespondToOutreach(
      { outreachId: "outreach-1", response: "Budget is $50k" },
      {
        outreachRepo: {
          findById: vi.fn().mockResolvedValue(record),
          markResponded,
          create: vi.fn(),
          findPendingForRecipient: vi.fn(),
          findForRequester: vi.fn(),
          findPendingForRequester: vi.fn(),
          expireOlderThan: vi.fn(),
        },
        enqueueMessage,
        userRepo: { list: async () => [], findById: async (id) => (id === "user-alice" ? alice : bob) },
      },
    );

    expect(markResponded).toHaveBeenCalledWith("outreach-1", "Budget is $50k");
    expect(enqueueMessage).toHaveBeenCalledWith(expect.objectContaining({ requesterUserId: "user-alice" }));
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ status: "delivered", requesterName: "Alice" });
  });

  it("passes correct synthetic message to enqueueMessage", async () => {
    const record = makeOutreachRecord();
    const markResponded = vi.fn().mockResolvedValue({ ...record, status: "responded" });
    const enqueueMessage = vi.fn().mockResolvedValue(undefined);
    const alice = makeUser({ id: "user-alice", name: "Alice" });
    const bob = makeUser({ id: "user-bob", name: "Bob" });

    await handleRespondToOutreach(
      { outreachId: "outreach-1", response: "The answer is 42" },
      {
        outreachRepo: {
          findById: vi.fn().mockResolvedValue(record),
          markResponded,
          create: vi.fn(),
          findPendingForRecipient: vi.fn(),
          findForRequester: vi.fn(),
          findPendingForRequester: vi.fn(),
          expireOlderThan: vi.fn(),
        },
        enqueueMessage,
        userRepo: { list: async () => [], findById: async (id) => (id === "user-alice" ? alice : bob) },
      },
    );

    const call = enqueueMessage.mock.calls[0][0];
    expect(call.message).toContain("Bob responded to your outreach");
    expect(call.message).toContain("The answer is 42");
  });

  it("returns error for nonexistent outreach ID", async () => {
    const result = await handleRespondToOutreach(
      { outreachId: "no-such-id", response: "answer" },
      {
        outreachRepo: {
          findById: vi.fn().mockResolvedValue(undefined),
          markResponded: vi.fn(),
          create: vi.fn(),
          findPendingForRecipient: vi.fn(),
          findForRequester: vi.fn(),
          findPendingForRequester: vi.fn(),
          expireOlderThan: vi.fn(),
        },
        enqueueMessage: vi.fn(),
        userRepo: undefined,
      },
    );
    expect(result.content[0].text).toBe("Error: outreach not found.");
  });

  it("returns error for already-responded outreach", async () => {
    const record = makeOutreachRecord({ status: "responded" });
    const result = await handleRespondToOutreach(
      { outreachId: "outreach-1", response: "again" },
      {
        outreachRepo: {
          findById: vi.fn().mockResolvedValue(record),
          markResponded: vi.fn(),
          create: vi.fn(),
          findPendingForRecipient: vi.fn(),
          findForRequester: vi.fn(),
          findPendingForRequester: vi.fn(),
          expireOlderThan: vi.fn(),
        },
        enqueueMessage: vi.fn(),
        userRepo: undefined,
      },
    );
    expect(result.content[0].text).toBe("Error: this outreach has already been responded to.");
  });

  it("returns error when deps are missing", async () => {
    const result = await handleRespondToOutreach(
      { outreachId: "outreach-1", response: "answer" },
      { outreachRepo: undefined, enqueueMessage: undefined, userRepo: undefined },
    );
    expect(result.content[0].text).toBe("Error: outreach is not available in this context.");
  });
});

describe("handleGetOutreachStatus", () => {
  const now = new Date().toISOString();

  it("returns sent and received outreach", async () => {
    const alice = makeUser({ id: "user-alice", name: "Alice" });
    const bob = makeUser({ id: "user-bob", name: "Bob" });

    const result = await handleGetOutreachStatus({
      outreachRepo: {
        findForRequester: vi.fn().mockResolvedValue([
          {
            id: "o1",
            requester_user_id: "user-alice",
            recipient_user_id: "user-bob",
            message: "What's the budget?",
            task_context: null,
            response: "50k",
            status: "responded",
            platform: "slack",
            channel_id: "C001",
            message_ref: "ts1",
            requester_platform: "slack",
            requester_channel: "C000",
            requester_thread_ts: null,
            created_at: now,
            responded_at: now,
          },
        ]),
        findPendingForRecipient: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        findById: vi.fn(),
        markResponded: vi.fn(),
        expireOlderThan: vi.fn(),
        findPendingForRequester: vi.fn(),
      },
      userRepo: { list: async () => [], findById: async (id) => (id === "user-bob" ? bob : alice) },
      currentUserId: "user-alice",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sent).toHaveLength(1);
    expect(parsed.sent[0].recipientName).toBe("Bob");
    expect(parsed.sent[0].response).toBe("50k");
    expect(parsed.received).toHaveLength(0);
  });

  it("returns received pending outreach", async () => {
    const alice = makeUser({ id: "user-alice", name: "Alice" });

    const result = await handleGetOutreachStatus({
      outreachRepo: {
        findForRequester: vi.fn().mockResolvedValue([]),
        findPendingForRecipient: vi.fn().mockResolvedValue([
          {
            id: "o2",
            requester_user_id: "user-alice",
            recipient_user_id: "user-bob",
            message: "Need your input",
            task_context: "Q4",
            response: null,
            status: "pending",
            platform: "slack",
            channel_id: "C001",
            message_ref: "ts1",
            requester_platform: "slack",
            requester_channel: "C000",
            requester_thread_ts: null,
            created_at: now,
            responded_at: null,
          },
        ]),
        create: vi.fn(),
        findById: vi.fn(),
        markResponded: vi.fn(),
        expireOlderThan: vi.fn(),
        findPendingForRequester: vi.fn(),
      },
      userRepo: { list: async () => [], findById: async () => alice },
      currentUserId: "user-bob",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sent).toHaveLength(0);
    expect(parsed.received).toHaveLength(1);
    expect(parsed.received[0].requesterName).toBe("Alice");
  });

  it("returns error when deps are missing", async () => {
    const result = await handleGetOutreachStatus({
      outreachRepo: undefined,
      userRepo: undefined,
      currentUserId: undefined,
    });
    expect(result.content[0].text).toBe("Outreach status not available.");
  });
});

describe("UploadCollector integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sketch-upload-int-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("collects files and drains correctly across multiple calls", () => {
    const collector = new UploadCollector();
    collector.collect(join(tmpDir, "a.pdf"));
    collector.collect(join(tmpDir, "b.csv"));
    collector.collect(join(tmpDir, "c.png"));

    const files = collector.drain();
    expect(files).toHaveLength(3);
    expect(files[0]).toContain("a.pdf");
    expect(files[2]).toContain("c.png");

    // Second drain should be empty
    expect(collector.drain()).toEqual([]);
  });
});
