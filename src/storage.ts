import { z } from "zod";
import { addExtension, defaultSelection, extensions, getApp } from "./catalog";
import type { Preset, Selection, Settings } from "./types";
const issues: string[] = [];
export const storageIssues = () => [...issues];
function report(message: string) {
  issues.push(message);
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("appdock-storage-error", { detail: message }),
    );
}
export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`appdock:${key}`);
    if (!raw) return fallback;
    let value = JSON.parse(raw);
    if (value?.schemaVersion && "data" in value) {
      if (value.schemaVersion > 2) throw new Error("Новая версия схемы");
      value = value.data;
    }
    if (value == null) return fallback;
    if (key === "settings") return validateSettings(value) as T;
    if (key === "selection") {
      if (!Array.isArray(value)) throw new Error("Ожидается список программ");
      return value.map((s) =>
        sanitizeSelection(itemSchema.parse(s), true),
      ) as T;
    }
    if (
      ["favorites", "update-exclusions"].includes(key) &&
      (!Array.isArray(value) || value.some((id) => typeof id !== "string"))
    )
      throw new Error("Неверный список избранного");
    if (key === "presets") {
      if (!Array.isArray(value)) throw new Error("Неверный список наборов");
      return value.map((p) => ({
        ...parsePreset(JSON.stringify({ schemaVersion: 2, ...p })),
        id: String(p.id),
      })) as T;
    }
    return value as T;
  } catch (e) {
    try {
      const raw = localStorage.getItem(`appdock:${key}`);
      if (raw) localStorage.setItem(`appdock:backup:${key}:${Date.now()}`, raw);
    } catch {
      /* Storage may be unavailable. */
    }
    report(
      `Не удалось прочитать «${key}»: ${String(e)}. Используются значения по умолчанию; исходные данные по возможности сохранены в резервной копии.`,
    );
    return fallback;
  }
}
export function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(
      `appdock:${key}`,
      JSON.stringify({ schemaVersion: 2, data: value }),
    );
  } catch (e) {
    const message = `Не удалось сохранить «${key}»: ${String(e)}. Проверьте свободное место и доступ к данным; изменения пока хранятся в памяти.`;
    report(message);
    throw new Error(message);
  }
}
export function safeWriteStorage(key: string, value: unknown) {
  try {
    writeStorage(key, value);
  } catch {
    /* Displayed through the persistent storage notice. */
  }
}
export function validateSettings(value: unknown): Settings {
  return z
    .object({
      theme: z.enum(["dark", "light", "system"]).default("dark"),
      mode: z.enum(["demo", "live"]).default("demo"),
      view: z.enum(["grid", "list"]).default("grid"),
      skipCurrent: z.boolean().default(true),
      parallelDownloads: z.number().int().min(1).max(3).default(2),
    })
    .parse(value);
}
export const itemSchema = z.object({
  appId: z.string().max(80),
  action: z.enum(["install", "download", "open", "shortcut", "guide"]),
  options: z.record(
    z.string(),
    z.union([z.string().max(500), z.number().finite(), z.boolean()]),
  ),
  extensions: z.array(z.string()).max(30),
  version: z.string().max(40).optional(),
});
const presetSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).default("Импортированный набор"),
  items: z.array(itemSchema).min(1).max(100),
});
export function selectionErrors(s: Selection): string[] {
  const app = getApp(s.appId);
  if (!app) return ["Программа отсутствует в доверенном каталоге"];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(s.options)) {
    const option = app.options.find((o) => o.id === key);
    if (!option) continue;
    if (typeof value !== typeof option.default)
      errors.push(`${option.label}: неверный тип`);
    if (option.values && !option.values.includes(String(value)))
      errors.push(`${option.label}: выберите значение из списка`);
    if (
      option.type === "number" &&
      (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535)
    )
      errors.push(`${option.label}: целое число от 1 до 65535`);
    if (
      typeof value === "string" &&
      (value.length > 500 || /[\r\n\0]/.test(value))
    )
      errors.push(`${option.label}: недопустимые символы или длина`);
  }
  return errors;
}
export function sanitizeSelection(
  s: Selection,
  allowUnsupportedDownload = false,
): Selection {
  const app = getApp(s.appId);
  if (!app)
    throw new Error(
      `Неизвестная программа: ${s.appId}. Удалите её из файла или добавьте поддерживаемый продукт.`,
    );
  const options = { ...defaultSelection(app).options };
  for (const [key, value] of Object.entries(s.options)) {
    const option = app.options.find((o) => o.id === key);
    if (option && !/password|secret|token|credential/i.test(key))
      options[key] = value;
  }
  if (s.options.edition) {
    if (!app.editions.some((e) => e.id === s.options.edition))
      throw new Error("Неизвестная редакция");
    options.edition = s.options.edition;
  }
  if (app.id === "visual-studio" && typeof s.options.fullProfile === "boolean")
    options.fullProfile = s.options.fullProfile;
  if (s.extensions.some((id) => !extensions.some((e) => e.id === id)))
    throw new Error(
      "Расширение отсутствует в доверенном каталоге. Удалите его из файла.",
    );
  const clean = {
    ...s,
    options,
    extensions:
      app.id === "vscode"
        ? s.extensions.reduce(
            (ids, id) => addExtension(ids, id),
            [] as string[],
          )
        : [],
  };
  const errors = selectionErrors(clean);
  if (errors.length) throw new Error(errors.join("; "));
  if (
    clean.action === "download" &&
    !app.install.download &&
    !allowUnsupportedDownload
  )
    throw new Error("Загрузка продукта не поддерживается");
  return clean;
}
export function parsePreset(text: string): Preset {
  if (text.length > 200_000)
    throw new Error("Размер набора не должен превышать 200 КБ");
  const p = presetSchema.parse(JSON.parse(text));
  const seen = new Set<string>();
  const warnings: string[] = [];
  const items = p.items.map((s) => {
    const clean = sanitizeSelection(s);
    if (clean.extensions.length !== s.extensions.length)
      warnings.push(
        `${getApp(s.appId).name}: добавлены зависимости расширений`,
      );
    if (s.version && s.version !== getApp(s.appId).version)
      warnings.push(
        `${getApp(s.appId).name}: закреплена устаревшая версия ${s.version}. Выберите последнюю доступную перед запуском.`,
      );
    return clean;
  });
  for (const i of items) {
    if (seen.has(i.appId))
      throw new Error("В наборе есть повторяющиеся программы");
    seen.add(i.appId);
  }
  return {
    id: crypto.randomUUID(),
    name: p.name,
    description: p.description,
    items,
    icon: "Package",
    builtin: false,
    issues: warnings,
  };
}
export function serializePreset(p: Preset) {
  return JSON.stringify(
    {
      schemaVersion: 2,
      name: p.name,
      description: p.description,
      items: p.items.map((s) => sanitizeSelection(s)),
    },
    null,
    2,
  );
}
export function downloadJson(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], {
      type: name.endsWith(".txt")
        ? "text/plain;charset=utf-8"
        : "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
