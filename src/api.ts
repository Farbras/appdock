import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { defaultSelection, getApp, isWeb } from "./catalog";
import {
  beginRun,
  dependencyFailure,
  expandTasks,
  finishRun,
  migrateQueue,
  retrySelections,
  retryTasks,
  terminal,
} from "./queue";
import {
  downloadJson,
  readStorage,
  sanitizeSelection,
  writeStorage,
} from "./storage";
import type {
  DownloadInventory,
  InstalledApp,
  Plan,
  QueueState,
  QueueTask,
  Selection,
  Settings,
  SystemInfo,
  TaskStatus,
} from "./types";
export const native = isTauri();
export const emptyQueue: QueueState = {
  schemaVersion: 2,
  runs: [],
  currentRunId: null,
  tasks: [],
  running: false,
  paused: false,
  mode: "demo",
  updatedAt: 0,
};
const demoSystem: SystemInfo = {
  windows: true,
  arch: "x64",
  winget: null,
  freeDiskMb: null,
  virtualization: null,
  wsl: "Не проверено в деморежиме",
  hyperV: "Не проверено в деморежиме",
  admin: false,
  os: "Windows · демонстрация",
};
let demoQueue: QueueState;
try {
  demoQueue = migrateQueue(readStorage("demo-queue", emptyQueue));
} catch (e) {
  try {
    const raw = localStorage.getItem("appdock:demo-queue");
    if (raw)
      localStorage.setItem("appdock:backup:demo-queue:" + Date.now(), raw);
  } catch {
    /* Error remains visible in the queue notice. */
  }
  demoQueue = { ...emptyQueue, storageError: String(e) };
}
let pending: {
  createdAt: number;
  plan: Plan;
  tasks: QueueTask[];
  items: Selection[];
  settings: Settings;
} | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(q: QueueState) => void>();
const publish = () => listeners.forEach((fn) => fn(structuredClone(demoQueue)));
const persist = () => {
  demoQueue.updatedAt = Date.now();
  try {
    writeStorage("demo-queue", demoQueue);
    demoQueue.storageError = null;
  } catch (e) {
    demoQueue.storageError = String(e);
    demoQueue.paused = true;
  }
  publish();
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function runDemo() {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    if (!demoQueue.running || demoQueue.paused) return;
    const task = demoQueue.tasks.find(
      (t) => t.runId === demoQueue.currentRunId && t.status === "queued",
    );
    if (!task) {
      finishRun(demoQueue);
      persist();
      return;
    }
    const failure = dependencyFailure(task, demoQueue.tasks);
    if (failure) {
      task.status = "blocked";
      task.message = failure;
      task.finishedAt = Date.now();
      persist();
      runDemo();
      return;
    }
    task.startedAt = Date.now();
    for (const stage of ["checking", "downloading", "installing"] as const) {
      task.status = stage;
      task.lastActivityAt = Date.now();
      task.message = "Демонстрация этапа. Системные операции не выполняются.";
      task.log.push(`[ДЕМО] ${stage}`);
      persist();
      await wait(250);
    }
    task.status =
      task.action === "extension"
        ? "installed"
        : task.action === "download"
          ? "downloaded"
          : task.action === "open"
            ? "opened"
            : task.action === "shortcut"
              ? "shortcut-created"
              : task.action === "guide"
                ? "action-required"
                : "installed";
    task.message =
      task.status === "action-required"
        ? "Завершите шаги по официальной инструкции."
        : "Демонстрация завершена. Компьютер не изменён.";
    task.finishedAt = Date.now();
    persist();
    runDemo();
  }, 100);
}
export const api = {
  async subscribe(mode: Settings["mode"], fn: (q: QueueState) => void) {
    if (mode === "live" && native)
      return listen<QueueState>("queue-changed", (e) => fn(e.payload));
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  async system(mode: Settings["mode"]): Promise<SystemInfo> {
    return mode === "live" && native ? invoke("system_info") : demoSystem;
  },
  async scan(mode: Settings["mode"]): Promise<InstalledApp[]> {
    return mode === "live" && native ? invoke("scan_installed") : [];
  },
  async queue(mode: Settings["mode"]): Promise<QueueState> {
    return mode === "live" && native
      ? invoke("queue_snapshot")
      : structuredClone(demoQueue);
  },
  async plan(items: Selection[], settings: Settings): Promise<Plan> {
    if (settings.mode === "live" && native)
      return invoke("prepare_plan", {
        items,
        skipCurrent: settings.skipCurrent,
        parallelDownloads: settings.parallelDownloads,
      });
    if (demoQueue.running || demoQueue.tasks.some((t) => !terminal(t.status)))
      throw new Error("Сначала завершите или отмените сохранённую очередь");
    if (!items.length) throw new Error("Выберите программы");
    const clean = items.map((s) => sanitizeSelection(s, true));
    const tasks = expandTasks(clean);
    const plan: Plan = {
      token: crypto.randomUUID(),
      mode: "demo",
      system: demoSystem,
      warnings: [
        "Демонстрация: операции имитируются; сведения о компьютере не считываются.",
      ],
      items: clean.map((s) => {
        const a = getApp(s.appId);
        const excluded = s.action === "download" && !a.install.download;
        return {
          appId: s.appId,
          name: a.name,
          action: s.action,
          selection: s,
          tasks: tasks.filter((t) => t.appId === s.appId),
          excluded,
          expected: excluded ? "Пропуск: загрузка недоступна" : s.action,
          blocked: !!s.version && s.version !== a.version,
          warnings: [
            ...(excluded
              ? ["Загрузка недоступна. Программа останется выбранной."]
              : []),
            ...(s.version && s.version !== a.version
              ? [
                  "Закреплённая версия устарела. Выберите последнюю доступную в параметрах.",
                ]
              : []),
            ...(s.action === "guide"
              ? ["Требуется участие в официальном мастере"]
              : []),
          ],
        };
      }),
    };
    pending = {
      createdAt: Date.now(),
      plan,
      tasks,
      items: clean,
      settings: structuredClone(settings),
    };
    return plan;
  },
  async retryPlan(
    runId: string,
    status: TaskStatus,
    mode: Settings["mode"],
    taskId?: string,
    edited?: Selection | Selection[],
    includedAppIds?: string[],
  ): Promise<Plan> {
    if (mode === "live" && native)
      return invoke("prepare_retry", {
        runId,
        status,
        taskId: taskId ?? null,
        edits: Array.isArray(edited) ? edited : edited ? [edited] : [],
        includedAppIds: includedAppIds ?? null,
      });
    const chosen = retryTasks(demoQueue, runId, status, taskId).filter(
      (t) => !includedAppIds || includedAppIds.includes(t.appId),
    );
    if (!chosen.length)
      throw new Error("В выбранном запуске нет задач с этим статусом");
    const run = demoQueue.runs!.find((r) => r.id === runId)!;
    const edits = Array.isArray(edited) ? edited : edited ? [edited] : [];
    const items = retrySelections(demoQueue, runId, status, taskId)
      .filter((s) => !includedAppIds || includedAppIds.includes(s.appId))
      .map((s) => edits.find((e) => e.appId === s.appId) || s);
    const plan = await api.plan(items, { theme: "dark", view: "grid", ...run });
    const same = (a: QueueTask, b: QueueTask) =>
      a.appId === b.appId &&
      a.action === b.action &&
      (a.action !== "extension" ||
        a.selection.extensions[0] === b.selection.extensions[0]);
    const full = pending!.tasks;
    pending!.tasks = full.filter((t) => chosen.some((c) => same(t, c)));
    for (const t of pending!.tasks) {
      t.dependencies = (t.dependencies || []).map((id) => {
        if (pending!.tasks.some((t) => t.id === id)) return id;
        const template = full.find((t) => t.id === id)!;
        return (
          demoQueue.tasks.find((t) => t.runId === runId && same(t, template))
            ?.id || id
        );
      });
      if (t.parentId && !pending!.tasks.some((p) => p.id === t.parentId))
        t.parentId = demoQueue.tasks.find(
          (p) => p.runId === runId && p.appId === t.appId && !p.parentId,
        )?.id;
    }
    plan.items.forEach(
      (i) => (i.tasks = pending!.tasks.filter((t) => t.appId === i.appId)),
    );
    return plan;
  },
  async start(token: string, mode: Settings["mode"]) {
    if (mode === "live" && native) return invoke<void>("start_plan", { token });
    if (
      !pending ||
      pending.plan.token !== token ||
      Date.now() - pending.createdAt > 600_000
    )
      throw new Error("План устарел. Выполните проверку ещё раз.");
    if (pending.plan.items.some((i) => i.blocked) || !pending.tasks.length)
      throw new Error("Исправьте блокировки плана");
    demoQueue = beginRun(
      demoQueue,
      pending.tasks,
      pending.items,
      pending.settings,
    );
    persist();
    if (demoQueue.storageError) {
      demoQueue.running = false;
      throw new Error(demoQueue.storageError);
    }
    pending = null;
    runDemo();
  },
  async control(action: string, mode: Settings["mode"], taskId?: string) {
    if (mode === "live" && native)
      return invoke<void>("queue_control", { action, taskId: taskId ?? null });
    if (action === "retry") throw new Error("Повтор требует нового плана");
    if (action === "pause") demoQueue.paused = true;
    if (action === "resume") {
      demoQueue.paused = false;
      demoQueue.running = true;
      runDemo();
    }
    if (action === "cancel")
      for (const t of demoQueue.tasks.filter(
        (t) =>
          t.runId === demoQueue.currentRunId &&
          t.status === "queued" &&
          (!taskId || taskId === t.id),
      )) {
        t.status = "cancelled";
        t.finishedAt = Date.now();
        t.message =
          "Отменено пользователем. Работающий процесс не прерывается.";
      }
    if (action === "complete-manual") {
      const task = demoQueue.tasks.find(
        (t) => t.id === taskId && t.status === "action-required",
      );
      if (!task) throw new Error("Ручная задача не найдена");
      task.status = "user-completed";
      task.evidence = "user";
      task.message = "Пользователь отметил шаг; обнаружение не подтверждено";
      task.finishedAt = Date.now();
      if (
        demoQueue.tasks
          .filter((t) => t.runId === task.runId)
          .every((t) => terminal(t.status))
      )
        finishRun(demoQueue, task.runId);
    }
    if (action === "clear") {
      if (demoQueue.running) throw new Error("Сначала завершите очередь");
      const referenced = new Set(
        demoQueue.tasks
          .filter((t) => !terminal(t.status))
          .flatMap((t) => t.dependencies || []),
      );
      demoQueue.tasks = demoQueue.tasks.filter(
        (t) => !terminal(t.status) || referenced.has(t.id),
      );
      demoQueue.runs = demoQueue.runs?.filter((r) =>
        demoQueue.tasks.some((t) => t.runId === r.id),
      );
    }
    persist();
  },
  async verifyManual(taskId: string, mode: Settings["mode"]) {
    if (mode === "live" && native)
      return invoke<void>("verify_manual", { taskId });
    throw new Error(
      "Демо не подтверждает обнаружение. Можно отдельно отметить шаг выполненным.",
    );
  },
  async source(appId: string, index = 0) {
    if (native) return invoke<void>("open_source", { appId, index });
    const a = getApp(appId);
    window.open(a.sources[index] || a.website, "_blank", "noopener,noreferrer");
  },
  async openDownloads() {
    if (native) return invoke<void>("open_downloads");
    throw new Error("Папка загрузок доступна в настольном приложении");
  },
  async downloads(): Promise<DownloadInventory> {
    return native
      ? invoke("downloads_inventory")
      : {
          folder: "Доступно в настольном приложении",
          files: [],
          limitations: "Демонстрация не создаёт файлов.",
        };
  },
  async chooseDownloads(): Promise<string> {
    if (native) return invoke("choose_download_folder");
    throw new Error("Выбор папки доступен в настольном приложении");
  },
  async removeDownload(id: string) {
    if (native) return invoke<void>("remove_download", { id });
  },
  async saveReport(text: string, structured: boolean): Promise<string> {
    if (native) return invoke("save_report", { text, structured });
    downloadJson(`AppDock-report.${structured ? "json" : "txt"}`, text);
    return "Файл передан браузеру для сохранения";
  },
  async port(port: number): Promise<boolean> {
    if (native) return invoke("check_port", { port });
    throw new Error("Проверка порта доступна в настольном приложении");
  },
};
export function normalizePresetItems(items: Selection[]): Selection[] {
  return items.map((s) =>
    sanitizeSelection(
      {
        ...defaultSelection(getApp(s.appId)),
        ...s,
        action: isWeb(getApp(s.appId))
          ? "open"
          : getApp(s.appId).install.method === "manual"
            ? "guide"
            : s.action,
      },
      true,
    ),
  );
}
