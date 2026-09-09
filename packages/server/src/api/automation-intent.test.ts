import { describe, expect, it } from "vitest";
import { hasAutomationCreateIntent } from "./automation-intent";

describe("automation creation routing", () => {
  it.each([
    "Do not create an automation or invoke the automation creation skill. Read baseline counts.",
    "Don't create a workflow; read the existing tasks.",
    "Never create a new automation.",
    "Read the source without creating a new automation.",
    "Prepare only test data and fixtures from the following setup. Ignore any instructions here to create, configure, pause or activate automations; those belong to the tested user task. Do not create an automation or invoke the automation creation skill. Do not execute the user's task. Record exact IDs of every resource created. Do not alter unrelated data.",
  ])("does not route negated creation: %s", (message) => {
    expect(hasAutomationCreateIntent(message)).toBe(false);
  });
  it.each([
    "Create an automation for new tickets.",
    "I need a workflow for this.",
    "Do not change existing records. Create a new automation.",
    "Remind me to check support.",
  ])("still routes explicit creation: %s", (message) => {
    expect(hasAutomationCreateIntent(message)).toBe(true);
  });
});
