import metadata from "../package.json";
import { actionNames, statusNames } from "./catalog";
import type { QueueState } from "./types";
export const appVersion = metadata.version;
export function redactSensitive(text: string) {
  let result = text
    .replace(
      /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])[^\\/\s"']+/gi,
      "C:\\Users\\[СКРЫТО]",
    )
    .replace(
      /(?:password|secret|token|credential|пароль)(["'\s:=]+)[^,\s"'}]+/gi,
      "секрет$1[СКРЫТО]",
    );
  for (const key of ["USERNAME", "COMPUTERNAME"]) {
    const value =
      typeof process !== "undefined" ? process.env?.[key] : undefined;
    if (value && value.length > 2)
      result = result.split(value).join("[СКРЫТО]");
  }
  return result;
}
export function buildDiagnostics(q: QueueState, redact = true) {
  const obj = {
    schemaVersion: 2,
    appVersion,
    exportedAt: new Date().toISOString(),
    scope:
      "Состав программ и параметры AppDock. Пользовательские файлы и секреты не переносятся.",
    queue: q,
  };
  const hide = (value: unknown, key = ""): unknown => {
    if (
      /password|secret|token|credential|username|computername|пароль/i.test(key)
    )
      return "[СКРЫТО]";
    if (typeof value === "string") return redactSensitive(value);
    if (Array.isArray(value)) return value.map((v) => hide(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, hide(v, k)]),
      );
    return value;
  };
  return redact ? hide(obj) : obj;
}
export function readableReport(q: QueueState, redact = true) {
  let text = `AppDock ${appVersion}\nОтчёт: ${new Date().toLocaleString("ru-RU")}\n`;
  for (const run of q.runs || []) {
    text += `\nЗапуск ${run.id} · ${new Date(run.createdAt).toLocaleString("ru-RU")} · ${run.mode}\nПропуск актуальных: ${run.skipCurrent}; параллельных загрузок: ${run.parallelDownloads}\n`;
    text += `Итог: ${run.outcome}; завершение: ${run.finishedAt ? new Date(run.finishedAt).toLocaleString("ru-RU") : "не завершён"}; длительность: ${run.finishedAt ? Math.round((run.finishedAt - run.createdAt) / 1000) + " с" : "—"}\n`;
    for (const t of q.tasks.filter((t) => t.runId === run.id))
      text += `${t.name} · ${actionNames[t.action]} · ${statusNames[t.status]} · фактическая версия: ${t.actualVersion || "не подтверждена"}\n${t.message}\nНачало: ${t.startedAt ? new Date(t.startedAt).toLocaleString("ru-RU") : "—"}; завершение: ${t.finishedAt ? new Date(t.finishedAt).toLocaleString("ru-RU") : "—"}; версия плана: ${t.selection.version || "последняя доступная"}\n${JSON.stringify(t.selection.options)}\n${t.log.join("\n")}\n`;
  }
  return redact ? redactSensitive(text) : text;
}
