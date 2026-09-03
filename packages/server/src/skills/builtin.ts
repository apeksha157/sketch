import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";

export const MANAGED_LINEAR_SKILL = `---
name: Linear
description: Use Linear through the Sketch Linear GraphQL tool with Canvas OAuth.
category: engineering
canvas-account: linear
---

# Linear

Use the Sketch \`linear_api\` tool for Linear work. The request executes inside the trusted Sketch process against Linear's GraphQL API. Canvas is the OAuth vault and returns only a short-lived access token; Sketch never receives or stores a refresh token. Select an opaque Canvas account when more than one usable account is available.

## Safe workflow

1. Read before writing. Resolve the target team, project, or issue with a bounded \`linear_api\` query before changing it.
2. For writes, show the intended title, description, target team, and issue identifier before asking for normal user confirmation.
3. If account resolution is ambiguous, ask the user to choose the Canvas account; never fall back to another owner or workspace.
4. Keep queries and variables bounded. Explain provider errors plainly. The tool refreshes once on a definite 401 and never retries 403, 429, network, or GraphQL errors. Never log headers, access tokens, refresh tokens, or connector configuration.
`;

export const MANAGED_GITHUB_SKILL = `---
name: GitHub CLI
description: Use GitHub through Sketch's managed local GitHub CLI tool with Canvas OAuth.
category: engineering
canvas-account: github
---

# GitHub CLI

Use the Sketch \`github_cli\` tool for GitHub work. Sketch executes \`gh\` locally; Canvas is only the OAuth vault and account-selection authority. Trusted Sketch server code receives the access token, injects it only into the \`gh\` child process as \`GH_TOKEN\`, and never exposes it to the agent. Refresh tokens remain in Canvas.

## Safe workflow

1. Start with discovery. Use \`repo view OWNER/REPO\`, \`issue list\`, \`pr list\`, or another read-only command to identify the target before reading it.
2. Prefer JSON output and \`--jq\` for stable, concise results. Keep result sizes bounded.
3. Pass \`--repo OWNER/REPO\` explicitly whenever the target is not unambiguous.
4. Read before writing. For issues, pull requests, workflows, and releases, show the intended target and change before asking for normal user confirmation.
5. The local runner rejects authentication/configuration commands, credential flags, arbitrary hosts, and environment inspection.
6. If more than one usable account exists, pass the selected opaque Canvas account ID or ask the user to choose one.

Never use raw HTTP authorization headers, raw tokens, token-printing commands, or commands that expose the process environment.
`;

export async function ensureBuiltinManagedSkills(config: Pick<Config, "CLAUDE_CONFIG_DIR">): Promise<void> {
  const skills = [
    { id: "github", content: MANAGED_GITHUB_SKILL, marker: "canvas-account: github" },
    { id: "linear", content: MANAGED_LINEAR_SKILL, marker: "canvas-account: linear" },
  ];
  for (const skill of skills) {
    const skillPath = join(config.CLAUDE_CONFIG_DIR, "skills", skill.id, "SKILL.md");
    let existing: string | null = null;
    try {
      existing = await readFile(skillPath, "utf8");
    } catch {
      existing = null;
    }
    if (existing?.includes(skill.marker)) continue;
    await mkdir(join(config.CLAUDE_CONFIG_DIR, "skills", skill.id), { recursive: true });
    await writeFile(skillPath, skill.content, "utf8");
  }
}
