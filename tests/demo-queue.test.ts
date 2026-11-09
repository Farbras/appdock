import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { defaultSelection, getApp, extensions } from "../src/catalog";
import type { Settings, QueueState } from "../src/types";
const settings: Settings = {
  theme: "dark",
  mode: "demo",
  view: "grid",
  skipCurrent: true,
  parallelDownloads: 2,
};
const memory = new Map<string, string>();
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => memory.get(k) || null,
    setItem: (k: string, v: string) => memory.set(k, v),
    removeItem: (k: string) => memory.delete(k),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("demo queue orchestration", () => {
  it.each([
    ["word", "2024"],
    ["office-2021", "2021"],
    ["office-2019", "2019"],
    ["office-2016", "2016"],
  ])(
    "downloads %s with progress and a completed final snapshot",
    async (id, year) => {
      const { api } = await import("../src/api");
      const plan = await api.plan([defaultSelection(getApp(id))], settings);
      expect(plan.items[0]).toMatchObject({
        name: `Office ${year}`,
        action: "download",
        excluded: false,
        blocked: false,
      });
      await api.start(plan.token, "demo");
      await vi.advanceTimersByTimeAsync(700);
      const active = (await api.queue("demo")).tasks[0];
      expect(active.status).toBe("downloading");
      expect(active.percent).toBeGreaterThan(0);
      expect(active.percent).toBeLessThan(100);
      expect(active.downloadProgress?.remainingBytes).toBeGreaterThan(0);
      expect(active.downloadProgress?.bytesPerSecond).toBeGreaterThan(0);
      expect(active.downloadProgress?.remainingSeconds).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(5000);
      const queue = await api.queue("demo");
      expect(queue.tasks[0].status).toBe("downloaded");
      expect(queue.tasks[0].percent).toBe(100);
      expect(queue.tasks[0].downloadProgress?.remainingBytes).toBe(0);
      expect(queue.tasks[0].downloadProgress?.remainingSeconds).toBe(0);
      expect(queue.running).toBe(false);
    },
  );
  it("expires unconfirmed plans after ten minutes", async () => {
    const { api } = await import("../src/api");
    const p = await api.plan([defaultSelection(getApp("chrome"))], settings);
    await vi.advanceTimersByTimeAsync(600001);
    await expect(api.start(p.token, "demo")).rejects.toThrow("устарел");
  });
  it("expands the editor into dependency-ordered tasks and verifies the review token", async () => {
    const { api } = await import("../src/api");
    const plan = await api.plan(
      [
        {
          ...defaultSelection(getApp("vscode")),
          extensions: extensions.map((e) => e.id),
        },
      ],
      settings,
    );
    await expect(api.start("wrong", "demo")).rejects.toThrow("устарел");
    await api.start(plan.token, "demo");
    let q = await api.queue("demo");
    expect(q.tasks).toHaveLength(9);
    expect(q.tasks.slice(1).every((t) => t.parentId === q.tasks[0].id)).toBe(
      true,
    );
    await api.control("pause", "demo");
    await vi.advanceTimersByTimeAsync(3000);
    q = await api.queue("demo");
    expect(q.tasks.every((t) => t.status === "queued")).toBe(true);
    await api.control("resume", "demo");
    await vi.advanceTimersByTimeAsync(20000);
    q = await api.queue("demo");
    expect(q.running).toBe(false);
    expect(q.tasks.every((t) => t.status === "installed")).toBe(true);
  });
  it("continues independent tasks after a manual step and supports explicit retry", async () => {
    const { api } = await import("../src/api");
    const plan = await api.plan(
      [
        defaultSelection(getApp("postgres")),
        defaultSelection(getApp("chrome")),
      ],
      settings,
    );
    await api.start(plan.token, "demo");
    await vi.advanceTimersByTimeAsync(5000);
    let q = await api.queue("demo");
    expect(q.tasks.map((t) => t.status)).toEqual([
      "action-required",
      "installed",
    ]);
    await expect(api.control("retry", "demo", q.tasks[0].id)).rejects.toThrow(
      "плана",
    );
    const retry = await api.retryPlan(
      q.currentRunId!,
      "action-required",
      "demo",
      q.tasks[0].id,
    );
    expect(retry.items.flatMap((i) => i.tasks)).toHaveLength(1);
    await api.start(retry.token, "demo");
    q = await api.queue("demo");
    expect(q.tasks[0].status).toBe("action-required");
    expect(q.tasks[1].status).toBe("installed");
    expect(q.tasks[2].status).toBe("queued");
  });
  it("cancels only queued tasks and preserves completed history", async () => {
    const { api } = await import("../src/api");
    const plan = await api.plan(
      [defaultSelection(getApp("chrome")), defaultSelection(getApp("firefox"))],
      settings,
    );
    await api.start(plan.token, "demo");
    await api.control("cancel", "demo");
    await vi.advanceTimersByTimeAsync(500);
    const q = await api.queue("demo");
    expect(q.running).toBe(false);
    expect(q.tasks.every((t) => t.status === "cancelled")).toBe(true);
  });
  it("restores interrupted tasks paused and never silently resumes", async () => {
    const restored: QueueState = {
      tasks: [
        {
          id: "t",
          appId: "chrome",
          name: "Chrome",
          action: "install",
          status: "installing",
          message: "",
          log: [],
          percent: null,
          selection: defaultSelection(getApp("chrome")),
        },
      ],
      running: true,
      paused: false,
      mode: "demo",
      updatedAt: 1,
    };
    memory.set("appdock:demo-queue", JSON.stringify(restored));
    const { api } = await import("../src/api");
    const q = await api.queue("demo");
    expect(q.running).toBe(false);
    expect(q.paused).toBe(true);
    expect(q.tasks[0].status).toBe("queued");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await api.queue("demo")).tasks[0].status).toBe("queued");
  });
});
