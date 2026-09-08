import { BENCHMARK_VERSION } from "./contracts";

/** Feature-neutral catalogue consumed by the Platform UI; new suites reuse the same run and evidence surfaces. */
export interface BenchmarkSuiteDescriptor {
  id: string;
  name: string;
  description: string;
  version: string;
  integrations: { id: string; name: string }[];
  coverage: string[];
  notCovered: string[];
}

export const benchmarkSuites: readonly BenchmarkSuiteDescriptor[] = [
  {
    id: "automation_core",
    name: "Core automations",
    description: "Test plain-language setup, real schedules, file outputs, pause and resume without an integration.",
    version: BENCHMARK_VERSION,
    integrations: [{ id: "none", name: "No integration needed" }],
    coverage: ["Builder conversation", "Real scheduled execution", "File outputs", "Pause", "Resume", "Cleanup"],
    notCovered: ["Timezone and DST boundaries", "Cross-channel delivery", "Browser interactions"],
  },
  {
    id: "integrations",
    name: "Integration capabilities",
    description: "Test whether the agent can read, create, update and attach files through a connected integration.",
    version: BENCHMARK_VERSION,
    integrations: [{ id: "clickup", name: "ClickUp" }],
    coverage: ["Read counts", "Task creation", "Task updates", "Attachment bytes"],
    notCovered: ["Pagination beyond one page", "Other integrations", "Automation triggers"],
  },
  {
    id: "automations",
    name: "Integration automations",
    description: "Can an ordinary request become a working automation without technical help?",
    version: BENCHMARK_VERSION,
    integrations: [{ id: "clickup", name: "ClickUp" }],
    coverage: [
      "New tasks",
      "Completed tasks",
      "Priority filtering",
      "Multiple lists",
      "File attachments",
      "Scoped webhooks",
      "Pause",
      "Cleanup",
    ],
    notCovered: [
      "Scheduled triggers",
      "Other integrations",
      "Summary quality",
      "Browser interaction",
      "Cross-integration workflows",
    ],
  },
];
