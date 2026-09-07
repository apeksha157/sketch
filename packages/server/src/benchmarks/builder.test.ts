import { describe, expect, it } from "vitest";
import { readBuilderTurn } from "./builder";

describe("production builder stream driver", () => {
  it("waits for a fully drained stream and preserves structured questions", async () => {
    let finished = false;
    const encoded = new TextEncoder();
    const chunks = [
      'data: {"type":"text-del',
      'ta","delta":"Hello"}\n\n',
      'data: {"type":"data-question","data":{"id":"q","prompt":"Which list?","options":[]}}\n\n',
      "data: [DONE]\n\n",
    ];
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          const next = chunks.shift();
          if (next) controller.enqueue(encoded.encode(next));
          else {
            finished = true;
            controller.close();
          }
        },
      }),
    );
    const result = await readBuilderTurn(response);
    expect(finished).toBe(true);
    expect(result).toEqual({ text: "Hello", question: { id: "q", prompt: "Which list?", options: [] } });
  });
  it("rejects a truncated stream even when the agent claims completion", async () => {
    await expect(readBuilderTurn(new Response('data: {"type":"text-delta","delta":"Done"}\n\n'))).rejects.toThrow(
      "completion marker",
    );
  });
  it("does not equate HTTP 200 or a completion claim with successful execution", async () => {
    await expect(
      readBuilderTurn(
        new Response('data: {"type":"text-delta","delta":"Done"}\n\ndata: {"type":"data-interruption"}\n\n'),
      ),
    ).rejects.toThrow("interrupted");
    await expect(readBuilderTurn(new Response("", { status: 409 }))).rejects.toThrow("409");
  });
});
