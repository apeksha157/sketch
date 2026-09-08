import { afterEach, describe, expect, it, vi } from "vitest";
import { createActivityCatalog } from "./web-chat-activity-catalog";

afterEach(() => vi.useRealTimers());

describe("activity catalog", () => {
  it("deduplicates lookup and caps metadata without sharing accounts between runs", async () => {
    const listApps = vi.fn().mockResolvedValue({
      apps: Array.from({ length: 300 }, (_, i) => ({
        id: `app-${i}`,
        name: `App ${i}`,
        icon: "https://cdn.example.com/app.png",
        description: "unneeded",
      })),
    });
    const load = vi.fn().mockResolvedValue({ providerId: "canvas-1", listApps });
    const catalog = createActivityCatalog(load);
    const first = catalog();
    expect(catalog()).toBe(first);
    const result = await first;
    expect(result?.apps).toHaveLength(256);
    expect(result?.providerId).toBe("canvas-1");
    expect(result?.apps[0]).toEqual({
      id: "app-0",
      name: "App 0",
      icon: "https://cdn.example.com/app.png",
      description: "",
    });
    expect(listApps).toHaveBeenCalledWith(undefined, 256);
    await createActivityCatalog(load)();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("fails open when metadata is unavailable or slow", async () => {
    vi.useFakeTimers();
    const never = new Promise<null>(() => {});
    const request = createActivityCatalog(() => never)();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(request).resolves.toBeUndefined();
    await expect(createActivityCatalog(() => Promise.reject(new Error("offline")))()).resolves.toBeUndefined();
  });
});
