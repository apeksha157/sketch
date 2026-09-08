import { randomInt } from "node:crypto";
import { type OwnerRequest, exerciseDirectChat } from "./builder";
import { BenchmarkBlockedError, type ClickUpProbe, type ClickUpTask, type Fixtures, outputsMatch } from "./clickup";
import { type BenchmarkRun, type CaseResult, verdictFor } from "./contracts";
import type { createBenchmarkModel } from "./model";

export async function executeIntegrationCase(params: {
  run: BenchmarkRun;
  item: CaseResult;
  probe: ClickUpProbe;
  fixtures: Fixtures;
  request: OwnerRequest;
  model: Pick<ReturnType<typeof createBenchmarkModel>, "manifest" | "answer" | "generate">;
  signal: AbortSignal;
  save: () => Promise<void>;
  attachments: unknown[];
  prompt: string;
}) {
  const { item, probe, fixtures, request, model, signal, save } = params;
  let source: ClickUpTask | null = null;
  if (item.scenario.family === "read_count") {
    item.expectedOpenCount ??= randomInt(2, 9);
    await save();
    for (let index = 0; index < item.expectedOpenCount; index++)
      await probe.createTask(fixtures.source.id, `Work item ${index + 1}`);
    const list = await probe.request<{ statuses: { status: string; type: string }[] }>(
      "GET",
      `/list/${fixtures.source.id}`,
    );
    const completed = list.statuses.find((status) => status.type === "closed" || status.type === "done");
    if (!completed)
      throw new BenchmarkBlockedError("The fixture needs a completed status to verify that closed tasks are excluded.");
    await probe.request("POST", `/list/${fixtures.source.id}/task`, {
      name: "Already finished work",
      status: completed.status,
    });
  } else if (item.scenario.family === "rename_task" || item.scenario.family === "attach_existing") {
    source = await probe.createTask(fixtures.source.id, "Prepare launch brief");
  }
  const before = await probe.tasks(fixtures.source.id);
  item.stage = "using_integration";
  const text = await exerciseDirectChat({
    request,
    item,
    model,
    manifest: params.run.model,
    prompt: params.prompt,
    facts: [params.prompt, "Use my connected ClickUp account.", `The task is in ${fixtures.source.name}.`],
    attachments: params.attachments,
    signal,
    save,
  });
  item.assertions.push({
    id: "direct_agent",
    label: "The normal agent completed its conversation",
    status: "passed",
    evidence: "Consumed the ordinary web-chat stream, with normal user authorization and bounded clarification.",
  });
  item.stage = "verifying";
  const actualSource = await probe.tasks(fixtures.source.id);
  const destination = await probe.tasks(fixtures.destination.id);
  let correct = false;
  if (item.scenario.family === "read_count")
    correct =
      text.trim() === String(item.expectedOpenCount) &&
      before
        .filter((task) => !["closed", "done"].includes(task.status?.type ?? ""))
        .every((task) => item.providerReadTaskIds?.includes(task.id)) &&
      destination.length === 0 &&
      actualSource.length === before.length &&
      actualSource.every((task) =>
        before.some(
          (previous) =>
            previous.id === task.id && previous.name === task.name && previous.status?.status === task.status?.status,
        ),
      );
  if (item.scenario.family === "create_task")
    correct = outputsMatch(destination, ["Prepare weekly review"]) && actualSource.length === 0;
  if (item.scenario.family === "rename_task")
    correct =
      destination.length === 0 &&
      actualSource.length === 1 &&
      actualSource[0]?.id === source?.id &&
      actualSource[0]?.name === "Final launch brief";
  if (item.scenario.family === "attach_existing") {
    correct =
      destination.length === 0 &&
      actualSource.length === 1 &&
      actualSource[0]?.id === source?.id &&
      actualSource[0]?.name === source?.name;
    const attached = Boolean(source && (await probe.attachmentMatches(source.id)));
    item.assertions.push({
      id: "attachment_bytes",
      label: "The correct file is attached to the existing task",
      status: attached ? "passed" : "failed",
      evidence:
        "Downloaded the attachment from the original task and compared its SHA-256 with the uploaded fixture; required exactly one attachment.",
    });
  }
  const untouched =
    (await probe.tasks(fixtures.second.id)).length === 0 && (await probe.tasks(fixtures.decoy.id)).length === 0;
  item.assertions.push({
    id: "provider_output",
    label: "Provider state matches the user's request",
    status: correct && untouched ? "passed" : "failed",
    evidence: `Independently read all four fixture lists. Source count: ${actualSource.length}; destination count: ${destination.length}. Verified object identity and fields; read-count cases also require completed managed reads of every fixture task by the evaluated conversation.`,
  });
  item.verdict = verdictFor(item.scenario.family, item.assertions);
}
