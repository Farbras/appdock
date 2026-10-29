import appData from "../catalog/apps.json";
import extensionData from "../catalog/extensions.json";
import presetData from "../catalog/presets.json";
import type { InstalledApp, Preset, Product, Selection } from "./types";
export const apps = appData as Product[];
export const extensions = extensionData;
export const builtinPresets = presetData as Preset[];
export const categories = [
  { id: "all", name: "Все программы", icon: "LayoutGrid" },
  { id: "browsers", name: "Браузеры", icon: "Globe" },
  { id: "development", name: "Разработка", icon: "Code2" },
  { id: "virtualization", name: "Контейнеры и ВМ", icon: "Boxes" },
  { id: "productivity", name: "Проекты и задачи", icon: "KanbanSquare" },
  { id: "documents", name: "Документы и таблицы", icon: "FileText" },
  { id: "graphics", name: "Графика", icon: "Palette" },
  { id: "cad", name: "САПР и проектирование", icon: "Ruler" },
  { id: "databases", name: "Базы данных", icon: "Database" },
];
export const typeNames: Record<string, string> = {
  desktop: "Приложение",
  web: "Веб-сервис",
  cloud: "Облачный сервис",
  "developer-tool": "Инструмент",
  "database-server": "Сервер БД",
  container: "Контейнер",
  emulator: "Эмулятор",
};
export const statusNames: Record<string, string> = {
  queued: "В очереди",
  checking: "Проверка",
  downloading: "Скачивание",
  verifying: "Проверка файла",
  installing: "Установка",
  configuring: "Настройка",
  installed: "Установлено",
  current: "Уже установлено",
  "action-required": "Требуется действие",
  "reboot-required": "Требуется перезагрузка",
  error: "Ошибка",
  cancelled: "Отменено",
  downloaded: "Скачано",
  opened: "Сервис открыт",
  "shortcut-created": "Ярлык создан",
};
export const isWeb = (app: Product) => ["web", "cloud"].includes(app.type);
export const getApp = (id: string) => apps.find((a) => a.id === id)!;
export function defaultSelection(app: Product): Selection {
  return {
    appId: app.id,
    action: isWeb(app)
      ? "open"
      : !app.platforms.includes("windows") || app.install.method === "manual"
        ? "guide"
        : "install",
    options: Object.fromEntries(app.options.map((o) => [o.id, o.default])),
    extensions: app.id === "vscode" ? extensions.map((e) => e.id) : [],
  };
}
export function addExtension(ids: string[], id: string): string[] {
  const set = new Set(ids);
  const add = (key: string) => {
    if (set.has(key)) return;
    const ext = extensions.find((e) => e.id === key);
    if (!ext) return;
    set.add(key);
    ext.dependencies.forEach(add);
  };
  add(id);
  return [...set];
}
export function removeExtension(ids: string[], id: string): string[] {
  const removed = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of extensions) {
      if (!removed.has(e.id) && e.dependencies.some((d) => removed.has(d))) {
        removed.add(e.id);
        changed = true;
      }
    }
  }
  return ids.filter((e) => !removed.has(e));
}
export interface Filters {
  query: string;
  category: string;
  platform: string;
  status: string;
  license: string;
  type: string;
  automation: string;
}
export const initialFilters: Filters = {
  query: "",
  category: "all",
  platform: "windows",
  status: "all",
  license: "all",
  type: "all",
  automation: "all",
};
export function filterApps(
  products: Product[],
  f: Filters,
  installed: InstalledApp[],
): Product[] {
  const q = f.query.toLocaleLowerCase("ru").trim();
  return products.filter((a) => {
    const i = matchInstalled(a, installed);
    return (
      (!q ||
        [
          a.name,
          a.description,
          a.publisher,
          ...a.aliases,
          categories.find((c) => c.id === a.category)?.name,
        ]
          .join(" ")
          .toLocaleLowerCase("ru")
          .includes(q)) &&
      (f.category === "all" || a.category === f.category) &&
      (f.platform === "all" || a.platforms.includes(f.platform)) &&
      (f.status === "all" ||
        (f.status === "installed" && !!i) ||
        (f.status === "missing" && !i) ||
        (f.status === "update" && !!i?.availableVersion)) &&
      (f.license === "all" || a.license === f.license) &&
      (f.type === "all" || a.type === f.type) &&
      (f.automation === "all" ||
        (f.automation === "auto" &&
          a.install.method === "winget" &&
          a.install.verification === "verified") ||
        (f.automation === "manual" &&
          (a.install.method !== "winget" ||
            a.install.verification !== "verified")))
    );
  });
}

export function matchInstalled(
  app: Product,
  installed: InstalledApp[],
  selection?: Selection,
): InstalledApp | undefined {
  const edition = selection?.options.edition;
  const ids =
    edition && app.editions.some((e) => e.id === edition && e.packageId)
      ? app.editions.filter((e) => e.id === edition).map((e) => e.packageId!)
      : [
          app.install.packageId,
          app.detection.packageId,
          ...app.editions.map((e) => e.packageId),
          "appdock:" + app.id,
        ];
  return installed.find((i) =>
    ids.some((id) => id?.toLowerCase() === i.packageId.toLowerCase()),
  );
}
export const actionNames: Record<string, string> = {
  install: "Установка / обновление",
  download: "Скачивание",
  guide: "Ручные шаги",
  open: "Открытие сервиса",
  shortcut: "Веб-ярлык",
  extension: "Расширение",
};
Object.assign(statusNames, {
  blocked: "Заблокировано зависимостью",
  attention: "Требуется внимание",
  "user-completed": "Шаг отмечен пользователем",
});
export const extensionProfiles: Record<string, string[]> = {
  Базовый: ["streetsidesoftware.code-spell-checker"],
  Python: [
    "ms-python.python",
    "ms-python.vscode-pylance",
    "ms-python.debugpy",
    "ms-python.vscode-python-envs",
  ].filter((id) => extensions.some((e) => e.id === id)),
  Веб: ["Zignd.html-css-class-completion", "ritwickdey.LiveServer"].filter(
    (id) => extensions.some((e) => e.id === id),
  ),
  "Без расширений": [],
};

export function installedInstances(
  app: Product,
  installed: InstalledApp[],
  selection?: Selection,
) {
  return installed.filter((i) => !!matchInstalled(app, [i], selection));
}
