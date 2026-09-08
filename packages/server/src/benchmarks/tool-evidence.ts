import type { ToolResultEvent } from "../agent/runner";

export function benchmarkToolFailed(event: ToolResultEvent): boolean {
  if (event.isError) return true;
  if (!/(?:^|__)(?:github_cli|linear_api|clickup_api)$/.test(event.toolName)) return false;
  let output = event.output;
  if (Array.isArray(output)) output = { content: output };
  if (output && typeof output === "object" && "content" in output && Array.isArray(output.content)) {
    output = output.content.find((entry) => entry && entry.type === "text" && typeof entry.text === "string")?.text;
  }
  if (typeof output === "string") {
    if (
      /^(?:GitHub CLI|Linear API|ClickUp API) (?:failed:|response exceeds)/.test(output) ||
      /^(?:GitHub|Linear|ClickUp) (?:OAuth|authorization) is not configured/.test(output)
    )
      return true;
    try {
      output = JSON.parse(output);
    } catch {
      return false;
    }
  }
  return Boolean(
    output &&
      typeof output === "object" &&
      "exitCode" in output &&
      typeof output.exitCode === "number" &&
      output.exitCode !== 0,
  );
}

/** Persist only task identities from a completed managed read, never raw provider output or credentials. */
export function benchmarkReadEvidence(event: ToolResultEvent): { taskIds: string[] } | null {
  if (event.isError || !/(?:^|__)clickup_api$/.test(event.toolName) || event.input.method !== "GET") return null;
  let output = event.output;
  if (Array.isArray(output)) output = { content: output };
  if (output && typeof output === "object" && "content" in output && Array.isArray(output.content)) {
    const part = output.content.find((entry) => entry && entry.type === "text" && typeof entry.text === "string");
    output = part?.text;
  }
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      return null;
    }
  }
  if (!output || typeof output !== "object" || !("tasks" in output) || !Array.isArray(output.tasks)) return null;
  const taskIds = output.tasks.flatMap((task) => (task && typeof task.id === "string" ? [task.id] : []));
  return taskIds.length <= 1000 ? { taskIds } : null;
}
