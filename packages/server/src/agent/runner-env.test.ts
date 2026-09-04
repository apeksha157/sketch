import { describe, expect, it } from "vitest";
import { buildAgentChildEnv } from "./runner";

describe("agent child environment", () => {
  it("removes provider credentials from the agent environment", () => {
    const env = buildAgentChildEnv(
      {
        GH_TOKEN: "integration-github-token",
        LINEAR_API_KEY: "integration-linear-key",
        SAFE_SETTING: "kept",
      },
      {
        GH_TOKEN: "agent-github-token",
        LINEAR_API_KEY: "agent-linear-key",
        OTHER_SETTING: "kept-too",
      },
    );

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(env.SAFE_SETTING).toBe("kept");
    expect(env.OTHER_SETTING).toBe("kept-too");
  });
});
