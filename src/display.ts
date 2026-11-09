import { categories, getApp, typeNames } from "./catalog";
import type { Product, Selection } from "./types";
export function formatBytes(value?: number | null) {
  if (value == null || !Number.isFinite(value) || value < 0)
    return "неизвестно";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const unit =
    value > 0
      ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
      : 0;
  const index = Math.max(0, unit);
  return `${(value / 1024 ** index).toLocaleString("ru-RU", { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`;
}
export function formatRemainingTime(value?: number | null) {
  if (value == null || !Number.isFinite(value) || value < 0)
    return "рассчитывается…";
  const seconds = Math.ceil(value);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `≈ ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return `≈ ${hours} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}`;
}
export const plural = (n: number, one: string, few: string, many: string) =>
  `${n} ${n % 100 >= 11 && n % 100 <= 14 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many}`;
export const programs = (n: number) =>
  plural(n, "программа", "программы", "программ");
export const taskCount = (n: number) => plural(n, "задача", "задачи", "задач");
export const extensionCountText = (n: number) =>
  plural(n, "расширение", "расширения", "расширений");
export const platformNames: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  ios: "iOS",
  web: "Веб",
};
export const scopeNames: Record<string, string> = {
  user: "Текущий пользователь",
  machine: "Все пользователи",
  default: "Определяет установщик",
};
export const modeNames: Record<string, string> = {
  demo: "Демонстрация",
  live: "Рабочий режим",
};
export const outcomeNames: Record<string, string> = {
  running: "Выполняется",
  completed: "Завершён",
  errors: "Есть ошибки",
  cancelled: "Есть отмены",
  "action-required": "Требуется участие",
  migrated: "Перенесено из предыдущей версии",
};
export const filterNames: Record<string, string> = {
  platform: "Платформа",
  status: "Состояние",
  category: "Категория",
  license: "Лицензия",
  type: "Тип",
  automation: "Действие",
  query: "Поиск",
};
export function filterValue(key: string, value: string) {
  const values: Record<string, Record<string, string>> = {
    platform: platformNames,
    type: typeNames,
    category: Object.fromEntries(categories.map((c) => [c.id, c.name])),
    status: {
      installed: "Установлено",
      missing: "Не установлено",
      update: "Есть обновление",
    },
    license: { free: "Бесплатное", paid: "Платное", trial: "Пробная версия" },
    automation: { auto: "Автоматическая", manual: "Требуется участие" },
  };
  return values[key]?.[value] || value;
}
export function optionLabel(app: Product, key: string) {
  return (
    app.options.find((o) => o.id === key)?.label ||
    (
      {
        edition: "Редакция",
        fullProfile: "Полный профиль Visual Studio",
      } as Record<string, string>
    )[key] ||
    "Дополнительный параметр"
  );
}
export function optionValue(
  app: Product,
  key: string,
  value: string | number | boolean,
) {
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (key === "scope")
    return scopeNames[String(value)] || "Определяет установщик";
  if (key === "edition")
    return app.editions.find((e) => e.id === value)?.name || "По умолчанию";
  return String(value);
}
export function selectionSummary(s: Selection) {
  const app = getApp(s.appId);
  return [
    s.version ? `Версия ${s.version}` : "Последняя доступная версия",
    ...Object.entries(s.options)
      .filter(([key]) => ["scope", "edition", "fullProfile"].includes(key))
      .map(
        ([key, v]) => `${optionLabel(app, key)}: ${optionValue(app, key, v)}`,
      ),
    s.extensions.length ? extensionCountText(s.extensions.length) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
