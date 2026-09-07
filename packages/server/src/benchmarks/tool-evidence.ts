import type { ToolResultEvent } from "../agent/runner";

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
