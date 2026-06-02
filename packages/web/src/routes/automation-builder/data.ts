/**
 * Dummy automations for the builder UI prototype, transcribed verbatim from the
 * real `active_automations` / `active_automation_step_content` exports. Swap this
 * module for API calls in the wiring step — the shapes already match.
 */
import type { Automation } from "./types";

const GATHER_SCRIPT = `const { execSync } = require('child_process');

const props = JSON.stringify({
  q: 'from:support@mail.gather.town newer_than:1d',
  metadataOnly: true,
  maxResults: 20
});

const raw = execSync(
  \`node $INTEGRATION_CLI direct-execute-action --component-key gmail-find-email --configured-props '\${props}' --output json\`,
  { env: process.env, encoding: 'utf8', shell: '/bin/sh' }
);

const parsed = JSON.parse(raw);
const emails = (parsed.data?.ret ?? []).map((m) => ({
  subject: m.subject ?? '(no subject)',
  date: m.date ?? null,
  sender: m.sender ?? null
}));

return { count: emails.length, emails };`;

const GATHER_PROMPT = `You are posting a daily digest to a Slack channel. Given the following list of emails received from Gather (support@mail.gather.town) in the last 24 hours, produce a clean Slack-formatted summary.

For each email, show:
- *Subject* (bold)
- *Time* (human-readable, e.g. 'Apr 29, 2026 at 5:33 AM UTC')

Start with a header: \`:mailbox_with_mail: *Gather Email Digest — {today's date}*\`

If there are no emails, say: \`No emails from Gather in the last 24 hours.\`

End with a line like: \`_N email(s) received in the last 24 hours._\`

Input data:
{{input}}`;

const ROOPAK_PROMPT = `Search the knowledge base for Roopak Nijhara's open action items and outstanding deliverables from recent meetings and tasks. Focus on items assigned to Roopak that haven't been marked done yet.

Then send a DM to Roopak Nijhara (user ID: 252e43de-81f9-47f6-9e61-e93a1d93539e) with a clear, friendly daily standup-style reminder. The message should:
- List his key open deliverables concisely (bullet points)
- Mention any items that appear time-sensitive or overdue
- Be direct but warm — not spammy

Keep the message short and actionable.`;

const DESIGN_WINS_PROMPT = `A new five-star Trustpilot review just came in. If it mentions design (look for words like design, UI, UX, interface, layout, visuals), post it to #design-wins as a Slack message:

- Header: :star2: *New design win on Trustpilot*
- The reviewer's name and the full review text
- A link to the review

If the review does not mention design, do nothing.`;

const DESIGN_WINS_DM = `// Notify the creator the moment a design win is posted.
return {
  channel: 'dm',
  text: \`Heads up — a five-star design review just landed in #design-wins 🎉\`,
};`;

// A successful run's per-step results (trigger payload JSON → posted message → DM receipt).
const TRUSTPILOT_RESULTS = {
  trigger: {
    status: "success" as const,
    durationMs: 6,
    output: {
      review: {
        id: "rv_8821",
        rating: 5,
        title: "Beautiful, thoughtful design",
        text: "The new dashboard is gorgeous — the layout and visuals make everything click. Best UX I've used in this category.",
        reviewer: { name: "Maya R.", country: "US" },
        createdAt: "2026-06-02T08:40:00Z",
        url: "https://www.trustpilot.com/reviews/rv_8821",
      },
    },
  },
  post: {
    status: "success" as const,
    durationMs: 4200,
    output:
      ":star2: *New design win on Trustpilot*\n> The new dashboard is gorgeous — the layout and visuals make everything click. Best UX I've used in this category.\n— Maya R. (★★★★★)\nhttps://www.trustpilot.com/reviews/rv_8821",
  },
  notify: {
    status: "success" as const,
    durationMs: 180,
    output: { delivered: true, channel: "dm", to: "you", ts: "1717318805.001200" },
  },
};

// A failed run — the agent step couldn't post (channel gone), so notify never ran.
const TRUSTPILOT_FAILED = {
  trigger: {
    status: "success" as const,
    durationMs: 5,
    output: {
      review: {
        id: "rv_8790",
        rating: 5,
        title: "Fast support",
        text: "Quick to respond and sorted my issue in minutes.",
        reviewer: { name: "Tom B.", country: "GB" },
        createdAt: "2026-06-01T15:19:40Z",
        url: "https://www.trustpilot.com/reviews/rv_8790",
      },
    },
  },
  post: {
    status: "failed" as const,
    durationMs: 1306,
    error: "Slack API error: channel_not_found — #design-wins could not be resolved.",
  },
  notify: { status: "idle" as const },
};

const TRUSTPILOT_RUNS = [
  {
    id: "run-9f2a",
    status: "success" as const,
    trigger: "webhook" as const,
    startedAt: "2026-06-02T08:40:05Z",
    durationMs: 4386,
    stepResults: TRUSTPILOT_RESULTS,
  },
  {
    id: "run-8d1c",
    status: "failed" as const,
    trigger: "webhook" as const,
    startedAt: "2026-06-01T15:19:45Z",
    durationMs: 1311,
    stepResults: TRUSTPILOT_FAILED,
  },
  {
    id: "run-7a55",
    status: "success" as const,
    trigger: "webhook" as const,
    startedAt: "2026-05-31T09:10:12Z",
    durationMs: 4012,
    stepResults: TRUSTPILOT_RESULTS,
  },
  {
    id: "run-6b03",
    status: "success" as const,
    trigger: "manual" as const,
    startedAt: "2026-05-30T18:02:30Z",
    durationMs: 5210,
    stepResults: TRUSTPILOT_RESULTS,
  },
];

/**
 * Draft automation that matches Apeksha's /chat/automation-sidecar narrative
 * ("Surface design wins from Trustpilot"). Shown in the merged chat + builder view,
 * with dummy outputs + run history to exercise the output viewer and runs panel.
 */
export const DRAFT_TRUSTPILOT: Automation = {
  id: "draft-trustpilot-design-wins",
  title: "Surface design wins from Trustpilot",
  description: "Every five-star Trustpilot review mentioning design lands in #design-wins. DM you the moment it fires.",
  platform: "slack",
  scheduleLabel: "On every new Trustpilot review",
  timezone: "Europe/Paris",
  outputMode: "deliver",
  outputTarget: "#design-wins",
  status: "active",
  steps: [
    {
      id: "trigger",
      type: "trigger",
      label: "New Trustpilot review",
      icon: "webhook",
      position: { x: 0, y: 0 },
      triggerConfig: { type: "webhook", app: "trustpilot", eventDescription: "New review received" },
    },
    {
      id: "post",
      type: "agent",
      label: "Share design wins in #design-wins",
      agentMode: "sketch",
      position: { x: 0, y: 0 },
    },
    { id: "notify", type: "action", label: "DM me when it fires", position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: "e1", from: "trigger", to: "post" },
    { id: "e2", from: "post", to: "notify" },
  ],
  content: {
    post: { contentType: "prompt", content: DESIGN_WINS_PROMPT },
    notify: { contentType: "script", content: DESIGN_WINS_DM },
  },
  lastRun: TRUSTPILOT_RESULTS,
  runs: TRUSTPILOT_RUNS,
};

export const DUMMY_AUTOMATIONS: Automation[] = [
  DRAFT_TRUSTPILOT,
  {
    id: "f88cf335-1e85-4656-89b8-2f75d2adee70",
    title: "Gather Email Daily Digest",
    platform: "slack",
    scheduleLabel: "Every 24 hours",
    timezone: "Europe/Paris",
    outputMode: "deliver",
    outputTarget: "#sketch-automation-test",
    status: "active",
    lastRunAt: "2026-05-31T22:06:03.275Z",
    nextRunAt: "2026-06-02T22:00:00.000Z",
    steps: [
      {
        id: "trigger",
        type: "trigger",
        label: "Daily Trigger",
        icon: "⏰",
        position: { x: 0, y: 0 },
        triggerConfig: { type: "schedule", scheduleType: "interval", scheduleValue: "86400" },
      },
      { id: "fetch_emails", type: "action", label: "Fetch Gather Emails", icon: "📧", position: { x: 0, y: 1 } },
      { id: "summarize", type: "agent", label: "Summarize & Deliver", icon: "📋", position: { x: 0, y: 2 } },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "fetch_emails" },
      { id: "e2", from: "fetch_emails", to: "summarize" },
    ],
    content: {
      fetch_emails: { contentType: "script", content: GATHER_SCRIPT, apps: ["gmail"] },
      summarize: { contentType: "prompt", content: GATHER_PROMPT },
    },
    lastRun: {
      trigger: { status: "success", durationMs: 4 },
      fetch_emails: {
        status: "success",
        durationMs: 2310,
        output: {
          count: 3,
          emails: [
            { subject: "Your weekly Gather summary", date: "2026-05-31T06:12:00Z", sender: "support@mail.gather.town" },
            { subject: "New event in your space", date: "2026-05-31T11:48:00Z", sender: "support@mail.gather.town" },
            {
              subject: "3 people visited your office",
              date: "2026-05-31T18:03:00Z",
              sender: "support@mail.gather.town",
            },
          ],
        },
      },
      summarize: {
        status: "success",
        durationMs: 5120,
        output:
          ":mailbox_with_mail: *Gather Email Digest — May 31, 2026*\n…\n_3 email(s) received in the last 24 hours._",
      },
    },
  },
  {
    id: "7303154d-5352-4f5b-a30e-2f870e69357a",
    title: "Daily Dashboard Reminder",
    description: "Remind the user to check the dashboard every weekday at 9am IST",
    platform: "whatsapp",
    scheduleLabel: "Weekdays at 9:00 (cron 0 9 * * 1-5)",
    timezone: "Asia/Kolkata",
    outputMode: "deliver",
    status: "active",
    lastRunAt: "2026-06-02T03:30:06.432Z",
    nextRunAt: "2026-06-03T03:30:00.000Z",
    steps: [
      {
        id: "trigger",
        type: "trigger",
        label: "Schedule",
        icon: "clock",
        position: { x: 0, y: 0 },
        triggerConfig: { type: "schedule" },
      },
      {
        id: "step1",
        type: "agent",
        label: 'Remind the user: "Good morning! 👋 Time to check the dashboard."',
        icon: "sketch-ai",
        position: { x: 0, y: 100 },
      },
    ],
    edges: [],
    content: {
      step1: { contentType: "prompt", content: 'Remind the user: "Good morning! 👋 Time to check the dashboard."' },
    },
    lastRun: {
      trigger: { status: "success", durationMs: 3 },
      step1: { status: "success", durationMs: 1840, output: "Good morning! 👋 Time to check the dashboard." },
    },
  },
  {
    id: "d46a4f27-d61a-4e99-916e-961ce7606d98",
    title: "Daily Deliverables Reminder — Roopak",
    description:
      "Every morning, check Roopak's outstanding deliverables from recent meetings and send him a DM with a focused reminder.",
    platform: "slack",
    scheduleLabel: "Daily at 9:00 (cron 0 9 * * *)",
    timezone: "Europe/Paris",
    outputMode: "silent",
    status: "active",
    lastRunAt: "2026-06-01T07:00:58.906Z",
    nextRunAt: "2026-06-02T07:00:00.000Z",
    steps: [
      {
        id: "trigger",
        type: "trigger",
        label: "Cron: 0 9 * * * (Europe/Paris)",
        icon: "clock",
        position: { x: 0, y: 0 },
        triggerConfig: { type: "schedule", scheduleType: "cron", scheduleValue: "0 9 * * *", timezone: "Europe/Paris" },
      },
      {
        id: "step1",
        type: "agent",
        label: "Search the knowledge base for Roopak Nijhara's open action items and outstanding",
        icon: "sketch-ai",
        agentMode: "sketch",
        position: { x: 0, y: 100 },
      },
    ],
    edges: [],
    content: {
      step1: { contentType: "prompt", content: ROOPAK_PROMPT },
    },
    lastRun: {
      trigger: { status: "success", durationMs: 3 },
      step1: { status: "failed", durationMs: 9870, error: "Knowledge base search timed out after 9.8s" },
    },
  },
];
