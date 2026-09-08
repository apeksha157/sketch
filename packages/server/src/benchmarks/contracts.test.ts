import { describe, expect, it } from "vitest";
import { outputsMatch } from "./clickup";
import { type Assertion, enrollmentSchema, freezeSelection, requiredAssertions, verdictFor } from "./contracts";
import { scopedWebhooksMatch } from "./runner";

const checks = (): Assertion[] =>
  requiredAssertions.map((id) => ({ id, label: id, status: "passed", evidence: "Independent provider observation" }));

describe("benchmark accuracy", () => {
  it("never passes an unexecuted or partially verified workflow", () => {
    expect(verdictFor("new_task", [])).toBe("unverified");
    expect(verdictFor("new_task", checks().slice(1))).toBe("unverified");
    expect(
      verdictFor(
        "new_task",
        checks().map((check) => ({ ...check, evidence: "" })),
      ),
    ).toBe("unverified");
    expect(verdictFor("new_task", checks())).toBe("passed");
  });
  it("requires attachment bytes, not just task creation", () => {
    expect(verdictFor("attachment", checks())).toBe("unverified");
    expect(
      verdictFor("attachment", [
        ...checks(),
        { id: "attachment_bytes", label: "file", status: "failed", evidence: "Wrong SHA256" },
      ]),
    ).toBe("failed");
  });
  it("cannot conceal a failed negative check behind successful positive checks", () => {
    expect(
      verdictFor(
        "new_task",
        checks().map((check) => (check.id === "negative_events" ? { ...check, status: "failed" } : check)),
      ),
    ).toBe("failed");
    expect(
      verdictFor("new_task", [
        ...checks(),
        checks().at(0) ?? { id: "missing", label: "missing", status: "unverified", evidence: "" },
      ]),
    ).toBe("unverified");
  });
  it("counts duplicates and unwanted destination records", () => {
    expect(outputsMatch([{ id: "1", name: "Review: Launch" }], ["Review: Launch"])).toBe(true);
    expect(outputsMatch([{ id: "1", name: "Review:Launch" }], ["Review: Launch"])).toBe(true);
    expect(
      outputsMatch(
        [
          { id: "1", name: "Review: Launch" },
          { id: "2", name: "Review: Launch" },
        ],
        ["Review: Launch"],
      ),
    ).toBe(false);
    expect(outputsMatch([{ id: "1", name: "Review: Wrong task" }], ["Review: Launch"])).toBe(false);
  });
  it("validates generated batches before freezing their prompts", () => {
    const cases = [
      { family: "new_task", variant: 0 },
      { family: "completion", variant: 1 },
      { family: "attachment", variant: 2 },
    ];
    expect(freezeSelection({ cases }, 3)).toHaveLength(3);
    expect(() => freezeSelection({ cases }, 5)).toThrow();
    expect(() => freezeSelection({ cases: [cases[0], cases[0], cases[2]] }, 3)).toThrow();
    expect(() =>
      freezeSelection(
        {
          cases: [
            { family: "new_task", variant: 0 },
            { family: "new_task", variant: 1 },
            { family: "new_task", variant: 2 },
          ],
        },
        3,
      ),
    ).toThrow();
    expect(() => freezeSelection({ cases, model: "expensive-override" }, 3)).toThrow();
    expect(() =>
      enrollmentSchema.parse({
        accountId: "1",
        teamId: "1",
        spaceId: "1",
        secondSpaceId: "2",
        dedicatedTestAccount: false,
      }),
    ).toThrow();
  });
});

describe("remote scope verification", () => {
  const callback = (id: string) => `https://test.example/api/webhooks/v1/${id}`;
  const endpoint = (id: string, remoteId: string) => ({
    id,
    status: "active_signed",
    source_binding: JSON.stringify({ accountId: "account", resourceId: remoteId, callbackUrl: callback(id) }),
  });
  const params = {
    endpoints: [endpoint("a", "ra"), endpoint("b", "rb")],
    remote: [
      { id: "ra", endpoint: callback("a"), list_id: "100", events: ["taskCreated"] },
      { id: "rb", endpoint: callback("b"), list_id: "200", events: ["taskCreated"] },
    ],
    sourceIds: ["200", "100"],
    event: "taskCreated",
    accountId: "account",
    callback,
  };
  it("requires both disjoint list subscriptions", () => {
    expect(scopedWebhooksMatch(params)).toBe(true);
    expect(scopedWebhooksMatch({ ...params, remote: params.remote.slice(0, 1) })).toBe(false);
  });
  it("rejects broad, duplicate, wrong-account and extra-event subscriptions", () => {
    expect(scopedWebhooksMatch({ ...params, remote: params.remote.map((hook) => ({ ...hook, list_id: null })) })).toBe(
      false,
    );
    expect(
      scopedWebhooksMatch({
        ...params,
        remote: [...params.remote, params.remote[0] ?? { id: "missing", endpoint: "", list_id: "", events: [] }],
      }),
    ).toBe(false);
    expect(scopedWebhooksMatch({ ...params, accountId: "different" })).toBe(false);
    expect(
      scopedWebhooksMatch({
        ...params,
        remote: params.remote.map((hook) => ({ ...hook, events: ["taskCreated", "taskUpdated"] })),
      }),
    ).toBe(false);
  });
  it("allows a retired empty slot but rejects an abandoned binding", () => {
    expect(
      scopedWebhooksMatch({
        ...params,
        endpoints: [...params.endpoints, { id: "default", status: "revoked", source_binding: null }],
      }),
    ).toBe(true);
    expect(
      scopedWebhooksMatch({
        ...params,
        endpoints: [...params.endpoints, { ...endpoint("default", "old"), status: "revoked" }],
      }),
    ).toBe(false);
  });
});
