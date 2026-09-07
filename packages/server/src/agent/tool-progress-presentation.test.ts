import type { IntegrationApp } from "@sketch/shared";
import { describe, expect, it } from "vitest";
import type { ProgressEvent } from "./runner";
import { createWebProgressData, createWebProgressItem } from "./tool-progress";
import { findProgressAppByComponentKey } from "./tool-progress-integration";
import { sanitizeProgressDetail, technicalDetailLimit } from "./tool-progress-sanitization";

const settings = { toolProgress: "technical" as const, reasoningText: false };
const apps: IntegrationApp[] = [
  { id: "github", name: "GitHub", description: "", icon: "https://github.example/icon.svg" },
  { id: "github-enterprise", name: "GitHub Enterprise", description: "" },
];

describe("technical tool progress presentation", () => {
  it("retains qualified names and multiline commands without the Slack preview cap", () => {
    const command = `gh issue create --title "first line"\n--body "${"x".repeat(500)}"`;
    const event: ProgressEvent = { kind: "tool_use", toolName: "mcp__sketch__Bash", input: { command } };
    const item = createWebProgressItem(event, settings);

    expect(item?.toolName).toBe("mcp__sketch__Bash");
    expect(item?.detail).toContain("first line");
    expect(item?.detail).toContain("\n");
    expect(item?.detail).toHaveLength(command.length);
  });

  it("bounds technical command detail by UTF-8 bytes and reports truncation", () => {
    const command = `echo ${"🙂".repeat(technicalDetailLimit)}`;
    const item = createWebProgressItem({ kind: "tool_use", toolName: "Bash", input: { command } }, settings);
    expect(new TextEncoder().encode(item?.detail ?? "").byteLength).toBeLessThanOrEqual(technicalDetailLimit);
    expect(item?.detailTruncated).toBe(true);
  });

  it("does not exceed the byte cap when truncation cuts a three-byte code point", () => {
    const command = `${"x".repeat(technicalDetailLimit - 1)}€`;
    const item = createWebProgressItem({ kind: "tool_use", toolName: "Bash", input: { command } }, settings);
    expect(new TextEncoder().encode(item?.detail ?? "").byteLength).toBeLessThanOrEqual(technicalDetailLimit);
    expect(item?.detailTruncated).toBe(true);
  });

  it("redacts shell credentials, headers, URL secrets, and embedded JSON secrets", () => {
    const command = [
      "TOKEN=do-not-show",
      "curl --header 'Authorization: Bearer bearer-secret'",
      "curl --header 'Authorization: Basic basic-secret'",
      "https://example.test/hook?api_key=query-secret",
      `--configured-props '{"client_secret":"json-secret"}'`,
    ].join(" ");
    const detail = sanitizeProgressDetail("Bash", { command });
    expect(detail.detailRedacted).toBe(true);
    expect(detail.detail).not.toMatch(/do-not-show|bearer-secret|basic-secret|query-secret|json-secret/);
    expect(detail.detail).toContain("<redacted>");
  });

  it("redacts extended shell secret flags with quoted and equals values", () => {
    const detail = sanitizeProgressDetail("Bash", {
      command:
        "tool --access-token 'access-value' --client-secret=client-value --private-key \"private-value\" --authorization auth-value",
    });
    expect(detail.detailRedacted).toBe(true);
    expect(detail.detail).not.toMatch(/access-value|client-value|private-value|auth-value/);
  });

  it("redacts sensitive native integration argv values", () => {
    const detail = sanitizeProgressDetail("mcp__sketch__github_cli", {
      argv: ["issue", "create", "--token", "native-secret", "--header", "Authorization: Bearer header-secret"],
    });
    expect(detail.detailRedacted).toBe(true);
    expect(detail.detail).not.toContain("native-secret");
    expect(detail.detail).not.toContain("header-secret");
  });

  it("redacts secrets in escaped JSON native argv values", () => {
    const detail = sanitizeProgressDetail("mcp__sketch__github_cli", {
      argv: ["--body", '{\\"client_secret\\":\\"escaped-secret\\"}'],
    });
    expect(detail.detailRedacted).toBe(true);
    expect(detail.detail).not.toContain("escaped-secret");
  });

  it("does not expose arbitrary unknown input", () => {
    const item = createWebProgressItem(
      { kind: "tool_use", toolName: "mcp__unknown__mystery", input: { privatePayload: "secret" } },
      settings,
    );
    expect(item?.detail).toBeUndefined();
    expect(item?.detailUnavailable).toBe(true);
  });
});

describe("friendly activity descriptors", () => {
  it("uses only a safe basename for Friendly file labels", () => {
    const event: ProgressEvent = {
      kind: "tool_use",
      toolName: "Read",
      input: { file_path: "/Users/tanush/private/notes.md?token=do-not-show#private" },
    };
    const item = createWebProgressItem(event, { toolProgress: "friendly", reasoningText: false });
    expect(item?.label).toBe("Reading notes.md");
    expect(item?.label).not.toContain("/Users");
    expect(item?.label).not.toContain("do-not-show");
    expect(item?.detail).toBeUndefined();
  });

  it("preserves Unicode basenames and gives a clear fallback when missing", () => {
    expect(
      createWebProgressItem(
        { kind: "tool_use", toolName: "Edit", input: { file_path: "attachments/नोट्स.md" } },
        { toolProgress: "friendly", reasoningText: false },
      )?.label,
    ).toBe("Editing नोट्स.md");
    expect(
      createWebProgressItem(
        { kind: "tool_use", toolName: "Read", input: {} },
        { toolProgress: "friendly", reasoningText: false },
      )?.label,
    ).toBe("Reading a file");
  });

  it("distinguishes skill loading, catalog discovery, action discovery, and execution", () => {
    const skill = createWebProgressItem(
      { kind: "tool_use", toolName: "Skill", input: { skill: "github" } },
      { toolProgress: "friendly", reasoningText: false },
    );
    const discovery = createWebProgressItem(
      {
        kind: "tool_use",
        toolName: "Bash",
        input: { command: "$CANVAS_CLI list-apps --output json" },
      },
      { toolProgress: "friendly", reasoningText: false },
      "friendly",
      { apps, providerId: "canvas" },
    );
    const actions = createWebProgressItem(
      {
        kind: "tool_use",
        toolName: "Bash",
        input: { command: "$CANVAS_CLI get-components --apps github --output json" },
      },
      { toolProgress: "friendly", reasoningText: false },
      "friendly",
      { apps, providerId: "canvas" },
    );
    const execution = createWebProgressItem(
      {
        kind: "tool_use",
        toolName: "Bash",
        input: { command: "$CANVAS_CLI direct-execute-action --component-key github-search-issues" },
      },
      { toolProgress: "friendly", reasoningText: false },
      "friendly",
      { apps, providerId: "canvas" },
    );
    expect(skill?.label).toBe("Loading GitHub instructions");
    expect(discovery?.label).toBe("Finding integrations");
    expect(actions?.label).toBe("Finding available GitHub actions");
    expect(execution?.label).toBe("Searching GitHub issues");
    expect(execution?.integration).toMatchObject({ providerId: "canvas", appId: "github", name: "GitHub" });
  });

  it("uses action-sensitive schedule labels and rejects compound Canvas guesses", () => {
    const list = createWebProgressItem(
      { kind: "tool_use", toolName: "ManageScheduledTasks", input: { action: "list" } },
      { toolProgress: "friendly", reasoningText: false },
    );
    const compound = createWebProgressItem(
      {
        kind: "tool_use",
        toolName: "Bash",
        input: { command: "$CANVAS_CLI direct-execute-action --component-key github-search-issues | jq ." },
      },
      { toolProgress: "friendly", reasoningText: false },
      "friendly",
      { apps, providerId: "canvas" },
    );
    expect(list?.label).toBe("Listing scheduled tasks");
    expect(compound?.label).toBe("Running command");
    expect(compound?.integration).toBeUndefined();
  });
});

describe("integration metadata resolution", () => {
  it("uses the longest known catalog app slug for component keys", () => {
    expect(findProgressAppByComponentKey("github-enterprise-create-issue", { apps })).toMatchObject({
      appId: "github-enterprise",
      name: "GitHub Enterprise",
    });
  });
});
