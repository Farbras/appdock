import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  apps,
  defaultSelection,
  filterApps,
  getApp,
  initialFilters,
  matchInstalled,
} from "../src/catalog";
import {
  beginRun,
  currentTasks,
  dependencyFailure,
  expandTasks,
  finishRun,
  migrateQueue,
  retryTasks,
} from "../src/queue";
import {
  parsePreset,
  serializePreset,
  selectionErrors,
  readStorage,
  writeStorage,
} from "../src/storage";
import { buildDiagnostics, readableReport } from "../src/diagnostics";
import type { QueueState, Settings } from "../src/types";
const settings: Settings = {
  theme: "dark",
  view: "grid",
  mode: "demo",
  skipCurrent: false,
  parallelDownloads: 3,
};
const empty = (): QueueState => ({
  tasks: [],
  runs: [],
  running: false,
  paused: false,
  mode: "demo",
  updatedAt: 1,
});
const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => memory.get(k) || null,
    setItem: (k: string, v: string) => memory.set(k, v),
  });
});
afterEach(() => vi.unstubAllGlobals());
describe("run isolation and dependencies", () => {
  it("rejects corrupt persisted run policy", () => {
    const q = beginRun(
      empty(),
      expandTasks([defaultSelection(getApp("chrome"))]),
      [],
      settings,
    );
    q.runs![0].parallelDownloads = 99;
    expect(() => migrateQueue(q)).toThrow("параметры запуска");
  });
  it("starts a new run at 0/N after a long history and preserves the run policy", () => {
    let q = empty();
    for (let i = 0; i < 110; i++) {
      q = beginRun(
        q,
        expandTasks([defaultSelection(getApp("chrome"))]),
        [defaultSelection(getApp("chrome"))],
        settings,
      );
      currentTasks(q)[0].status = "installed";
      finishRun(q);
    }
    q = beginRun(
      q,
      expandTasks([defaultSelection(getApp("firefox"))]),
      [defaultSelection(getApp("firefox"))],
      settings,
    );
    expect(q.tasks).toHaveLength(111);
    expect(currentTasks(q)).toHaveLength(1);
    expect(currentTasks(q)[0].status).toBe("queued");
    expect(q.runs!.at(-1)).toMatchObject({
      skipCurrent: false,
      parallelDownloads: 3,
    });
  });
  it("selects errors from exactly the chosen run without cancelled and manual tasks", () => {
    let q = beginRun(
      empty(),
      expandTasks(
        ["chrome", "firefox", "postgres"].map((id) =>
          defaultSelection(getApp(id)),
        ),
      ),
      [],
      settings,
    );
    const first = q.currentRunId!;
    q.tasks.forEach(
      (t, i) =>
        (t.status = (["error", "cancelled", "action-required"] as const)[i]),
    );
    finishRun(q);
    q = beginRun(
      q,
      expandTasks([defaultSelection(getApp("chrome"))]),
      [],
      settings,
    );
    currentTasks(q)[0].status = "error";
    finishRun(q);
    expect(retryTasks(q, first, "error").map((t) => t.appId)).toEqual([
      "chrome",
    ]);
    expect(retryTasks(q, first, "cancelled")).toHaveLength(1);
  });
  it("blocks Pylance after Python fails and allows independent tasks", () => {
    const tasks = expandTasks([
      defaultSelection(getApp("vscode")),
      defaultSelection(getApp("chrome")),
    ]);
    const root = tasks.find(
      (t) => t.action === "install" && t.appId === "vscode",
    )!;
    root.status = "installed";
    const python = tasks.find(
      (t) =>
        t.selection.extensions[0] === "ms-python.python" &&
        t.action === "extension",
    )!;
    python.status = "error";
    python.message = "Нет сети";
    const pylance = tasks.find(
      (t) => t.selection.extensions[0] === "ms-python.vscode-pylance",
    )!;
    expect(pylance.dependencies).toContain(python.id);
    expect(dependencyFailure(pylance, tasks)).toContain("Нет сети");
    expect(
      dependencyFailure(
        tasks.find((t) => t.appId === "chrome")!,
        tasks,
      ),
    ).toBeUndefined();
  });
  it("expands only downloadable positions of a mixed selection", () => {
    const selection = ["chrome", "postgres", "github"].map((id) => ({
      ...defaultSelection(getApp(id)),
      action: "download" as const,
    }));
    expect(expandTasks(selection).map((t) => t.appId)).toEqual(["chrome"]);
  });
  it("restores a versioned queue paused and preserves policy", () => {
    let q = beginRun(
      empty(),
      expandTasks([defaultSelection(getApp("chrome"))]),
      [defaultSelection(getApp("chrome"))],
      settings,
    );
    q.tasks[0].status = "installing";
    q = migrateQueue(q);
    expect(q).toMatchObject({ running: false, paused: true });
    expect(q.runs![0]).toMatchObject({
      skipCurrent: false,
      parallelDownloads: 3,
    });
    expect(q.tasks[0].status).toBe("queued");
  });
});
describe("discovery, imports and persistence", () => {
  it("matches manual appdock IDs in every status filter", () => {
    const records = [{ packageId: "appdock:postgres", version: "16" }];
    expect(
      filterApps(apps, { ...initialFilters, status: "installed" }, records).map(
        (a) => a.id,
      ),
    ).toEqual(["postgres"]);
    expect(
      filterApps(
        [getApp("postgres")],
        { ...initialFilters, status: "missing" },
        records,
      ),
    ).toHaveLength(0);
  });
  it("keeps VS editions distinct", () => {
    const a = getApp("visual-studio");
    const pro = {
      packageId: "Microsoft.VisualStudio.Professional",
      version: "18.0",
    };
    expect(
      matchInstalled(a, [pro], {
        ...defaultSelection(a),
        options: { edition: "community" },
      }),
    ).toBeUndefined();
    expect(
      matchInstalled(a, [pro], {
        ...defaultSelection(a),
        options: { edition: "professional" },
      }),
    ).toEqual(pro);
    expect(matchInstalled(a, [pro])).toEqual(pro);
  });
  it("repairs imported extension dependencies and explicitly reports stale pins", () => {
    const p = parsePreset(
      JSON.stringify({
        schemaVersion: 1,
        name: "Python",
        items: [
          {
            ...defaultSelection(getApp("vscode")),
            extensions: ["ms-python.vscode-pylance"],
            version: "0.0.1",
          },
        ],
      }),
    );
    expect(p.items[0].extensions).toContain("ms-python.python");
    expect(p.items[0].version).toBe("0.0.1");
    expect(p.issues).toHaveLength(2);
  });
  it("preserves latest policy on export and validates ports before save", () => {
    const item = defaultSelection(getApp("postgres"));
    expect(
      selectionErrors({ ...item, options: { ...item.options, port: 65536 } }),
    ).toContain("Порт: целое число от 1 до 65535");
    const text = serializePreset({
      id: "p",
      name: "p",
      description: "",
      items: [defaultSelection(getApp("chrome"))],
      builtin: false,
      icon: "Package",
    });
    expect(parsePreset(text).items[0].version).toBeUndefined();
  });
  it("recovers corrupted JSON with a backup and reports write denial", () => {
    memory.set("appdock:selection", "{broken");
    expect(readStorage("selection", [])).toEqual([]);
    expect(
      [...memory.keys()].some((k) => k.startsWith("appdock:backup:selection")),
    ).toBe(true);
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("disk full");
      },
    });
    expect(() => writeStorage("selection", [])).toThrow("сохранить");
  });
  it("validates stored settings and queue shapes", () => {
    memory.set(
      "appdock:settings",
      JSON.stringify({ parallelDownloads: 99, theme: "blue" }),
    );
    expect(readStorage("settings", { theme: "dark" })).toEqual({
      theme: "dark",
    });
    expect(() =>
      migrateQueue({ ...empty(), tasks: [{ appId: "unknown" } as never] }),
    ).toThrow("повреждена");
  });
  it("redacts structured diagnostic values while retaining valid JSON", () => {
    const q = beginRun(
      empty(),
      expandTasks([defaultSelection(getApp("chrome"))]),
      [],
      settings,
    );
    q.tasks[0].log = [
      "C:\\Users\\SensitiveName\\Documents\\report.txt",
      "password=secret-value",
    ];
    const text = JSON.stringify(buildDiagnostics(q));
    expect(text).not.toContain("SensitiveName");
    expect(text).not.toContain("secret-value");
    expect(readableReport(q)).toContain("Запуск");
  });
});
