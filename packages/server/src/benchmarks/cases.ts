import { z } from "zod";

export const integrationIdSchema = z.enum(["none", "clickup", "github", "linear"]);
export type IntegrationId = z.infer<typeof integrationIdSchema>;
export type ProviderIntegration = Exclude<IntegrationId, "none">;
export const integrationNames: Record<IntegrationId, string> = {
  none: "Core automations",
  clickup: "ClickUp",
  github: "GitHub",
  linear: "Linear",
};

export const caseInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    integration: integrationIdSchema,
    operation: z.enum(["list", "create", "rename", "comment", "schedule", "core_file", "clickup_webhook"]),
    prompt: z.string().trim().min(1).max(6000),
    facts: z.array(z.string().trim().min(1).max(1000)).max(12).default([]),
    tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
    selection: z.enum(["open", "closed", "all"]).default("open"),
    openCount: z.number().int().min(1).max(20).default(3),
    closedCount: z.number().int().min(1).max(10).default(2),
    expectedText: z.string().min(1).max(3000).default("Ready for review"),
    webhookFamily: z.enum(["new_task", "completion", "priority", "multiple_lists", "attachment"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.integration === "none") !== (value.operation === "core_file"))
      ctx.addIssue({ code: "custom", message: "Core cases use core_file; integration cases require a connected app." });
    if (value.operation === "clickup_webhook" && (value.integration !== "clickup" || !value.webhookFamily))
      ctx.addIssue({ code: "custom", message: "Webhook cases require ClickUp and a supported event family." });
    if (value.operation !== "clickup_webhook" && value.webhookFamily)
      ctx.addIssue({ code: "custom", message: "A webhook family only applies to a ClickUp webhook case." });
    if (value.operation === "core_file" && !value.prompt.includes("{output}"))
      ctx.addIssue({ code: "custom", message: "Include {output} for the isolated output file." });
    if (!["core_file", "clickup_webhook"].includes(value.operation) && !value.prompt.includes("{target}"))
      ctx.addIssue({ code: "custom", message: "Include {target} so the request binds to the selected test area." });
    if (["list", "schedule", "create"].includes(value.operation) && !value.prompt.includes("{marker}"))
      ctx.addIssue({ code: "custom", message: "Include {marker} to scope the request to this case's fixtures." });
    if (["rename", "comment"].includes(value.operation) && !value.prompt.includes("{source}"))
      ctx.addIssue({ code: "custom", message: "Include {source} to identify the exact fixture to change." });
    if (["create", "rename", "comment"].includes(value.operation) && !value.prompt.includes("{expected}"))
      ctx.addIssue({ code: "custom", message: "Include {expected} to match the independently checked outcome." });
    if (value.operation === "schedule" && !value.prompt.includes("{output}"))
      ctx.addIssue({ code: "custom", message: "Include {output} for the scheduled report." });
  });
export type CaseInput = z.infer<typeof caseInputSchema>;
export interface CaseDefinition extends CaseInput {
  id: string;
  revision: number;
  source: "curated" | "manual" | "generated";
  updatedAt: string;
  designId?: string;
}

export function userRequest(input: CaseInput): string {
  const items = input.integration === "clickup" ? "tasks" : "issues";
  const selectedItems = input.selection === "all" ? `all ${items}` : `${input.selection} ${items}`;
  if (input.operation === "list")
    return `In {target}, find the ${selectedItems} whose names start with {marker}. Tell me their names, and leave everything unchanged.`;
  if (input.operation === "schedule")
    return `Every minute, look in {target} for the ${selectedItems} whose names start with {marker}. Save a short list of their names to {output} in my workspace. Leave them unchanged. If I pause the automation, stop checking until I resume it.`;
  return input.prompt;
}

export function assertionDescription(input: CaseInput): string {
  switch (input.operation) {
    case "list":
      return `Return JSON with the count and exact IDs of ${input.selection} fixture items; all fixture records must remain unchanged.`;
    case "create":
      return "Create exactly one item with the requested title; preserve every control fixture.";
    case "rename":
      return "Change only the original fixture's title to the expected value; preserve its ID and all control records.";
    case "comment":
      return "Add exactly one comment with the expected text to the original fixture; preserve all control records.";
    case "schedule":
      return "Save an every-minute automation, observe a real scheduled run and verify the report's exact fixture IDs/count; pause it and verify no further run starts.";
    case "core_file":
      return "Save an every-minute automation, observe the exact file output, verify pause and resume with real scheduler evidence.";
    case "clickup_webhook":
      return "Verify scoped webhooks, matching and non-matching events, provider output, pause, and cleanup through the existing event suite.";
  }
}

function curated(id: string, input: z.input<typeof caseInputSchema>): CaseDefinition {
  return { ...caseInputSchema.parse(input), id, revision: 1, source: "curated", updatedAt: "2026-09-08T00:00:00.000Z" };
}

const providerCases = (["clickup", "github", "linear"] as const).flatMap((integration) => {
  const item = integration === "clickup" ? "tasks" : "issues";
  const base = { integration, facts: [], tags: [integration] };
  return [
    ...(["open", "closed", "all"] as const).map((selection) =>
      curated(`${integration}-list-${selection}`, {
        ...base,
        title: `Find ${selection} ${item}`,
        operation: "list",
        selection,
        tags: [integration, "read", "filtering", "identity"],
        prompt: `In {target}, find ${selection === "all" ? "all" : `the ${selection}`} ${item} whose names start with {marker}. Tell me their names, and please do not change anything.`,
      }),
    ),
    curated(`${integration}-create`, {
      ...base,
      title: `Create a ${integration === "clickup" ? "task" : "new issue"}`,
      operation: "create",
      tags: [integration, "write", "creation", "negative-controls"],
      prompt:
        "In {target}, create one item titled {expected}. The title should begin with {marker}. Please leave everything else as it is.",
    }),
    curated(`${integration}-rename`, {
      ...base,
      title: "Update the correct item",
      operation: "rename",
      tags: [integration, "write", "identity", "negative-controls"],
      prompt:
        "Please rename {source} in {target} to {expected}. Keep its current status and description, and leave the other items alone.",
    }),
    curated(`${integration}-comment`, {
      ...base,
      title: "Comment on the correct item",
      operation: "comment",
      tags: [integration, "write", "comments", "negative-controls"],
      prompt:
        "In {target}, add this comment to {source}: {expected}. Please do not edit the item or comment anywhere else.",
    }),
    curated(`${integration}-scheduled-report`, {
      ...base,
      title: `Schedule a report of open ${item}`,
      operation: "schedule",
      tags: [integration, "automation", "schedule", "report"],
      prompt: `Every minute, find the open ${item} in {target} whose names start with {marker}. Save a short list of their names to {output} in my workspace, without changing the ${item}. Stop checking while the automation is paused.`,
    }),
  ];
});

export const curatedCases: CaseDefinition[] = [
  ...providerCases,
  ...[
    {
      id: "note",
      title: "Save a recurring note",
      text: "Time for a break.",
      request: "save exactly Time for a break.",
    },
    {
      id: "calculation",
      title: "Calculate a recurring total",
      text: "20",
      request: "add 12 and 8 and save only the total",
    },
    {
      id: "checklist",
      title: "Write a structured checklist",
      text: "Review inbox\nPlan next step",
      request: "save two plain lines, Review inbox followed by Plan next step, with no bullets or extra text",
    },
    {
      id: "report",
      title: "Write a CSV report",
      text: "item,count\nreviews,3",
      request: "save a two-line CSV: item,count on the first line and reviews,3 on the second",
    },
  ].map((entry) =>
    curated(`core-${entry.id}`, {
      integration: "none",
      title: entry.title,
      operation: "core_file",
      expectedText: entry.text,
      prompt: `Every minute, ${entry.request} in {output} in my workspace.`,
      tags: ["core", "schedule", "files", "pause", "resume"],
    }),
  ),
  ...(["new_task", "completion", "priority", "multiple_lists", "attachment"] as const).map((family) =>
    curated(`clickup-event-${family}`, {
      integration: "clickup",
      operation: "clickup_webhook",
      webhookFamily: family,
      title: `ClickUp event: ${family.replaceAll("_", " ")}`,
      prompt:
        "Use the selected ClickUp test Space to check that this event starts the right workflow and ignores unrelated activity.",
      tags: ["clickup", "automation", "webhook", family],
    }),
  ),
];

export interface DiscoverySnapshot {
  capturedAt: string;
  integration: ProviderIntegration;
  target: { id: string; name: string };
  complete: boolean;
  notes: string[];
  items: { title: string; state: string; description?: string }[];
  fields: string[];
}
export interface DesignConversation {
  id: string;
  revision: number;
  integration: IntegrationId;
  purpose?: "starter";
  snapshot: DiscoverySnapshot | null;
  bindingFingerprint?: string;
  messages: { id: string; role: "user" | "assistant"; text: string; createdAt: string }[];
  cases: CaseInput[];
  createdAt: string;
}
