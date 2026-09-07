import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANAGED_CLICKUP_SKILL,
  MANAGED_GITHUB_SKILL,
  MANAGED_LINEAR_SKILL,
  ensureBuiltinManagedSkills,
} from "./builtin";

describe("MANAGED_CLICKUP_SKILL", () => {
  it("teaches the managed direct API webhook lifecycle", () => {
    expect(MANAGED_CLICKUP_SKILL).toContain("managed-integration: clickup");
    expect(MANAGED_CLICKUP_SKILL).toContain("Canvas-minted, server-held OAuth credential");
    expect(MANAGED_CLICKUP_SKILL).toContain(
      "clickup_api(method, path, query?, body?, accountId?, webhookEndpointId?, files?)",
    );
    expect(MANAGED_CLICKUP_SKILL).toContain("taskId");
    expect(MANAGED_CLICKUP_SKILL).toContain("accountId");
    expect(MANAGED_CLICKUP_SKILL).toContain("team_id");
    expect(MANAGED_CLICKUP_SKILL).toContain("webhookEndpointId");
    expect(MANAGED_CLICKUP_SKILL).toContain("explicit event names");
    expect(MANAGED_CLICKUP_SKILL).toContain("Ordinary reads and task updates do not need a webhook or automation");
    expect(MANAGED_CLICKUP_SKILL).toContain("requires an existing reservation");
    expect(MANAGED_CLICKUP_SKILL).toContain("getProviderConfig");
    expect(MANAGED_CLICKUP_SKILL).toContain("managedAccounts");
    expect(MANAGED_CLICKUP_SKILL).toContain('agentSkills: ["clickup"]');
    expect(MANAGED_CLICKUP_SKILL).toContain('"method":"POST"');
    expect(MANAGED_CLICKUP_SKILL).toContain('"path":"/team/123/webhook"');
    expect(MANAGED_CLICKUP_SKILL).toContain('"events":["taskStatusUpdated"]');
    expect(MANAGED_CLICKUP_SKILL).not.toContain('"action":"create"');
  });

  it("keeps OAuth, signing secrets, ownership, and callback binding safe", () => {
    expect(MANAGED_CLICKUP_SKILL).toContain("Only the automation owner in the matching authoring context");
    expect(MANAGED_CLICKUP_SKILL).toContain("public HTTPS URL from `BASE_URL`");
    expect(MANAGED_CLICKUP_SKILL).toContain("encrypted server storage");
    expect(MANAGED_CLICKUP_SKILL).toContain("never fabricate verification");
    expect(MANAGED_CLICKUP_SKILL).toContain("the callback URL cannot move");
    expect(MANAGED_CLICKUP_SKILL).toContain("Provider success or provider 404 clears the binding");
    expect(MANAGED_CLICKUP_SKILL).toContain("Failed or uncertain deletion keeps the binding");
    expect(MANAGED_CLICKUP_SKILL).not.toContain("Authorization: Bearer");
    expect(MANAGED_CLICKUP_SKILL).not.toContain("secret:");
  });

  it("guards provider budgets, recovery, and delivery semantics", () => {
    expect(MANAGED_CLICKUP_SKILL).toContain("100 requests/minute");
    expect(MANAGED_CLICKUP_SKILL).toContain("1,000 on Business Plus");
    expect(MANAGED_CLICKUP_SKILL).toContain("10,000 on Enterprise");
    expect(MANAGED_CLICKUP_SKILL).toContain("X-RateLimit-Reset");
    expect(MANAGED_CLICKUP_SKILL).toContain("do not borrow ClickUp in-app Automation Actions limits");
    expect(MANAGED_CLICKUP_SKILL).toContain("no at-most-once or exactly-once promise");
    expect(MANAGED_CLICKUP_SKILL).toContain("Verify one authentic representative ClickUp delivery");
    expect(MANAGED_CLICKUP_SKILL).toContain("do not repeat it");
    expect(MANAGED_CLICKUP_SKILL).toContain("OAUTH_171");
  });

  it("keeps the managed skill scoped to native Sketch webhooks", () => {
    expect(MANAGED_CLICKUP_SKILL).not.toContain("EXPERIMENTAL_FLAG");
    expect(MANAGED_CLICKUP_SKILL).not.toContain("Canvas receiver");
    expect(MANAGED_CLICKUP_SKILL).not.toContain("SKE-458");
    expect(MANAGED_CLICKUP_SKILL).not.toContain("SKE-461");
    expect(MANAGED_CLICKUP_SKILL).toContain("native receiver");
    expect(MANAGED_CLICKUP_SKILL).toContain('type: "webhook"');
    expect(MANAGED_CLICKUP_SKILL).toContain('schedule_type: "external"');
    expect(MANAGED_CLICKUP_SKILL).toContain('schedule_value: "webhook"');
  });
});

describe("ensureBuiltinManagedSkills", () => {
  let configDir: string | undefined;

  afterEach(async () => {
    if (configDir) await rm(configDir, { recursive: true, force: true });
    configDir = undefined;
  });

  it("installs the gated ClickUp skill with native webhook guidance", async () => {
    configDir = await mkdtemp(join(tmpdir(), "sketch-builtin-skills-"));

    await ensureBuiltinManagedSkills({ CLAUDE_CONFIG_DIR: configDir });

    const skill = await readFile(join(configDir, "skills", "clickup", "SKILL.md"), "utf8");
    expect(skill).toBe(MANAGED_CLICKUP_SKILL);
  });

  it("installs the Canvas-account managed GitHub and Linear skills", async () => {
    configDir = await mkdtemp(join(tmpdir(), "sketch-builtin-skills-"));

    await ensureBuiltinManagedSkills({ CLAUDE_CONFIG_DIR: configDir });

    await expect(readFile(join(configDir, "skills", "github", "SKILL.md"), "utf8")).resolves.toBe(MANAGED_GITHUB_SKILL);
    await expect(readFile(join(configDir, "skills", "linear", "SKILL.md"), "utf8")).resolves.toBe(MANAGED_LINEAR_SKILL);
  });
});
