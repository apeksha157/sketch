import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAgentParams, RunAgentResult } from "../agent/runner";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  let activityRecoveryFailures = 0;
  const writeFile = vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
    const [path, data] = args;
    const transcriptPath = typeof path === "string" ? path : path instanceof URL ? path.pathname : "";
    const contents = typeof data === "string" ? data : "";
    if (
      transcriptPath.endsWith("/activity-recovery.json") &&
      contents.includes("transient-call") &&
      activityRecoveryFailures < 2
    ) {
      activityRecoveryFailures += 1;
      throw new Error("transient activity persistence failure");
    }
    return actual.writeFile(...args);
  });
  return { ...actual, writeFile };
});

function makeAgentResult(finalText: string): RunAgentResult {
  const rawUsage = {
    sdkCostUsd: 0.01,
    durationApiMs: 0,
    numTurns: 0,
    stopReason: null,
    errorSubtype: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model: null,
    isResumedSession: false,
    totalAttachments: 0,
    imageCount: 0,
    nonImageCount: 0,
    mimeTypes: [],
    fileSizes: [],
    promptMode: "text" as const,
    toolCalls: [],
    auxLlmCalls: [],
  };
  return {
    messageSent: true,
    sessionId: "sess-web-activity-recovery",
    costUsd: 0.01,
    auxCostUsd: 0,
    pendingUploads: [],
    trace: { progressEvents: [], finalText, automationArtifacts: [] },
    rawUsage,
  };
}

async function seedAdmin(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const passwordHash = await hashPassword("testpassword123");
  await settings.create();
  await settings.update({ onboardingCompletedAt: new Date().toISOString(), orgName: "NullCode AI", botName: "Sketch" });
  const admin = await users.create({
    name: "Karan Hudia",
    email: "karan@example.com",
    emailVerified: true,
    passwordHash,
    authRole: "admin",
  });
  return users.update(admin.id, { timezone: "Asia/Kolkata" });
}

async function login(app: ReturnType<typeof createApp>) {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "karan@example.com", password: "testpassword123" }),
  });
  return response.headers.get("set-cookie") ?? "";
}

describe("web chat activity persistence recovery", () => {
  let db: Kysely<DB>;
  let dataDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    dataDir = await mkdtemp(join(tmpdir(), "sketch-web-chat-activity-recovery-"));
  });

  afterEach(async () => {
    await db.destroy();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("recovers the authoritative activity snapshot after transient activity writes fail", async () => {
    await seedAdmin(db);
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await params
        .onProgressEvent({
          kind: "tool_use",
          toolName: "Read",
          toolCallId: "transient-call",
          startedAt: 100,
          input: { file_path: "notes.md" },
        })
        .catch(() => undefined);
      await params
        .onToolProgressEnd?.({ toolCallId: "transient-call", status: "succeeded", endedAt: 200 })
        .catch(() => undefined);
      return makeAgentResult("Recovered after persistence failure.");
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), { logger: createTestLogger(), runAgent });
    const cookie = await login(app);

    const response = await app.request("/api/web-chat?conversationId=activity-recovery", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Read my notes", progressRendererMode: "technical" }),
    });
    await response.text();

    expect(response.status).toBe(200);
    const history = await app.request("/api/web-chat/messages?conversationId=activity-recovery", {
      headers: { Cookie: cookie },
    });
    const parts = (await history.json()).messages.at(-1).parts;
    const progress = parts.find((part: { type: string }) => part.type === "data-progress");
    expect(progress).toBeDefined();
    expect(progress?.data.items[0]).toMatchObject({
      id: expect.stringMatching(/^assistant-progress-user-[^:]+:transient-call$/),
      status: "succeeded",
      startedAt: 100,
      endedAt: 200,
    });
    expect(parts).toContainEqual({ type: "text", text: "Recovered after persistence failure." });
  });
});
