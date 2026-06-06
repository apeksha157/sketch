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

const CLASSIFY_PROMPT = `You're triaging a new Trustpilot review to decide whether it belongs in #design-wins.

Return JSON with:
- fiveStar: is the rating five stars?
- mentionsDesign: does it mention design, UI, UX, interface, layout, or visuals?
- lengthOk: is it longer than two sentences?

Only route reviews where all three are true.`;

const DESIGN_WINS_PROMPT = `A five-star design review just qualified. Post it to #design-wins as a Slack message:

- Header: :star2: *New design win on Trustpilot*
- The reviewer's name and the full review text
- A link to the review`;

const DESIGN_WINS_DM = `// DM the creator the moment a design win is posted.
return {
  channel: 'dm',
  text: \`Heads up — a five-star design review just landed in #design-wins 🎉\`,
};`;

const LOG_SCRIPT = `// Append the win to the team's tracker so nothing slips.
return {
  appended: true,
  tracker: 'design-wins-2026',
  reviewer: input.review.reviewer.name,
};`;

const REVIEW = {
  id: "rv_8821",
  rating: 5,
  title: "Beautiful, thoughtful design",
  text: "The new dashboard is gorgeous — the layout and visuals make everything click. Best UX I've used in this category.",
  reviewer: { name: "Maya R.", country: "US" },
  createdAt: "2026-06-02T08:40:00Z",
  url: "https://www.trustpilot.com/reviews/rv_8821",
};

const CLASSIFY_OUTPUT = { fiveStar: true, mentionsDesign: true, lengthOk: true };

// A clean run — every step succeeds across both branches (post→DM and log).
const TRUSTPILOT_OK = {
  trigger: { status: "success" as const, durationMs: 6, output: { review: REVIEW } },
  classify: { status: "success" as const, durationMs: 1840, output: CLASSIFY_OUTPUT },
  post: {
    status: "success" as const,
    durationMs: 4200,
    output:
      ":star2: *New design win on Trustpilot*\n> The new dashboard is gorgeous — the layout and visuals make everything click. Best UX I've used in this category.\n— Maya R. (★★★★★)\nhttps://www.trustpilot.com/reviews/rv_8821",
  },
  notify: { status: "success" as const, durationMs: 180, output: { delivered: true, channel: "dm", to: "you" } },
  log: {
    status: "success" as const,
    durationMs: 120,
    output: { appended: true, tracker: "design-wins-2026", row: 142 },
  },
};

// A partial failure — post couldn't reach Slack, so everything downstream (the
// DM and the tracker log) never ran. Shown by default so every status
// (success / failed / idle) is visible in one glance.
const TRUSTPILOT_FAILED = {
  trigger: { status: "success" as const, durationMs: 5, output: { review: REVIEW } },
  classify: { status: "success" as const, durationMs: 1760, output: CLASSIFY_OUTPUT },
  post: {
    status: "failed" as const,
    durationMs: 1306,
    error: "Slack API error: channel_not_found — #design-wins could not be resolved.",
  },
  notify: { status: "idle" as const },
  log: { status: "idle" as const },
};

const TRUSTPILOT_RUNS = [
  {
    id: "run-9f2a",
    status: "failed" as const,
    trigger: "webhook" as const,
    startedAt: "2026-06-02T08:40:05Z",
    durationMs: 3380,
    stepResults: TRUSTPILOT_FAILED,
  },
  {
    id: "run-8d1c",
    status: "success" as const,
    trigger: "webhook" as const,
    startedAt: "2026-06-01T15:19:45Z",
    durationMs: 6190,
    stepResults: TRUSTPILOT_OK,
  },
  {
    id: "run-7a55",
    status: "success" as const,
    trigger: "webhook" as const,
    startedAt: "2026-05-31T09:10:12Z",
    durationMs: 5980,
    stepResults: TRUSTPILOT_OK,
  },
  {
    id: "run-6b03",
    status: "success" as const,
    trigger: "manual" as const,
    startedAt: "2026-05-30T18:02:30Z",
    durationMs: 6420,
    stepResults: TRUSTPILOT_OK,
  },
];

/**
 * Draft automation that matches Apeksha's /chat/automation-sidecar narrative
 * ("Surface design wins from Trustpilot"). A branched graph — classify fans out
 * to the Slack post (→ DM) and a parallel tracker log — with run history that
 * exercises the output viewer, runs panel, and every node status at once.
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
    { id: "classify", type: "agent", label: "Check rating & topic", agentMode: "sketch", position: { x: 0, y: 0 } },
    {
      id: "post",
      type: "agent",
      label: "Post to #design-wins",
      agentMode: "sketch",
      agentMcpServers: ["slack"],
      position: { x: 0, y: 0 },
    },
    { id: "notify", type: "action", label: "DM the creator", position: { x: 0, y: 0 } },
    { id: "log", type: "action", label: "Log to wins tracker", position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: "e1", from: "trigger", to: "classify" },
    { id: "e2", from: "classify", to: "post" },
    { id: "e3", from: "post", to: "notify" },
    { id: "e4", from: "notify", to: "log" },
  ],
  content: {
    classify: { contentType: "prompt", content: CLASSIFY_PROMPT },
    post: { contentType: "prompt", content: DESIGN_WINS_PROMPT },
    notify: { contentType: "script", content: DESIGN_WINS_DM, apps: ["slack"] },
    log: { contentType: "script", content: LOG_SCRIPT, apps: ["sheets"] },
  },
  lastRun: TRUSTPILOT_FAILED,
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
