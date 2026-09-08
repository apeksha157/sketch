import { z } from "zod";

export const BENCHMARK_VERSION = "benchmarks.v1";
export const batchSizeSchema = z.number().int().min(3).max(10);
export const familySchema = z.enum([
  "new_task",
  "completion",
  "priority",
  "multiple_lists",
  "attachment",
  "read_count",
  "create_task",
  "rename_task",
  "attach_existing",
  "core_note",
  "core_calculation",
  "core_checklist",
  "core_csv",
]);
export const suiteIdSchema = z.enum(["automations", "integrations", "automation_core"]);
export type SuiteId = z.infer<typeof suiteIdSchema>;
export const suiteFamilies: Record<SuiteId, readonly Family[]> = {
  automations: ["new_task", "completion", "priority", "multiple_lists", "attachment"],
  integrations: ["read_count", "create_task", "rename_task", "attach_existing"],
  automation_core: ["core_note", "core_calculation", "core_checklist", "core_csv"],
};
export type Family = z.infer<typeof familySchema>;

export const enrollmentSchema = z
  .object({
    integration: z.enum(["clickup", "none"]).default("clickup"),
    accountId: z.string().trim().min(1).max(256),
    teamId: z.string().regex(/^\d+$/),
    spaceId: z.string().regex(/^\d+$/),
    secondSpaceId: z.string().regex(/^\d+$/),
    dedicatedTestAccount: z.literal(true),
    sharedWithBenchmarkTeam: z.literal(true).default(true),
  })
  .strict();
export type EnrollmentInput = z.infer<typeof enrollmentSchema>;
export interface Enrollment extends EnrollmentInput {
  accountName?: string;
  id: string;
  userId: string;
  email: string;
}

export const selectionSchema = z
  .object({
    cases: z
      .array(z.object({ family: familySchema, variant: z.number().int().min(0).max(2) }).strict())
      .min(3)
      .max(10),
  })
  .strict();

/** Reviewed phrasing keeps generated batches comparable to fixed, independent assertions. */
export const goals: Record<Family, { title: string; requests: readonly string[] }> = {
  new_task: {
    title: "Follow up on new tasks",
    requests: [
      "Whenever a task is added to {source}, create a task in {destination} called Review: followed by the original task name.",
      "Help me keep track of new work in {source}. For each new task, add a task to {destination} with the same name prefixed with Review:.",
      "Set up an automation that adds a Review: task in {destination} each time a new task arrives in {source}. Use the original name after Review:.",
    ],
  },
  completion: {
    title: "Follow up when work is completed",
    requests: [
      "When a task in {source} is completed, create a follow-up in {destination}. Call it Review: followed by the completed task's name.",
      "I need to review completed work. Whenever a task is marked complete in {source}, add it to {destination} as a new task with Review: before its name.",
      "Set up a follow-up for tasks that become complete in {source}: create a task in {destination} named Review: plus the original name.",
    ],
  },
  priority: {
    title: "Follow up on high-priority work",
    requests: [
      "When a new high-priority task is added to {source}, create a task in {destination} called Review: followed by its name. Ignore tasks with other priorities.",
      "Help me track high-priority tasks arriving in {source}. Add each one to {destination} with Review: before its name. Leave other priorities alone.",
      "For each new task in {source} whose priority is High, add a follow-up to {destination} named Review: plus the original name. Don't do this for other tasks.",
    ],
  },
  multiple_lists: {
    title: "Watch two project lists",
    requests: [
      "Whenever a task is added to either {source} or {second}, create a task in {destination} called Review: followed by its name.",
      "Keep track of new work in both {source} and {second}. Add a follow-up task to {destination} for each new task, with Review: before its original name.",
      "Set up follow-ups for new tasks in {source} and {second}. Each should create a task in {destination} named Review: plus the source task's name.",
    ],
  },
  attachment: {
    title: "Add a file to follow-up tasks",
    requests: [
      "Whenever a task is added to {source}, create a follow-up in {destination} called Review: followed by its name, and attach this brief to the follow-up.",
      "For every new task in {source}, add a task to {destination} with Review: before its name. Include this brief as a file attachment on every follow-up.",
      "Set up follow-ups for new tasks in {source}. Put them in {destination}, name each Review: plus the original name, and attach this brief to each one.",
    ],
  },
  read_count: {
    title: "Count open tasks",
    requests: [
      "How many open tasks are in {source}? Reply with just the number.",
      "Count the tasks that are still open in {source}. Please give me only the number.",
      "I need the number of unfinished tasks in {source}. Reply with the number only.",
    ],
  },
  create_task: {
    title: "Create a task",
    requests: [
      "Create a task named Prepare weekly review in {destination}.",
      "Add Prepare weekly review as a new task in {destination}.",
      "Put a new task called Prepare weekly review in {destination}.",
    ],
  },
  rename_task: {
    title: "Update an existing task",
    requests: [
      "Rename Prepare launch brief in {source} to Final launch brief.",
      "Change the name of the Prepare launch brief task in {source} to Final launch brief.",
      "The task Prepare launch brief in {source} should be called Final launch brief. Please update it.",
    ],
  },
  attach_existing: {
    title: "Attach a file to a task",
    requests: [
      "Attach this brief to Prepare launch brief in {source}.",
      "Add this file as an attachment to the Prepare launch brief task in {source}.",
      "Please put this brief on the Prepare launch brief task in {source} as a file attachment.",
    ],
  },
  core_note: {
    title: "Save a recurring note",
    requests: [
      "Every minute, save a note containing exactly Time for a break. in {file} in my workspace.",
      "Keep a note updated once a minute: put Time for a break. in {file} in my workspace.",
      "Set up a recurring note every minute. Save Time for a break. in {file} in my workspace.",
    ],
  },
  core_calculation: {
    title: "Calculate a recurring total",
    requests: [
      "Every minute, add 12 and 8 and save just the total in {file} in my workspace.",
      "Once a minute, calculate 12 plus 8. Save only the answer in {file} in my workspace.",
      "Set up a recurring calculation: add 12 and 8 every minute and write only the result into {file} in my workspace.",
    ],
  },
  core_checklist: {
    title: "Create a recurring checklist",
    requests: [
      "Every minute, save a checklist in {file} in my workspace with two lines: Review inbox and Plan next step. Don't add bullets or other text.",
      "Keep {file} in my workspace updated each minute with Review inbox on the first line and Plan next step on the second. No bullets or extra text.",
      "Once a minute, write a two-line checklist to {file} in my workspace: Review inbox, then Plan next step. Use plain lines without bullets.",
    ],
  },
  core_csv: {
    title: "Create a recurring small report",
    requests: [
      "Every minute, save a CSV file called {file} in my workspace with the header item,count and one row: reviews,3.",
      "Keep {file} in my workspace updated every minute as CSV: item,count on the first line and reviews,3 on the next.",
      "Once a minute, create {file} in my workspace as a two-line CSV report. The lines should be item,count and reviews,3.",
    ],
  },
};

export interface Scenario {
  id: string;
  family: Family;
  variant: number;
  title: string;
  prompt: string;
  version: string;
}
export type Verdict = "pending" | "passed" | "failed" | "blocked" | "unverified" | "cancelled";
export interface Assertion {
  id: string;
  label: string;
  status: "passed" | "failed" | "unverified";
  evidence: string;
}
export interface Resource {
  kind: "list" | "automation" | "attachment" | "workspace_file";
  key: string;
  id: string | null;
  state: "intent" | "created" | "deleted";
  parentId?: string;
  name?: string;
  marker?: string;
}
export interface CaseResult {
  expectedOpenCount?: number;
  providerReadTaskIds?: string[];
  scenario: Scenario;
  verdict: Verdict;
  stage: string;
  assertions: Assertion[];
  conversation: { role: "user" | "assistant"; text: string }[];
  clarifications: number;
  technicalQuestions: number;
  cleanup: "pending" | "complete" | "needs_attention";
  resources: Resource[];
  automationId?: string;
  conversationId?: string;
  startedAt?: string;
  completedAt?: string;
  detail?: string;
}
export interface BenchmarkRun {
  requestedBy?: string;
  id: string;
  enrollmentId: string;
  suiteId: SuiteId;
  version: string;
  status: "draft" | "queued" | "running" | "completed" | "interrupted";
  createdAt: string;
  model: { provider: string; modelId: string; fingerprint: string };
  cases: CaseResult[];
  cancelRequested: boolean;
  sourceRunId?: string;
  sketchVersion?: string;
  agentRuntime?: string;
  enrollmentFingerprint?: string;
  detail?: string;
}

export const requiredAssertions = [
  "authoring",
  "scoped_webhooks",
  "positive_events",
  "negative_events",
  "provider_output",
  "paused",
];

/** A missing check or empty evidence can never turn an agent's claim into a pass. */
export function verdictFor(family: Family, assertions: Assertion[]): Verdict {
  const required = family.startsWith("core_")
    ? ["authoring", "schedule", "scheduled_execution", "file_output", "paused", "resumed"]
    : suiteFamilies.integrations.includes(family)
      ? ["direct_agent", "provider_output", ...(family === "attach_existing" ? ["attachment_bytes"] : [])]
      : [...requiredAssertions, ...(family === "attachment" ? ["attachment_bytes"] : [])];
  if (assertions.some((check) => check.status === "failed")) return "failed";
  if (
    required.some((id) => {
      const matches = assertions.filter((check) => check.id === id);
      return matches.length !== 1 || matches[0]?.status !== "passed" || !matches[0].evidence.trim();
    })
  )
    return "unverified";
  return "passed";
}

export function freezeSelection(raw: unknown, count: number, suiteId: SuiteId = "automations"): Scenario[] {
  const selection = selectionSchema.parse(raw);
  if (selection.cases.length !== batchSizeSchema.parse(count))
    throw new Error("The generator returned the wrong batch size.");
  const keys = selection.cases.map((item) => `${item.family}:${item.variant}`);
  if (new Set(keys).size !== keys.length) throw new Error("The generator repeated a scenario.");
  if (selection.cases.some((item) => !suiteFamilies[suiteId].includes(item.family)))
    throw new Error("The generator selected a case outside this suite.");
  if (new Set(selection.cases.map((item) => item.family)).size < Math.min(count, suiteFamilies[suiteId].length))
    throw new Error("The batch needs broader workflow coverage.");
  return selection.cases.map((item, index) => ({
    ...item,
    id: `${item.family}-${item.variant}-${index}`,
    title: goals[item.family].title,
    prompt: goals[item.family].requests[item.variant] ?? "",
    version: BENCHMARK_VERSION,
  }));
}

export function summarize(run: BenchmarkRun) {
  return {
    total: run.cases.length,
    passed: run.cases.filter((item) => item.verdict === "passed").length,
    unassisted: run.cases.filter((item) => item.verdict === "passed" && item.clarifications === 0).length,
    failed: run.cases.filter((item) => item.verdict === "failed").length,
    needsAttention: run.cases.filter(
      (item) => ["blocked", "unverified"].includes(item.verdict) || item.cleanup === "needs_attention",
    ).length,
  };
}
