import { api } from "./api";
import { defaultSelection, getApp } from "./catalog";
import { expandTasks } from "./queue";
import { readStorage, writeStorage } from "./storage";
import type {
  CustomApp,
  InstalledInstance,
  QueueTask,
  TroubleshootingReport,
} from "./types";

const initial: InstalledInstance[] = [
  {
    key: "demo-node",
    productCode: "{DEMO-NODE}",
    scope: "machine",
    name: "Node.js",
    version: "22.0.0",
    publisher: "OpenJS Foundation",
    msi: true,
    appId: "nodejs",
  },
  {
    key: "demo-python",
    productCode: "{DEMO-PYTHON}",
    scope: "user",
    name: "Python 3.12.10",
    version: "3.12.10",
    publisher: "Python Software Foundation",
    msi: true,
    appId: "python",
  },
  {
    key: "demo-git",
    productCode: "Git_is1",
    scope: "machine",
    name: "Git",
    version: "2.49.0",
    publisher: "The Git Development Community",
    msi: false,
    appId: "git",
  },
  {
    key: "demo-vscode",
    productCode: "{DEMO-CODE}",
    scope: "user",
    name: "Microsoft Visual Studio Code",
    version: "1.99.3",
    publisher: "Microsoft",
    msi: false,
    appId: "vscode",
  },
];
const rows = () => readStorage<InstalledInstance[]>("demo-instances", initial);
const customs = () => readStorage<CustomApp[]>("demo-custom-apps", []);
const make = (
  appId: string,
  name: string,
  action: QueueTask["action"],
  kind: string,
): QueueTask => ({
  id: crypto.randomUUID(),
  appId,
  name,
  action,
  operation: { kind },
  selection: getApp(appId)
    ? defaultSelection(getApp(appId))
    : { appId, action: "guide", options: {}, extensions: [] },
  status: "queued",
  message: "ДЕМО: просмотр согласованного действия",
  log: [],
  percent: null,
  dependencies: [],
});
export async function demoMaintenance(
  op: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (op) {
    case "installed-instances":
      return { instances: rows(), uninstallSupported: true };
    case "uninstall-prepare": {
      const tasks = (args.keys as string[]).map((key) => {
        const r = rows().find((r) => r.key === key);
        if (!r) throw new Error("Экземпляр больше не обнаружен");
        const t = make(
          r.appId || "windows-instance",
          r.name,
          "uninstall",
          "uninstall",
        );
        t.operation!.instance = r;
        t.actualVersion = r.version;
        t.message = `Удалить ${r.name} · ${r.version} · ${r.scope}`;
        t.log = [
          `Код продукта: ${r.productCode} · экземпляр ${r.key}`,
          "ДЕМО: штатное интерактивное удаление; окно мастера и UAC требуют участия. Зависимости сверх известных каталогу не определяются.",
        ];
        return t;
      });
      return api.demoOperationPlan(tasks, [
        "Остановка отменяет ожидающие действия. Работающий деинсталлятор завершится штатно.",
      ]);
    }
    case "troubleshoot": {
      const id = String(args.appId),
        fixed = readStorage<string[]>("demo-fixed", []).includes(id);
      const missing =
        !fixed && id === "vscode" ? (args.extensions as string[]) || [] : [];
      return {
        readiness: {
          state: fixed ? "ready" : "action",
          reason: fixed
            ? "ДЕМО: повторная диагностика подтвердила исправление"
            : "ДЕМО: программа запускается напрямую, но требует настройки",
          nextStep: "Просмотрите план исправления",
          version: "Демонстрационная",
          checkedAt: Date.now(),
          canLaunch: false,
        },
        checked: [
          "ДЕМО: исполняемый файл и ответ CLI о версии",
          "ДЕМО: актуальный PATH и выбранные расширения",
        ],
        problems: fixed
          ? []
          : id === "vscode"
            ? missing.length
              ? ["Отсутствуют выбранные расширения VS Code"]
              : []
            : ["Папка исполняемого файла отсутствует в PATH"],
        unknown: [
          "Реальные программы и настройки компьютера в деморежиме не проверяются",
        ],
        manual: [
          "Откройте новый терминал после изменения PATH.",
          "Параметры Windows → Приложения → Изменить / Восстановить.",
          "Конфликтующие установки проверяются вручную.",
        ],
        pathAvailable: !fixed && ["python", "git", "nodejs"].includes(id),
        path: "C:\\Demo\\Programs",
        repairAvailable: id === "python",
        missingExtensions: missing,
      } satisfies TroubleshootingReport;
    }
    case "fix-prepare": {
      const id = String(args.appId),
        fix = String(args.fix);
      if (!["recheck", "path", "repair", "extensions"].includes(fix))
        throw new Error("Исправление запрещено");
      const t = make(
        id,
        getApp(id)?.name || id,
        fix === "repair" ? "repair" : "fix",
        fix === "path"
          ? "path"
          : fix === "extensions"
            ? "extensions"
            : fix === "repair"
              ? "repair"
              : "recheck",
      );
      t.message = `ДЕМО: ${fix === "path" ? "добавить проверенную папку в пользовательский PATH" : fix === "repair" ? "штатное MSI-восстановление" : fix === "extensions" ? "обычная установка отсутствующих расширений" : "повторная проверка без установки"}`;
      t.log = [
        "ДЕМО: исходное значение сохраняется, остальные записи сохраняются.",
        "После выполнения повторяется диагностика. Системные команды не запускаются.",
      ];
      if (fix === "extensions") {
        const s = {
          ...defaultSelection(getApp("vscode")),
          extensions: args.extensions as string[],
        };
        if (!s.extensions?.length)
          throw new Error("Выберите отсутствующие расширения");
        const tasks = expandTasks([s]).filter((t) => t.action === "extension");
        const ids = tasks.map((t) => t.id);
        for (const task of tasks) {
          task.parentId = null;
          task.dependencies = task.dependencies?.filter((id) =>
            ids.includes(id),
          );
        }
        t.dependencies = ids;
        return api.demoOperationPlan(
          [...tasks, t],
          [
            "ДЕМО: обычные задачи выбранных расширений; сам VS Code не переустанавливается",
          ],
        );
      }
      return api.demoOperationPlan([t], []);
    }
    case "path-backups":
      return readStorage("demo-path-backups", []);
    case "path-restore-prepare":
      return api.demoOperationPlan(
        [make("python", "Отмена добавления в PATH", "fix", "path-restore")],
        [
          "ДЕМО: последующие правки сохраняются, неоднозначное восстановление запрещено",
        ],
      );
    case "custom-list":
      return customs();
    case "custom-add": {
      const existing = customs();
      if (existing.length) return existing[0];
      const entry: CustomApp = {
        id: `user:${crypto.randomUUID()}`,
        name: "Мой установщик",
        description: "Виртуальный пример EXE",
        icon: "Package",
        fileName: "MyInstaller.exe",
        source: "C:\\Demo\\MyInstaller.exe",
        size: 5242880,
        sha256: "d".repeat(64),
        kind: "exe",
        version: "1.0",
        publisher: null,
        signature: "unsigned",
        signatureDetail: "ДЕМО: подпись отсутствует; реальный файл не читался",
      };
      writeStorage("demo-custom-apps", [entry]);
      return entry;
    }
    case "custom-edit":
      writeStorage(
        "demo-custom-apps",
        customs().map((a) =>
          a.id === args.id
            ? {
                ...a,
                name: String(args.name),
                description: String(args.description),
                icon: String(args.icon),
              }
            : a,
        ),
      );
      return null;
    case "custom-remove":
      writeStorage(
        "demo-custom-apps",
        customs().filter((a) => a.id !== args.id),
      );
      return null;
    case "custom-prepare":
      return api.demoOperationPlan(
        (args.ids as string[]).map((id) => {
          const a = customs().find((a) => a.id === id);
          if (!a) throw new Error("Выберите локальный файл");
          const t = make(id, a.name, "custom-install", "custom");
          t.operation = { kind: "custom", id, sha256: a.sha256 };
          t.message =
            "Добавлено пользователем · оригинальный интерактивный EXE без тихих ключей";
          t.log = [
            `${a.fileName} · ${a.size} байт · ${a.source}`,
            `SHA-256: ${a.sha256}`,
            "Подпись отсутствует. Хеш не подтверждает доверие издателю.",
            "Завершение процесса не доказывает успешную установку.",
          ];
          return t;
        }),
        [],
      );
    case "custom-import-validate":
      return args.programs;
    default:
      throw new Error("Неизвестная демонстрационная операция");
  }
}
export function finishDemoOperation(t: QueueTask) {
  if (t.action === "uninstall") {
    writeStorage(
      "demo-instances",
      rows().filter((r) => r.key !== t.operation?.instance?.key),
    );
    t.status = "removed";
    t.evidence = "absent";
    t.installationOutcome = "uninstaller-completed";
    t.message =
      "ДЕМО: деинсталлятор завершён; отсутствие экземпляра подтверждено виртуальным обнаружением.";
  } else if (t.action === "custom-install") {
    t.status = "action-required";
    t.installationOutcome = "process-completed";
    t.message =
      "ДЕМО: процесс завершён; установка и готовность неизвестной программы не подтверждены.";
  } else {
    if (t.operation?.kind !== "recheck")
      writeStorage("demo-fixed", [
        ...new Set([...readStorage<string[]>("demo-fixed", []), t.appId]),
      ]);
    if (t.operation?.kind === "path")
      writeStorage("demo-path-backups", [
        {
          id: "demo-path",
          appId: t.appId,
          added: "C:\\Demo\\Programs",
          before: "C:\\Demo\\Existing",
        },
      ]);
    if (t.operation?.kind === "path-restore")
      writeStorage(
        "demo-fixed",
        readStorage<string[]>("demo-fixed", []).filter((id) => id !== t.appId),
      );
    const fixed = readStorage<string[]>("demo-fixed", []).includes(t.appId);
    t.status = fixed
      ? t.operation?.kind === "recheck"
        ? "checked"
        : "repaired"
      : "action-required";
    t.message = fixed
      ? "ДЕМО: повторная диагностика подтвердила готовность"
      : "ДЕМО: проверка повторена, проблема осталась";
    t.readiness = {
      state: fixed ? "ready" : "action",
      reason: t.message,
      nextStep: "Откройте мастер для подробностей",
      checkedAt: Date.now(),
      version: "Демо",
      canLaunch: false,
    };
  }
  t.log.push(t.message);
}
