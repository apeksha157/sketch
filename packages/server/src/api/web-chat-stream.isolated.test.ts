import { afterEach, expect, it, vi } from "vitest";
import { webChatUiStreamResponse } from "./web-chat";

afterEach(() => {
  vi.useRealTimers();
});

it("keeps an active stream alive with an SSE heartbeat", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const response = webChatUiStreamResponse(async (write) => {
    write({ type: "start" });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Expected a response body");

  await expect(reader.read()).resolves.toMatchObject({ done: false });
  const heartbeatRead = reader.read();
  await vi.advanceTimersByTimeAsync(15_000);
  const heartbeat = await heartbeatRead;
  expect(new TextDecoder().decode(heartbeat.value)).toBe(": keep-alive\n\n");

  finish();
  await expect(reader.read()).resolves.toMatchObject({ done: false });
  await expect(reader.read()).resolves.toMatchObject({ done: true });
});
