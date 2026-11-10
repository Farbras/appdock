import { invoke, isTauri } from "@tauri-apps/api/core";
import { readStorage, safeWriteStorage } from "./storage";
import type { Product, Selection } from "./types";
export interface BackgroundPreferences {
  intervalHours: number;
  autostart: boolean;
  closeToTray: boolean;
  notifications: boolean;
  preventSleep: boolean;
  downloadLimitKib: number;
  demo: boolean;
  exclusions: string[];
  pins: Selection[];
}
export const backgroundDefaults: BackgroundPreferences = {
  intervalHours: 0,
  autostart: false,
  closeToTray: false,
  notifications: true,
  preventSleep: false,
  downloadLimitKib: 0,
  demo: false,
  exclusions: [],
  pins: [],
};
export interface BundleReport {
  folder: string;
  verified: boolean;
  compatible: boolean;
  requirements: string;
  packages: {
    appId: string;
    version: string;
    architecture: string;
    file: string;
  }[];
}
export interface OfflineSupport {
  appId: string;
  supported: boolean;
  version?: string;
  reason: string;
}
export interface TransferPreview {
  token: string;
  rows: {
    component: string;
    available: boolean;
    before: unknown;
    after: unknown;
    conflict: boolean;
    reason: string;
  }[];
  exclusions: string[];
}
const demoTransfer = {
  schemaVersion: 1,
  components: {
    "vscode-settings": { "editor.fontSize": 16 },
    git: { "core.autocrlf": "true" },
  },
  exclusions: ["ДЕМО: виртуальные настройки; реальные файлы не читаются"],
};
let demoPreview: TransferPreview | null = null;
const demoOfflineVersions: Record<string, string> = {
  python: "3.12.10",
  git: "2.49.0",
  vscode: "1.99.3",
};
export async function feature<T>(
  op: string,
  args: Record<string, unknown> = {},
  mode: "demo" | "live" = "live",
): Promise<T> {
  if (mode === "live" && isTauri())
    return invoke<T>("feature", { op, args, mode });
  if (mode === "live")
    throw new Error("Системная операция доступна только в настольной версии");
  let result: unknown;
  switch (op) {
    case "background-state":
      result = {
        preferences: readStorage("demo-background", {
          ...backgroundDefaults,
          demo: true,
        }),
        status: {},
        route: null,
      };
      break;
    case "save-background":
      safeWriteStorage("demo-background", args);
      result = args;
      break;
    case "choose-folder":
      result = "ДЕМО — виртуальная папка";
      break;
    case "offline-support":
      result = (args.items as Selection[]).map((s): OfflineSupport => {
        const version = demoOfflineVersions[s.appId];
        const supported =
          !!version &&
          !s.extensions.length &&
          s.action === "install" &&
          (!s.version || s.version === version);
        return {
          appId: s.appId,
          supported,
          version: supported ? version : undefined,
          reason: !version
            ? "ДЕМО: для этой программы нет подтверждённого полного автономного установщика и его зависимостей."
            : !supported
              ? "ДЕМО: поддерживается базовая установка версии автономного снимка без расширений."
              : "ДЕМО: автономный снимок; системная поддержка не проверяется",
        };
      });
      break;
    case "offline-create":
    case "offline-inspect":
      result = {
        folder: args.folder,
        verified: false,
        compatible: false,
        packages: (
          (args.items as Selection[] | undefined) || [{ appId: "python" }]
        ).map((s) => ({
          appId: s.appId,
          version: demoOfflineVersions[s.appId],
          architecture: "x64",
          file: "Демонстрационный установщик",
        })),
        requirements:
          "ДЕМО: виртуальный набор. Проверки реальных установщиков и SHA-256 не выполнялись.",
      };
      break;
    case "settings-export":
      result = demoTransfer;
      break;
    case "settings-preview": {
      const t = JSON.parse(String(args.text));
      if (
        t.schemaVersion !== 1 ||
        !t.components ||
        typeof t.components !== "object"
      )
        throw new Error("Неподдерживаемый формат переноса");
      demoPreview = {
        token: "demo",
        rows: Object.entries(t.components)
          .filter(([c]) =>
            [
              "vscode-settings",
              "git",
              "terminal",
              "vscode-keys",
              "vscode-extensions",
            ].includes(c),
          )
          .map(([component, after]) => ({
            component,
            after,
            before: { ДЕМО: "локальное значение" },
            available: true,
            conflict: true,
            reason: "ДЕМО: виртуальный конфликт",
          })),
        exclusions: [
          "Демонстрационный предпросмотр. Проверку безопасности импортируемого файла выполняет Rust в рабочем режиме.",
        ],
      };
      result = demoPreview;
      break;
    }
    case "settings-apply":
      if (!demoPreview) throw new Error("Сначала откройте предпросмотр");
      safeWriteStorage("demo-settings-backup", "demo-backup");
      result = {
        backupId: "demo-backup",
        extensions: [],
        message:
          "ДЕМО: изменения и резервная копия виртуальные; компьютер не изменён",
      };
      break;
    case "backups":
      result = readStorage<string | null>("demo-settings-backup", null)
        ? ["demo-backup"]
        : [];
      break;
    case "settings-restore":
      result = { message: "ДЕМО: виртуальная копия восстановлена" };
      break;
    case "catalog-snapshot":
      result = {
        status: {
          revision: 0,
          configured: false,
          checkedAt: null,
          limitations: "ДЕМО: встроенный каталог",
        },
      };
      break;
    case "readiness":
      result = {
        state: "unknown",
        reason: "ДЕМО: запуск CLI на компьютере не выполнялся",
        nextStep: "Проверка доступна в рабочем режиме",
        version: null,
        checkedAt: Date.now(),
        canLaunch: false,
      };
      break;
    default:
      throw new Error(
        "ДЕМО: эта операция не обращается к системе. Используйте рабочий режим для проверки интеграции.",
      );
  }
  return result as T;
}
export async function initializeCatalog(apps: Product[]) {
  if (!isTauri()) return;
  const snapshot = await feature<{ apps: Product[] }>("catalog-snapshot");
  if (!Array.isArray(snapshot.apps) || snapshot.apps.length !== apps.length)
    throw new Error("Ядро не предоставило согласованный каталог");
  apps.splice(0, apps.length, ...snapshot.apps);
}
