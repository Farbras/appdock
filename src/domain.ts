import { allowedActions, getApp, installedInstances } from "./catalog";
import type { InstalledApp, Product, Selection } from "./types";

export function assertUniquePrograms(items: Pick<Selection, "appId">[]) {
  const seen = new Set<string>();
  for (const s of items) {
    if (seen.has(s.appId))
      throw new Error(
        `Повторяющаяся программа: ${getApp(s.appId)?.name || s.appId}. Удалите повтор и согласуйте параметры.`,
      );
    seen.add(s.appId);
  }
}

// Only unambiguous numeric versions may authorize an upgrade. Unknown and vendor
// version formats require a manual check; never infer a downgrade from strings.
export function compareVersions(a: string, b: string): number | undefined {
  if (!/^\d+(\.\d+)*$/.test(a) || !/^\d+(\.\d+)*$/.test(b)) return undefined;
  const aa = a.split(".").map(BigInt),
    bb = b.split(".").map(BigInt);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const av = aa[i] || 0n,
      bv = bb[i] || 0n;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

export function compareProfile(
  s: Selection,
  installed: InstalledApp[],
  checked = true,
) {
  const app = getApp(s.appId);
  const instances = installedInstances(app, installed, s);
  const found = instances[0];
  const manual = (reason: string) => ({
    status: "manual",
    label: "Требуется ручная проверка",
    reason,
    found,
    next: undefined as Selection | undefined,
  });
  const ready = (status: string, label: string) => ({
    status,
    label,
    reason: "",
    found,
    next: s,
  });
  const current = (label = "Соответствует") => ({
    status: "current",
    label,
    reason: "",
    found,
    next: undefined as Selection | undefined,
  });
  if (!checked)
    return {
      status: "unchecked",
      label: "Проверка ещё не выполнена",
      reason: "Выполните обнаружение перед сравнением профиля.",
      found: undefined,
      next: undefined as Selection | undefined,
    };
  if (s.version && s.version !== app.version)
    return manual(
      "Закреплённая версия не проверена каталогом. Измените её в редакторе профиля или выполните шаг вручную.",
    );
  if (s.action !== "install")
    return ready("action", "Запланировано: отдельное действие");
  if (!allowedActions(app).includes("install"))
    return manual(
      "Автоматическая установка не поддерживается. Откройте официальную инструкцию.",
    );
  if (instances.length > 1)
    return manual(
      "Обнаружено несколько экземпляров. Уточните редакцию и экземпляр перед изменениями.",
    );
  if (!found) return ready("missing", "Отсутствует");
  if (s.version) {
    if (s.version === found.version)
      return current("Закреплённая версия совпадает");
    const comparison = compareVersions(found.version, s.version);
    if (comparison === 0) return current("Закреплённая версия совпадает");
    if (comparison === -1)
      return ready("update", "Обновить до закреплённой версии");
    return manual(
      comparison === 1
        ? "Установлена более новая версия. Автоматическое понижение запрещено; измените закрепление или обратитесь к инструкции."
        : "Версия установлена, но её нельзя надёжно сравнить. Проверьте её вручную.",
    );
  }
  if (found.availableVersion) {
    const comparison = compareVersions(found.version, found.availableVersion);
    if (comparison === -1) return ready("update", "Доступно обновление");
    if (comparison === 0) return current();
    return manual(
      "Версии обновления требуют ручной проверки; понижение не выполняется.",
    );
  }
  if (compareVersions(found.version, found.version) === undefined)
    return manual("Версия неизвестна. Проверьте её по официальной инструкции.");
  return current();
}

export function updateEligibility(
  app: Product,
  installed: InstalledApp[],
  pin?: Selection,
  excluded = false,
  target?: string,
  checked = true,
) {
  const instances = installedInstances(app, installed);
  const found = target
    ? instances.find((i) => i.packageId.toLowerCase() === target.toLowerCase())
    : instances.length === 1
      ? instances[0]
      : undefined;
  const matches = found
    ? instances.filter(
        (i) => i.packageId.toLowerCase() === found.packageId.toLowerCase(),
      )
    : [];
  const reason = !checked
    ? "Обновления не проверены; дождитесь обнаружения или повторите проверку"
    : !allowedActions(app).includes("install")
      ? "Автоматическое обновление не поддерживается"
      : excluded
        ? "Исключено из обновлений"
        : pin?.version
          ? "Версия закреплена в профиле"
          : !found || matches.length !== 1
            ? "Выберите однозначную редакцию; несколько экземпляров требуют ручной проверки"
            : !found.availableVersion
              ? "Доступное обновление не обнаружено"
              : compareVersions(found.version, found.availableVersion) !== -1
                ? "Версии требуют ручной проверки; понижение запрещено"
                : "";
  return { eligible: !reason, reason, found };
}
