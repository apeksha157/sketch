import type { WebProgressItemKind } from "@sketch/shared";
import type { ProgressEvent } from "./runner";
import {
  type ToolProgressIntegrationContext,
  type WebProgressIntegration,
  findProgressAppByComponentKey,
  resolveProgressIntegration,
} from "./tool-progress-integration";

export interface ProgressDescriptor {
  kind: WebProgressItemKind;
  friendlyLabel: string;
  technicalLabel: string;
  integration?: WebProgressIntegration;
  detailFormat?: "text" | "command" | "json";
}

function displayToolName(toolName: string): string {
  return toolName.match(/^mcp__.+?__(.+)$/)?.[1] ?? toolName;
}

function explicitIntegration(toolName: string): WebProgressIntegration | undefined {
  const normalized = toolName.toLowerCase();
  const app =
    normalized === "github_cli" || normalized === "github-api" || normalized.includes("__github__")
      ? { appId: "github", name: "GitHub" }
      : normalized === "linear_api" || normalized === "linear-api" || normalized.includes("__linear__")
        ? { appId: "linear", name: "Linear" }
        : normalized === "clickup_api" || normalized === "clickup-api" || normalized.includes("__clickup__")
          ? { appId: "clickup", name: "ClickUp" }
          : undefined;
  return app;
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function inputString(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === "string" && input[key].trim() ? input[key].trim() : undefined;
}

function safeFileBasename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutQuery = value.split(/[?#]/, 1)[0]?.trim() ?? "";
  const basename = withoutQuery
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1)
    ?.split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
  return basename?.trim() || undefined;
}

function hasUnquotedShellOperator(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "|" || char === ";" || char === "&" || char === "\n") return true;
  }
  return false;
}

function scheduleLabel(action: string | undefined): string {
  switch (action?.toLowerCase()) {
    case "list":
    case "list_tasks":
    case "list-scheduled-tasks":
      return "Listing scheduled tasks";
    case "create":
    case "add":
    case "schedule":
      return "Creating scheduled task";
    case "update":
      return "Updating scheduled task";
    case "delete":
    case "remove":
      return "Deleting scheduled task";
    case "get":
      return "Viewing scheduled task";
    case "getrun":
      return "Viewing scheduled task run";
    case "run":
      return "Running scheduled task";
    case "open":
      return "Opening scheduled task";
    case "share":
      return "Sharing scheduled task";
    case "mute":
      return "Muting scheduled task";
    case "unmute":
      return "Unmuting scheduled task";
    case "pause":
      return "Pausing scheduled task";
    case "resume":
      return "Resuming scheduled task";
    default:
      return "Managing scheduled tasks";
  }
}

function canvasDescriptor(
  event: ProgressEvent,
  context?: ToolProgressIntegrationContext,
): ProgressDescriptor | undefined {
  if (
    event.kind !== "tool_use" ||
    displayToolName(event.toolName) !== "Bash" ||
    typeof event.input.command !== "string"
  ) {
    return undefined;
  }
  const command = event.input.command;
  if (hasUnquotedShellOperator(command)) return undefined;
  const match = command.trim().match(/^["']?\$\{?CANVAS_CLI\}?["']?\s+([^\s|;&\n]+)/);
  const subcommand = match?.[1];
  if (!subcommand) return undefined;
  const componentKey = command
    .match(/(?:^|\s)--(?:component-key|componentKey)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s|;&]+))/)
    ?.slice(1)
    .find(Boolean);
  const appArgument = command
    .match(/(?:^|\s)--(?:apps?|integration)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s|;&]+))/i)
    ?.slice(1)
    .find(Boolean);
  const app = findProgressAppByComponentKey(componentKey ?? appArgument, context);
  let friendlyLabel: string;
  if (/^(?:list|search|find)-(?:apps|integrations|catalog)/i.test(subcommand)) {
    friendlyLabel = "Finding integrations";
  } else if (/^(?:discover|list|search|find|get)-(?:actions|components)/i.test(subcommand)) {
    friendlyLabel = app ? `Finding available ${app.name} actions` : "Finding available actions";
  } else if (subcommand === "direct-execute-action") {
    friendlyLabel = app ? `Using ${app.name}` : "Running Canvas action";
    const normalized = componentKey?.toLowerCase();
    if (app && normalized === `${app.appId}-search-issues`) friendlyLabel = `Searching ${app.name} issues`;
    if (app && normalized === `${app.appId}-create-issue`) friendlyLabel = `Creating ${app.name} issue`;
  } else if (subcommand === "direct-execute-web-search") {
    friendlyLabel = "Searching the web with Canvas";
  } else if (subcommand === "direct-execute-web-scrape") {
    friendlyLabel = "Scraping a web page with Canvas";
  } else {
    friendlyLabel = "Running Canvas action";
  }
  return {
    kind: "canvas",
    friendlyLabel,
    technicalLabel: event.toolName,
    ...(app ? { integration: app } : {}),
    detailFormat: "command",
  };
}

export function describeProgressEvent(
  event: ProgressEvent,
  context?: ToolProgressIntegrationContext,
): ProgressDescriptor {
  if (event.kind === "intermediate_text") {
    return { kind: "reasoning", friendlyLabel: "Thinking", technicalLabel: "Thinking", detailFormat: "text" };
  }
  const display = displayToolName(event.toolName);
  const canvas = canvasDescriptor(event, context);
  if (canvas) return canvas;
  if (display === "Skill") {
    const skill = inputString(event.input, "skill") ?? inputString(event.input, "name");
    const candidate = skill?.replace(/[-_ ]+(?:cli|skill)$/i, "");
    const app =
      resolveProgressIntegration(candidate, context) ??
      (candidate?.toLowerCase() === "github"
        ? { appId: "github", name: "GitHub" }
        : candidate?.toLowerCase() === "linear"
          ? { appId: "linear", name: "Linear" }
          : undefined);
    return {
      kind: app ? "integration" : "skill",
      friendlyLabel: app
        ? `Loading ${app.name} instructions`
        : skill && /integration/i.test(skill)
          ? "Loading integration instructions"
          : "Loading skill",
      technicalLabel: event.toolName,
      ...(app ? { integration: app } : {}),
      detailFormat: "text",
    };
  }
  if (display === "ManageScheduledTasks") {
    return {
      kind: "schedule",
      friendlyLabel: scheduleLabel(inputString(event.input, "action")),
      technicalLabel: event.toolName,
      detailFormat: "text",
    };
  }
  const known: Record<string, [WebProgressItemKind, string]> = {
    Bash: ["shell", "Running command"],
    Read: ["file", "Reading"],
    Write: ["file", "Creating"],
    Edit: ["file", "Editing"],
    Glob: ["search", "Finding files"],
    Grep: ["search", "Searching files"],
    WebSearch: ["web", "Searching the web"],
    WebFetch: ["web", "Fetching a web page"],
    SendFileToChat: ["attachment", "Sending file"],
    TranscribeAudio: ["audio", "Transcribing audio"],
    VisualAnalysis: ["image", "Analyzing image"],
    SearchDeliveryTargets: ["delivery", "Finding recipients"],
    SearchEntities: ["entity", "Searching connected knowledge"],
    GetEntityContext: ["entity", "Reading connected knowledge"],
    ReadChatHistory: ["chat", "Reading chat history"],
    local_run_command: ["local", "Using local device"],
    local_claude_session: ["local", "Using local Claude Code"],
    GetTeamDirectory: ["chat", "Reading team directory"],
    SearchUsers: ["search", "Finding teammates"],
    SendMessage: ["delivery", "Sending message"],
    SendMessageToTarget: ["delivery", "Sending message to a channel or group"],
    SendMessageToUsers: ["delivery", "Sending messages"],
    UpdateInboxWorkflow: ["tool", "Updating inbox item"],
    ResolveInboxWorkflow: ["tool", "Resolving inbox item"],
    getProviderConfig: ["integration", "Checking integration"],
  };
  const match = known[display];
  const integration = resolveProgressIntegration(display, context);
  const explicit = integration ?? explicitIntegration(event.toolName) ?? explicitIntegration(display);
  const fileTarget = ["Read", "Write", "Edit"].includes(display)
    ? safeFileBasename(inputString(event.input, "file_path"))
    : undefined;
  const friendlyLabel = match
    ? fileTarget
      ? `${match[1]} ${fileTarget}`
      : ["Read", "Write", "Edit"].includes(display)
        ? `${match[1]} a file`
        : match[1]
    : explicit
      ? `Using ${explicit.name}`
      : event.toolName.startsWith("mcp__")
        ? "Running integration"
        : humanize(display);
  return {
    kind: match?.[0] ?? (explicit ? "integration" : event.toolName.startsWith("mcp__") ? "integration" : "tool"),
    friendlyLabel,
    technicalLabel: event.toolName,
    ...(explicit ? { integration: explicit } : {}),
    detailFormat: display === "Bash" ? "command" : "text",
  };
}
