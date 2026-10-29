import { defaultSelection, extensions, getApp } from "./catalog";
import type {
  QueueState,
  QueueTask,
  Run,
  Selection,
  Settings,
  TaskStatus,
} from "./types";
import { sanitizeSelection } from "./storage";
export const terminal = (status: string) =>
  [
    "installed",
    "current",
    "error",
    "cancelled",
    "action-required",
    "reboot-required",
    "downloaded",
    "opened",
    "shortcut-created",
    "blocked",
    "user-completed",
  ].includes(status);
export const success = (status: string) =>
  [
    "installed",
    "current",
    "reboot-required",
    "downloaded",
    "opened",
    "shortcut-created",
  ].includes(status);
export function currentTasks(queue: QueueState) {
  return queue.tasks.filter((t) => t.runId === queue.currentRunId);
}
export function migrateQueue(value: QueueState): QueueState {
  if (
    !value ||
    !Array.isArray(value.tasks) ||
    value.tasks.length > 20000 ||
    (value.schemaVersion || 1) > 2 ||
    value.tasks.some(
      (t) =>
        !getApp(t.appId) ||
        !t.selection ||
        !Array.isArray(t.log) ||
        !t.id ||
        (!terminal(t.status) &&
          ![
            "queued",
            "checking",
            "downloading",
            "verifying",
            "installing",
            "configuring",
            "attention",
          ].includes(t.status)),
    )
  )
    throw new Error(
      "Сохранённая очередь повреждена. Восстановите резервную копию или очистите данные очереди.",
    );
  if (
    typeof value.running !== "boolean" ||
    typeof value.paused !== "boolean" ||
    !["demo", "live"].includes(value.mode) ||
    !Number.isFinite(value.updatedAt)
  )
    throw new Error("Сохранённая очередь повреждена");
  const q = structuredClone(value);
  q.schemaVersion = 2;
  q.runs ||= [];
  if (
    !Array.isArray(q.runs) ||
    q.runs.some(
      (r) =>
        !r ||
        typeof r.id !== "string" ||
        !Number.isFinite(r.createdAt) ||
        !["demo", "live"].includes(r.mode) ||
        typeof r.skipCurrent !== "boolean" ||
        !Number.isInteger(r.parallelDownloads) ||
        r.parallelDownloads < 1 ||
        r.parallelDownloads > 3 ||
        !Array.isArray(r.selections),
    )
  )
    throw new Error("Сохранённые параметры запуска повреждены");
  for (const run of q.runs)
    for (const s of run.selections) sanitizeSelection(s, true);
  if (
    q.runs.length &&
    q.tasks.some((t) => !q.runs!.some((r) => r.id === t.runId))
  )
    throw new Error("Не найдена запись запуска для задачи");
  if (q.tasks.length && !q.runs.length) {
    const id = crypto.randomUUID();
    q.currentRunId = id;
    q.tasks.forEach((t) => (t.runId = id));
    q.runs.push({
      id,
      createdAt: q.updatedAt,
      mode: q.mode,
      skipCurrent: true,
      parallelDownloads: 2,
      selections: q.tasks.filter((t) => !t.parentId).map((t) => t.selection),
      outcome: "migrated",
    });
  }
  for (const task of q.tasks) {
    task.dependencies ||= [];
    if (task.parentId && !task.dependencies.includes(task.parentId))
      task.dependencies.push(task.parentId);
    if (task.action === "extension")
      for (const dep of extensions.find(
        (e) => e.id === task.selection.extensions[0],
      )?.dependencies || []) {
        const found = q.tasks.find(
          (t) =>
            t.runId === task.runId &&
            t.action === "extension" &&
            t.selection.extensions.includes(dep),
        );
        if (found && !task.dependencies.includes(found.id))
          task.dependencies.push(found.id);
      }
  }
  if (q.running || q.tasks.some((t) => !terminal(t.status))) {
    q.running = false;
    q.paused = true;
    for (const t of q.tasks)
      if (!terminal(t.status)) {
        t.status = "queued";
        t.message =
          "Восстановлено. Состояние будет проверено перед продолжением.";
      }
  }
  return q;
}
export function expandTasks(items: Selection[]): QueueTask[] {
  const tasks: QueueTask[] = [];
  for (const selection of items) {
    const a = getApp(selection.appId);
    if (selection.action === "download" && !a.install.download) continue;
    const id = crypto.randomUUID();
    const root: QueueTask = {
      id,
      appId: a.id,
      name: a.name,
      action: selection.action,
      status: "queued",
      message: "Ожидает проверки",
      log: [],
      percent: null,
      selection: structuredClone(selection),
      dependencies: [],
      lastActivityAt: Date.now(),
    };
    tasks.push(root);
    if (a.id === "vscode" && selection.action === "install")
      for (const ext of extensions.filter((e) =>
        selection.extensions.includes(e.id),
      ))
        tasks.push({
          ...structuredClone(root),
          id: crypto.randomUUID(),
          name: ext.name,
          action: "extension",
          parentId: id,
          dependencies: [id],
          selection: { ...structuredClone(selection), extensions: [ext.id] },
        });
  }
  for (const t of tasks) {
    for (const dep of getApp(t.appId).dependencies) {
      const found = tasks.find((o) => o.appId === dep && !o.parentId);
      if (found) t.dependencies!.push(found.id);
    }
    if (t.action === "extension")
      for (const dep of extensions.find(
        (e) => e.id === t.selection.extensions[0],
      )?.dependencies || []) {
        const found = tasks.find(
          (o) =>
            o.action === "extension" && o.selection.extensions.includes(dep),
        );
        if (found) t.dependencies!.push(found.id);
      }
  }
  const sorted: QueueTask[] = [];
  while (tasks.length) {
    const index = tasks.findIndex((t) =>
      t.dependencies!.every((d) => sorted.some((o) => o.id === d)),
    );
    if (index < 0) throw new Error("Цикл или отсутствующая зависимость");
    sorted.push(tasks.splice(index, 1)[0]);
  }
  return sorted;
}
export function dependencyFailure(
  task: QueueTask,
  tasks: QueueTask[],
): string | undefined {
  for (const id of task.dependencies || []) {
    const original = tasks.find((t) => t.id === id);
    const dep =
      original && original.runId !== task.runId
        ? [...tasks]
            .reverse()
            .find(
              (t) =>
                t.appId === original.appId &&
                t.action === original.action &&
                t.selection.options.edition ===
                  original.selection.options.edition &&
                (t.action !== "extension" ||
                  t.selection.extensions[0] ===
                    original.selection.extensions[0]),
            ) || original
        : original;
    if (
      !dep ||
      !["installed", "current", "reboot-required"].includes(dep.status)
    )
      return `Зависимость «${dep?.name || id}» не готова: ${dep?.message || "задача отсутствует"}. Исправьте зависимость и проверьте новый план.`;
  }
}
export function beginRun(
  q: QueueState,
  tasks: QueueTask[],
  items: Selection[],
  settings: Settings,
): QueueState {
  if (q.running || q.tasks.some((t) => !terminal(t.status)))
    throw new Error("Сначала завершите или отмените сохранённую очередь");
  const run: Run = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    mode: settings.mode,
    skipCurrent: settings.skipCurrent,
    parallelDownloads: settings.parallelDownloads,
    selections: structuredClone(items),
    outcome: "running",
  };
  return {
    ...q,
    tasks: [
      ...q.tasks,
      ...tasks.map((t) => ({ ...structuredClone(t), runId: run.id })),
    ],
    runs: [...(q.runs || []), run],
    currentRunId: run.id,
    running: true,
    paused: false,
    updatedAt: Date.now(),
  };
}
export function retryTasks(
  q: QueueState,
  runId: string,
  status: TaskStatus,
  taskId?: string,
) {
  return q.tasks.filter(
    (t) =>
      t.runId === runId && t.status === status && (!taskId || t.id === taskId),
  );
}
export function retrySelections(
  q: QueueState,
  runId: string,
  status: TaskStatus,
  taskId?: string,
): Selection[] {
  const chosen = retryTasks(q, runId, status, taskId);
  const run = q.runs?.find((r) => r.id === runId);
  return (
    run?.selections ||
    chosen.map((t) => ({
      ...defaultSelection(getApp(t.appId)),
      ...t.selection,
    }))
  ).filter((s) => chosen.some((t) => t.appId === s.appId));
}
export function finishRun(q: QueueState, runId = q.currentRunId) {
  const tasks = q.tasks.filter((t) => t.runId === runId);
  const run = q.runs?.find((r) => r.id === runId);
  if (runId === q.currentRunId) q.running = false;
  if (run) {
    run.finishedAt = Date.now();
    run.outcome = tasks.some((t) => ["error", "blocked"].includes(t.status))
      ? "errors"
      : tasks.some((t) => t.status === "action-required")
        ? "action-required"
        : tasks.some((t) => t.status === "cancelled")
          ? "cancelled"
          : "completed";
  }
}
