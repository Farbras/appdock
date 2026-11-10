import type { QueueTask } from "./types";
export interface FriendlyError {
  title: string;
  stage: string;
  action: string;
  remedy: "retry" | "source" | "diagnostics";
}
export function explainError(task: QueueTask): FriendlyError {
  const text = task.message.toLowerCase();
  const stage = task.failureStage || "Этап не сохранён в старой задаче";
  if (task.status === "cancelled")
    return {
      title: "Операция отменена",
      stage,
      action:
        "Отмена остановила загрузки и ожидающие задачи. Незавершённые части прямой загрузки удаляются; WinGet управляет собственным кэшем. Для нового запуска проверьте повторный план.",
      remedy: "retry",
    };
  const rules: [RegExp, string, string, FriendlyError["remedy"]][] = [
    [
      /0x80070070|os error 112|недостаточно места/,
      "Недостаточно свободного места",
      "Освободите место на диске загрузки и системном диске, затем проверьте повторный план.",
      "retry",
    ],
    [
      /0x800704c7|0x8a15010c|кодом 1223/,
      "Windows сообщила об отмене",
      "Установка отменена пользователем или отклонён запрос UAC. При повторе проверьте издателя и подтвердите штатный запрос Windows.",
      "retry",
    ],
    [
      /0x8a150011|хеш.*не совп|sha-256.*не совп/,
      "Проверка целостности не пройдена",
      "Файл не будет установлен. Проверьте официальный источник или повторите позже. Проверка хеша остаётся включённой.",
      "source",
    ],
    [
      /0x80072ee7|0x80072efd|0x80072ee2|сетевой сбой|ошибка скачивания|network error/,
      "Не удалось получить данные по сети",
      "Проверьте подключение, прокси и доступ к источнику. Частичный файл прямой загрузки сохраняется; повтор проверит возможность дозагрузки.",
      "retry",
    ],
    [
      /0x8a15000f|0x8a150012|0x8a150015|источник.*недоступ/,
      "Источник пакета недоступен",
      "Проверьте WinGet / App Installer и доступ к источнику. Повтор использует существующий механизм восстановления источника с ограничением повторов.",
      "retry",
    ],
    [
      /winget.*(не найден|не обнаружен)|os error 2.*winget/,
      "WinGet не найден",
      "Установите или восстановите App Installer из официального источника Microsoft, затем обновите диагностику.",
      "source",
    ],
    [
      /0x80070652|кодом 1618|друг.*установщик|ожидание установщика/,
      "Другой установщик ещё работает",
      "Дождитесь завершения установщика Windows и проверьте повторный план. AppDock не завершает чужие процессы.",
      "retry",
    ],
    [
      /зависимост|0x8a150103/,
      "Не выполнено условие зависимости",
      "Откройте связанную задачу зависимости, исправьте её результат и заново проверьте план.",
      "diagnostics",
    ],
    [
      /range|content-range|etag|загрузк.*заново/,
      "Дозагрузка не подтверждена сервером",
      "Сохранённые байты не объединены с другим файлом. Удалите незавершённые части кнопкой «Скачать заново», затем проверьте повтор.",
      "retry",
    ],
  ];
  const found = rules.find(([pattern]) => pattern.test(text));
  return found
    ? { title: found[1], action: found[2], remedy: found[3], stage }
    : {
        title: "Операцию не удалось завершить",
        stage,
        action:
          "Причина не подтверждена. Откройте технические подробности и диагностику; повтор начинается с нового плана.",
        remedy: "diagnostics",
      };
}
export const resultGroups = [
  "installed",
  "updated",
  "skipped",
  "errors",
  "attention",
] as const;
export type ResultGroup = (typeof resultGroups)[number];
export function inResultGroup(t: QueueTask, group: string) {
  if (group === "installed")
    return (
      t.installationOutcome === "installed" ||
      (!t.installationOutcome &&
        t.status === "installed" &&
        t.action === "install")
    );
  if (group === "updated") return t.installationOutcome === "updated";
  if (group === "skipped")
    return t.status === "current" || t.installationOutcome === "skipped";
  if (group === "errors") return ["error", "blocked"].includes(t.status);
  if (group === "attention")
    return (
      ["action-required", "reboot-required", "attention"].includes(t.status) ||
      (!!t.readiness && t.readiness.state !== "ready")
    );
  return false;
}
