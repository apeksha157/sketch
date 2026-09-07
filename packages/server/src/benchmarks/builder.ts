import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BenchmarkRun, CaseResult } from "./contracts";
import type { createBenchmarkModel } from "./model";

export type OwnerRequest = (path: string, init?: RequestInit) => Promise<Response>;
export interface BuilderQuestion {
  id: string;
  prompt: string;
  options?: { id: string; label: string }[];
}
export interface BuilderTurn {
  providerReadTaskIds?: string[];
  text: string;
  question?: BuilderQuestion;
  batch?: { batchId: string; questions: BuilderQuestion[] };
}

/** Consume the production UI stream completely; an HTTP 200 is only the start of a builder turn. */
export async function readBuilderTurn(response: Response): Promise<BuilderTurn> {
  if (!response.ok) throw new Error(`The builder rejected the request (HTTP ${response.status}).`);
  if (!response.body) throw new Error("The builder did not return an event stream.");
  const result: BuilderTurn = { text: "" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  let failure = false;
  let completed = false;
  function line(value: string) {
    if (!value.startsWith("data: ")) return;
    if (value.slice(6).trim() === "[DONE]") {
      completed = true;
      return;
    }
    const event = JSON.parse(value.slice(6));
    if (event.type === "finish") completed = true;
    if (event.type === "text-delta" && typeof event.delta === "string") result.text += event.delta;
    if (event.type === "data-benchmark-read") {
      const ids = z.object({ taskIds: z.array(z.string().max(256)).max(1000) }).parse(event.data).taskIds;
      result.providerReadTaskIds = [...new Set([...(result.providerReadTaskIds ?? []), ...ids])].slice(0, 1000);
    }
    if (event.type === "data-question") result.question = event.data;
    if (event.type === "data-question-batch") result.batch = event.data;
    if (event.type === "error" || event.type === "data-interruption") failure = true;
  }
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 4_000_000) throw new Error("The builder transcript exceeded the benchmark limit.");
      buffer += decoder.decode(next.value, { stream: true });
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        line(buffer.slice(0, end).trimEnd());
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) line(buffer.trimEnd());
  } finally {
    if (!completed) await reader.cancel();
    reader.releaseLock();
  }
  if (failure) throw new Error("The builder was interrupted or reported an error. Inspect its conversation in Sketch.");
  if (!completed) throw new Error("The builder stream ended without a completion marker.");
  return result;
}

export async function ownerJson<T>(request: OwnerRequest, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Sketch could not complete the benchmark step (HTTP ${response.status}).`);
  }
  return response.json() as Promise<T>;
}

/** Direct capability cases use ordinary chat rather than the automation builder. */
export async function exerciseDirectChat(params: {
  request: OwnerRequest;
  item: CaseResult;
  model: ReturnType<typeof createBenchmarkModel>;
  manifest: BenchmarkRun["model"];
  prompt: string;
  facts: string[];
  attachments: unknown[];
  signal: AbortSignal;
  save: () => Promise<void>;
}): Promise<string> {
  const { item, request, signal, save } = params;
  item.conversationId = `benchmark-${randomUUID()}`;
  await save();
  let message: unknown = params.prompt;
  const interrupt = () =>
    ownerJson(request, `/api/web-chat/conversations/${item.conversationId}/interruptions`, "POST", {}).catch(
      () => undefined,
    );
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    for (let round = 0; round <= 3; round++) {
      signal.throwIfAborted();
      if ((await params.model.manifest()).fingerprint !== params.manifest.fingerprint)
        throw new Error("Sketch model settings changed during the benchmark.");
      if (typeof message === "string") item.conversation.push({ role: "user", text: message });
      await save();
      const turn = await readBuilderTurn(
        await request(`/api/web-chat?conversationId=${item.conversationId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, ...(round === 0 ? { attachments: params.attachments } : {}) }),
          signal,
        }),
      );
      item.providerReadTaskIds = [
        ...new Set([...(item.providerReadTaskIds ?? []), ...(turn.providerReadTaskIds ?? [])]),
      ].slice(0, 1000);
      item.conversation.push({ role: "assistant", text: turn.text.slice(0, 20_000) });
      const questions = turn.batch?.questions ?? (turn.question ? [turn.question] : []);
      await save();
      if (!questions.length) return turn.text;
      item.clarifications += questions.length;
      if (round === 3) throw new Error("The agent needed more than three clarification rounds.");
      const answers = [];
      for (const question of questions) {
        const text = `${question.prompt}\n${question.options?.map((option) => option.label).join("\n") ?? ""}`;
        item.conversation.push({ role: "assistant", text });
        const answer = await params.model.answer(text, params.facts, params.manifest, signal);
        if (answer.technical) item.technicalQuestions++;
        if (!answer.text) throw new Error("The agent asked for information outside the user's saved facts.");
        item.conversation.push({ role: "user", text: answer.text });
        answers.push({ questionId: question.id, customResponse: answer.text });
      }
      message = {
        role: "user",
        parts: [
          {
            type: turn.batch ? "data-question-batch-answer" : "data-question-answer",
            data: turn.batch ? { batchId: turn.batch.batchId, answers } : answers[0],
          },
        ],
      };
    }
    throw new Error("The direct agent did not complete its turn.");
  } catch (error) {
    await interrupt();
    throw error;
  } finally {
    signal.removeEventListener("abort", interrupt);
    if (signal.aborted) await interrupt();
  }
}

export async function exerciseBuilder(params: {
  request: OwnerRequest;
  item: CaseResult;
  model: ReturnType<typeof createBenchmarkModel>;
  manifest: BenchmarkRun["model"];
  prompt: string;
  facts: string[];
  attachments: unknown[];
  signal: AbortSignal;
  save: () => Promise<void>;
  createDraft: (automationId: string, conversationId: string) => Promise<void>;
}) {
  const { request, item, save, signal } = params;
  const draft = { automationId: randomUUID(), conversationId: `builder-${randomUUID()}` };
  const intent = { kind: "automation" as const, key: "builder", id: draft.automationId, state: "intent" as const };
  item.automationId = draft.automationId;
  item.conversationId = draft.conversationId;
  item.resources.push(intent);
  await save();
  await params.createDraft(draft.automationId, draft.conversationId);
  Object.assign(intent, { id: draft.automationId, state: "created" });
  await save();
  const clientSessionId = `benchmark-${randomUUID()}`;
  const lease = z
    .object({ lock: z.object({ generation: z.number() }) })
    .parse(await ownerJson(request, `/api/scheduled-tasks/${draft.automationId}/lock`, "POST", { clientSessionId }));
  const identity = { clientSessionId, generation: lease.lock.generation };
  await ownerJson(request, `/api/scheduled-tasks/${draft.automationId}/conversations/${draft.conversationId}`, "PUT", {
    kind: "builder",
    ...identity,
  });
  const interrupt = () =>
    ownerJson(
      request,
      `/api/web-chat/conversations/${draft.conversationId}/interruptions?automationTaskId=${draft.automationId}`,
      "POST",
      { automationTaskId: draft.automationId, ...identity },
    ).catch(() => undefined);
  signal.addEventListener("abort", interrupt, { once: true });
  let message: unknown = params.prompt;
  try {
    for (let round = 0; round <= 3; round++) {
      signal.throwIfAborted();
      if ((await params.model.manifest()).fingerprint !== params.manifest.fingerprint)
        throw new Error("Sketch model settings changed during the benchmark.");
      item.conversation.push({
        role: "user",
        text: typeof message === "string" ? message : "Answered using the scenario's saved user facts.",
      });
      await save();
      const response = await request(`/api/web-chat?conversationId=${draft.conversationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          automationTaskId: draft.automationId,
          ...identity,
          ...(round === 0 ? { attachments: params.attachments } : {}),
        }),
        signal,
      });
      const turn = await readBuilderTurn(response);
      item.providerReadTaskIds = [
        ...new Set([...(item.providerReadTaskIds ?? []), ...(turn.providerReadTaskIds ?? [])]),
      ].slice(0, 1000);
      item.conversation.push({ role: "assistant", text: turn.text.slice(0, 20_000) });
      await save();
      const questions = turn.batch?.questions ?? (turn.question ? [turn.question] : []);
      if (!questions.length) return;
      item.clarifications += questions.length;
      if (round === 3) throw new Error("The builder needed more than three clarification rounds.");
      const answers: { questionId: string; customResponse: string }[] = [];
      for (const question of questions) {
        const questionText = `${question.prompt}\n${question.options?.map((option) => option.label).join("\n") ?? ""}`;
        item.conversation.push({ role: "assistant", text: questionText });
        const answer = await params.model.answer(questionText, params.facts, params.manifest, signal);
        if (answer.technical) item.technicalQuestions++;
        if (!answer.text) {
          await save();
          throw new Error(
            answer.technical
              ? "The builder asked the user for technical implementation advice."
              : "The builder asked a question the scenario's user facts cannot answer.",
          );
        }
        item.conversation.push({ role: "user", text: answer.text });
        answers.push({ questionId: question.id, customResponse: answer.text });
      }
      message = {
        role: "user",
        parts: [
          {
            type: turn.batch ? "data-question-batch-answer" : "data-question-answer",
            data: turn.batch ? { batchId: turn.batch.batchId, answers } : answers[0],
          },
        ],
      };
    }
  } catch (error) {
    await interrupt();
    throw error;
  } finally {
    signal.removeEventListener("abort", interrupt);
    if (signal.aborted) await interrupt();
    await request(`/api/scheduled-tasks/${draft.automationId}/lock`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(identity),
    })
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  }
}
