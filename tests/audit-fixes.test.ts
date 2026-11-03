import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { allowedActions, apps, defaultSelection, getApp } from "../src/catalog";
import {
  assertUniquePrograms,
  compareProfile,
  compareVersions,
  updateEligibility,
} from "../src/domain";
import { clearFinished, demoStages, expandTasks } from "../src/queue";
import { parsePreset, serializePreset } from "../src/storage";
import { programs, taskCount, filterValue, optionValue } from "../src/display";
import { coalesce, LatestRequest } from "../src/requests";
import type { InstalledApp, Preset, QueueState, Settings } from "../src/types";
const settings: Settings = {
  mode: "demo",
  theme: "dark",
  view: "grid",
  skipCurrent: true,
  parallelDownloads: 2,
};
const chrome = defaultSelection(getApp("chrome"));
const found = (version: string, availableVersion?: string): InstalledApp[] => [
  { packageId: getApp("chrome").install.packageId!, version, availableVersion },
];
beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("audit action preservation and uniqueness", () => {
  it("preserves every allowed catalog action through export, import, normalization and demo plan", async () => {
    const { api, normalizePresetItems } = await import("../src/api");
    for (const app of apps)
      for (const action of allowedActions(app)) {
        const s = { ...defaultSelection(app), action };
        const p: Preset = {
          id: "test",
          name: "Тест",
          description: "",
          icon: "Package",
          builtin: false,
          items: [s],
        };
        const items = normalizePresetItems(
          parsePreset(serializePreset(p)).items,
        );
        expect(items[0].action, app.id).toBe(action);
        const plan = await api.plan(items, settings);
        expect(plan.items[0].action).toBe(action);
        expect(plan.items[0].tasks).toHaveLength(1);
      }
  });
  it("rejects incompatible actions instead of changing the user's intent", () => {
    expect(() =>
      parsePreset(
        JSON.stringify({
          schemaVersion: 2,
          name: "Bad",
          items: [{ ...defaultSelection(getApp("word")), action: "install" }],
        }),
      ),
    ).toThrow("действие не поддерживается");
    expect(() =>
      parsePreset(
        JSON.stringify({
          schemaVersion: 2,
          name: "Bad",
          items: [{ ...chrome, action: "shortcut" }],
        }),
      ),
    ).toThrow();
  });
  it("defaults only an absent legacy action and retains an explicit web shortcut", () => {
    const legacy = { ...defaultSelection(getApp("word")) } as Record<
      string,
      unknown
    >;
    delete legacy.action;
    expect(
      parsePreset(
        JSON.stringify({ schemaVersion: 1, name: "Legacy", items: [legacy] }),
      ).items[0].action,
    ).toBe("download");
  });
  it("rejects duplicate products with a readable name at all entry points", async () => {
    const items = [chrome, { ...chrome, version: "100" }];
    expect(() => assertUniquePrograms(items)).toThrow("Google Chrome");
    expect(() => expandTasks(items)).toThrow("Повторяющаяся");
    const { api } = await import("../src/api");
    await expect(api.plan(items, settings)).rejects.toThrow("Google Chrome");
  });
});
describe("profile comparison drives both status and action", () => {
  it("plans a missing app and a numeric update, leaves matching pins untouched", () => {
    expect(compareProfile(chrome, [], false)).toMatchObject({
      status: "unchecked",
      next: undefined,
    });
    expect(compareProfile(chrome, [])).toMatchObject({
      status: "missing",
      next: chrome,
    });
    expect(compareProfile(chrome, found("100", "101"))).toMatchObject({
      status: "update",
      next: chrome,
    });
    const pin = { ...chrome, version: getApp("chrome").version };
    expect(compareProfile(pin, found(pin.version))).toMatchObject({
      status: "current",
      next: undefined,
    });
    expect(compareProfile(pin, found("100"))).toMatchObject({
      status: "update",
      next: pin,
    });
  });
  it("requires an explicit manual resolution for newer, unknown, stale and ambiguous versions", () => {
    const pin = { ...chrome, version: getApp("chrome").version };
    for (const installed of [
      found("9999"),
      found("Версия не указана в реестре"),
      [...found("100"), ...found("101")],
    ])
      expect(compareProfile(pin, installed)).toMatchObject({
        status: "manual",
        next: undefined,
      });
    expect(compareProfile({ ...pin, version: "99" }, [])).toMatchObject({
      status: "manual",
      next: undefined,
    });
    expect(compareProfile(chrome, found("101", "100"))).toMatchObject({
      status: "manual",
      next: undefined,
    });
    expect(compareProfile(chrome, found("unknown"))).toMatchObject({
      status: "manual",
      next: undefined,
    });
  });
  it("handles explicit downloads, instructions and web actions as actions rather than installed versions", () => {
    for (const id of ["word", "postgres", "google-docs"]) {
      const s = defaultSelection(getApp(id));
      expect(compareProfile(s, []).next).toEqual(s);
    }
  });
  it("compares padded numeric versions without guessing vendor strings", () => {
    expect(compareVersions("1.0", "1")).toBe(0);
    expect(compareVersions("10.1", "9.9")).toBe(1);
    expect(compareVersions("v1", "2")).toBeUndefined();
  });
});
describe("update eligibility", () => {
  it("uses unambiguous live instances, exclusions and pins", () => {
    const a = getApp("chrome");
    const installed = found("100", "101");
    expect(updateEligibility(a, installed).eligible).toBe(true);
    expect(
      updateEligibility(a, installed, undefined, false, undefined, false)
        .eligible,
    ).toBe(false);
    expect(updateEligibility(a, [...installed, ...installed]).eligible).toBe(
      false,
    );
    expect(
      updateEligibility(a, installed, { ...chrome, version: "100" }).eligible,
    ).toBe(false);
    expect(updateEligibility(a, installed, undefined, true).eligible).toBe(
      false,
    );
    expect(updateEligibility(a, []).eligible).toBe(false);
    expect(updateEligibility(a, found("101", "100")).eligible).toBe(false);
    expect(updateEligibility(a, found("unknown", "101")).eligible).toBe(false);
    expect(
      updateEligibility(a, installed, undefined, false, "removed-package")
        .eligible,
    ).toBe(false);
  });
});
describe("manual queue lifecycle", () => {
  it("retains outstanding user actions and their transitive dependencies while removing independent finished records", () => {
    const tasks = Array.from({ length: 7 }, () => expandTasks([chrome])[0]);
    tasks.forEach((t, i) => {
      t.id = String(i);
      t.runId = "run";
      t.status = "installed";
    });
    tasks[0].status = "action-required";
    tasks[0].dependencies = ["1"];
    tasks[1].dependencies = ["2"];
    tasks[3].status = "reboot-required";
    tasks[4].status = "attention";
    tasks[4].parentId = "5";
    const q: QueueState = {
      tasks,
      runs: [],
      running: false,
      paused: false,
      mode: "demo",
      updatedAt: 0,
    };
    clearFinished(q);
    expect(q.tasks.map((t) => t.id)).toEqual(["0", "1", "2", "3", "4", "5"]);
    q.tasks[0].status = "user-completed";
    q.tasks[3].status = "current";
    q.tasks[4].status = "cancelled";
    clearFinished(q);
    expect(q.tasks).toEqual([]);
  });
  it("imitates only stages applicable to each action", () => {
    expect(demoStages("guide")).toEqual(["checking"]);
    expect(demoStages("open")).toEqual(["checking"]);
    expect(demoStages("shortcut")).not.toContain("installing");
    expect(demoStages("download")).not.toContain("installing");
  });
});
describe("request races and display", () => {
  it("invalidates old results and coalesces concurrent read requests, allowing a later refresh", async () => {
    const gate = new LatestRequest(),
      old = gate.begin();
    expect(old()).toBe(true);
    const latest = gate.begin();
    expect(old()).toBe(false);
    expect(latest()).toBe(true);
    gate.invalidate();
    expect(latest()).toBe(false);
    let resolve!: (v: number) => void;
    const read = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const first = coalesce("scan-test", read),
      second = coalesce("scan-test", read);
    expect(first).toBe(second);
    expect(read).toHaveBeenCalledTimes(1);
    resolve(3);
    await first;
    const third = coalesce("scan-test", read);
    expect(read).toHaveBeenCalledTimes(2);
    resolve(4);
    expect(await third).toBe(4);
  });
  it("localizes filter chips, options and Russian counts", () => {
    expect([1, 2, 5, 11, 21, 22, 25].map(programs)).toEqual([
      "1 программа",
      "2 программы",
      "5 программ",
      "11 программ",
      "21 программа",
      "22 программы",
      "25 программ",
    ]);
    expect(taskCount(4)).toBe("4 задачи");
    expect(filterValue("platform", "windows")).toBe("Windows");
    expect(optionValue(getApp("chrome"), "scope", "machine")).toBe(
      "Все пользователи",
    );
  });
});
