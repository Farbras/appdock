import { useEffect, useState } from "react";
import { feature } from "../feature-api";
import { Icon, Modal } from "../components/ui";
import type {
  CustomApp,
  InstalledInstance,
  Plan,
  Preset,
  Settings,
} from "../types";
export const signatureNames = {
  valid: "Подпись подтверждена",
  unsigned: "Подпись отсутствует",
  invalid: "Подпись недействительна",
  unknown: "Проверку подписи выполнить не удалось",
};
type Common = {
  mode: Settings["mode"];
  running: boolean;
  onPlan: (p: Plan) => void;
  notify: (s: string) => void;
};
export function InstalledScreen({
  mode,
  running,
  onPlan,
  onTroubleshoot,
  revision,
}: {
  onTroubleshoot: (id: string, key?: string, name?: string) => void;
  revision: number;
} & Common) {
  const [rows, setRows] = useState<InstalledInstance[]>([]),
    [chosen, setChosen] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [supported, setSupported] = useState(false),
    [query, setQuery] = useState("");
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await feature<{
        instances: InstalledInstance[];
        uninstallSupported: boolean;
      }>("installed-instances", {}, mode);
      setRows(r.instances);
      setSupported(r.uninstallSupported);
      setChosen((c) => c.filter((k) => r.instances.some((i) => i.key === k)));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!running) void refresh();
  }, [mode, running, revision]);
  const review = async () => {
    setBusy(true);
    setError("");
    try {
      onPlan(await feature<Plan>("uninstall-prepare", { keys: chosen }, mode));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="section-tools wrap">
        <input
          aria-label="Поиск установленных программ"
          placeholder="Название, версия или издатель"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className="button secondary"
          disabled={busy || running}
          onClick={() => void refresh()}
        >
          Обновить экземпляры
        </button>
        <button
          className="button primary"
          disabled={busy || running || !chosen.length || !supported}
          onClick={() => void review()}
        >
          Удалить выбранные ({chosen.length})
        </button>
      </div>
      <p className="inline-note">
        Выберите конкретные экземпляры. Перед удалением AppDock покажет план.
        Уже запущенный деинсталлятор не прерывается. Настройки и оставшиеся
        папки AppDock не очищает.
      </p>
      {!supported && !busy && (
        <p className="warning-text">
          Точные фильтры удаления WinGet недоступны. Обновите App Installer или
          используйте Параметры Windows → Приложения.
        </p>
      )}
      {error && (
        <p className="warning-text" role="alert">
          {error}
        </p>
      )}
      {busy && <p role="status">Проверяем…</p>}
      <div className="workflow-list">
        {rows
          .filter((r) =>
            `${r.name} ${r.version} ${r.publisher}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((r) => {
            const ambiguous =
              rows.filter(
                (i) =>
                  i.productCode.toLowerCase() === r.productCode.toLowerCase() &&
                  i.scope === r.scope,
              ).length !== 1;
            const blocked = ambiguous || !r.version || !r.productCode;
            return (
              <article key={r.key}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    aria-label={`Выбрать для удаления ${r.name} ${r.version} ${r.scope}`}
                    disabled={blocked || running}
                    checked={chosen.includes(r.key)}
                    onChange={(e) =>
                      setChosen((c) =>
                        e.target.checked
                          ? [...c, r.key]
                          : c.filter((k) => k !== r.key),
                      )
                    }
                  />
                  <h3>{r.name}</h3>
                </label>
                <p>
                  {r.version || "Версия неизвестна"} ·{" "}
                  {r.scope === "user"
                    ? "Текущий пользователь"
                    : "Все пользователи"}{" "}
                  · {r.publisher || "Издатель не указан"}
                </p>
                <details>
                  <summary>Точная идентификация</summary>
                  <p className="file-detail">
                    {r.productCode}
                    <br />
                    {r.key}
                  </p>
                </details>
                {blocked && (
                  <p className="warning-text">
                    {ambiguous
                      ? "Один код продукта соответствует нескольким записям в этой области. Точный выбор WinGet не подтверждён; используйте Параметры Windows."
                      : "Нет точной версии или кода продукта; безопасное удаление недоступно."}
                  </p>
                )}
                {
                  <button
                    className="button secondary"
                    disabled={running || busy}
                    onClick={() =>
                      onTroubleshoot(
                        r.appId || "windows-instance",
                        r.key,
                        r.name,
                      )
                    }
                  >
                    Программа не работает
                  </button>
                }
              </article>
            );
          })}
      </div>
      {!rows.length && !busy && !error && (
        <p className="empty-state">
          Установленные экземпляры Windows не обнаружены.
        </p>
      )}
    </>
  );
}
export function MyProgramsScreen({
  mode,
  running,
  onPlan,
  notify,
  presets,
  setPresets,
}: Common & { presets: Preset[]; setPresets: (p: Preset[]) => void }) {
  const [apps, setApps] = useState<CustomApp[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [editing, setEditing] = useState<CustomApp | null>(null),
    [deleting, setDeleting] = useState<CustomApp | null>(null),
    [presetId, setPresetId] = useState("");
  const refresh = async () =>
    setApps(await feature<CustomApp[]>("custom-list", {}, mode));
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    setSelected([]);
    setEditing(null);
  }, [mode]);
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="section-tools wrap">
        <button
          className="button primary"
          disabled={busy || running}
          onClick={() =>
            void work(async () => {
              const a = await feature<CustomApp>("custom-add", {}, mode);
              await refresh();
              setEditing(a);
            })
          }
        >
          {mode === "demo"
            ? "Добавить пример установщика"
            : "Выбрать локальный EXE или MSI"}
        </button>
        <button
          className="button secondary"
          disabled={busy || running || !selected.length}
          onClick={() =>
            void work(async () =>
              onPlan(
                await feature<Plan>("custom-prepare", { ids: selected }, mode),
              ),
            )
          }
        >
          План установки выбранных ({selected.length})
        </button>
      </div>
      <p className="inline-note">
        Добавлено пользователем. Эти программы хранятся отдельно от встроенного
        каталога. EXE запускается с обычным интерактивным мастером, MSI — через
        Windows Installer. Хеш подтверждает неизменность, а не доверие к
        издателю.
      </p>
      {error && (
        <p className="warning-text" role="alert">
          {error}
        </p>
      )}
      {busy && <p role="status">Подготовка…</p>}
      <div className="workflow-list">
        {apps.map((a) => (
          <article key={a.id}>
            <span className="badge">
              <Icon name={a.icon} /> Добавлено пользователем
            </span>
            <label className="check-row">
              <input
                type="checkbox"
                aria-label={`Выбрать установщик ${a.name}`}
                checked={selected.includes(a.id)}
                disabled={running}
                onChange={(e) =>
                  setSelected((c) =>
                    e.target.checked
                      ? [...c, a.id]
                      : c.filter((id) => id !== a.id),
                  )
                }
              />
              <h3>{a.name}</h3>
            </label>
            <p>{a.description}</p>
            <p>
              {a.fileName} · {(a.size / 1048576).toFixed(2)} МБ ·{" "}
              {a.kind.toUpperCase()}
            </p>
            <p className="file-detail">Исходный файл: {a.source}</p>
            <p>
              Версия: {a.version || "не указана"} · издатель в метаданных:{" "}
              {a.publisher || "не указан"}
            </p>
            <p className={a.signature === "valid" ? "" : "warning-text"}>
              {signatureNames[a.signature]}
            </p>
            <p>{a.signatureDetail}</p>
            <details>
              <summary>SHA-256 и хранение</summary>
              <p className="file-detail">{a.sha256}</p>
              <p>
                Запускается управляемая копия с повторной проверкой хеша.
                Исходный файл после добавления может отсутствовать. Если копия
                пропала или изменилась, выберите исходный файл заново.
                Совпадение хеша не подтверждает доверие издателю.
              </p>
            </details>
            <div className="row-actions">
              <button
                className="button secondary"
                disabled={busy || running}
                onClick={() => {
                  setEditing(a);
                  setPresetId("");
                }}
              >
                Изменить и добавить в набор
              </button>
              <button
                className="button secondary"
                disabled={busy || running}
                onClick={() => setDeleting(a)}
              >
                Удалить запись
              </button>
            </div>
          </article>
        ))}
      </div>
      {!apps.length && (
        <p className="empty-state">
          Выберите локальный установщик. Повторное добавление того же SHA-256
          использует существующую запись.
        </p>
      )}
      {editing && (
        <Modal title="Моя программа" onClose={() => setEditing(null)}>
          <div className="modal-body">
            <label className="field">
              Название
              <input
                aria-label="Название моей программы"
                value={editing.name}
                maxLength={160}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </label>
            <label className="field">
              Описание
              <textarea
                aria-label="Описание моей программы"
                value={editing.description}
                maxLength={1000}
                onChange={(e) =>
                  setEditing({ ...editing, description: e.target.value })
                }
              />
            </label>
            <label className="field">
              Значок
              <select
                aria-label="Значок моей программы"
                value={editing.icon}
                onChange={(e) =>
                  setEditing({ ...editing, icon: e.target.value })
                }
              >
                {[
                  "Package",
                  "Code2",
                  "Globe",
                  "Database",
                  "Coffee",
                  "FileText",
                ].map((i) => (
                  <option key={i} value={i}>
                    {
                      (
                        {
                          Package: "Программа",
                          Code2: "Разработка",
                          Globe: "Интернет",
                          Database: "Данные",
                          Coffee: "Инструменты",
                          FileText: "Документы",
                        } as Record<string, string>
                      )[i]
                    }
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Личный набор
              <select
                aria-label="Личный набор"
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
              >
                <option value="">Без добавления в набор</option>
                <option value="new">Создать «Мои программы»</option>
                {presets
                  .filter((p) => !p.builtin)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="modal-footer">
            <button
              className="button primary"
              disabled={busy || !editing.name.trim()}
              onClick={() =>
                void work(async () => {
                  await feature(
                    "custom-edit",
                    {
                      id: editing.id,
                      name: editing.name,
                      description: editing.description,
                      icon: editing.icon,
                    },
                    mode,
                  );
                  if (presetId) {
                    const ref = { name: editing.name, sha256: editing.sha256 };
                    if (presetId === "new")
                      setPresets([
                        ...presets,
                        {
                          id: crypto.randomUUID(),
                          name: "Мои программы",
                          description: "Личные установщики",
                          icon: "Package",
                          items: [],
                          customPrograms: [ref],
                          builtin: false,
                        },
                      ]);
                    else
                      setPresets(
                        presets.map((p) =>
                          p.id === presetId
                            ? {
                                ...p,
                                customPrograms: [
                                  ...(p.customPrograms || []).filter(
                                    (r) => r.sha256 !== ref.sha256,
                                  ),
                                  ref,
                                ],
                              }
                            : p,
                        ),
                      );
                  }
                  await refresh();
                  setEditing(null);
                  notify("Запись сохранена");
                })
              }
            >
              Сохранить
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="Удалить запись моей программы?"
          onClose={() => setDeleting(null)}
        >
          <div className="modal-body">
            <p>
              {deleting.name}. Будут удалены запись и управляемая копия
              установщика. Установленное приложение остаётся на компьютере.
              Ссылки в наборах сохранятся и потребуют выбора файла.
            </p>
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => setDeleting(null)}
            >
              Отмена
            </button>
            <button
              className="button primary"
              disabled={busy || running}
              onClick={() =>
                void work(async () => {
                  await feature("custom-remove", { id: deleting.id }, mode);
                  setSelected((c) => c.filter((id) => id !== deleting.id));
                  setDeleting(null);
                  await refresh();
                })
              }
            >
              Удалить запись и копию
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
