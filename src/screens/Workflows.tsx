import { installedInstances } from "../catalog";
import type { Product } from "../types";
import { useEffect, useState } from "react";
import { api, native, normalizePresetItems } from "../api";
import {
  apps,
  builtinPresets,
  defaultSelection,
  getApp,
  matchInstalled,
} from "../catalog";
import { ProductDialog } from "../components/ProductDialog";
import { Logo, Modal } from "../components/ui";
import { currentTasks, terminal } from "../queue";
import {
  downloadJson,
  itemSchema,
  parsePreset,
  readStorage,
  safeWriteStorage,
  sanitizeSelection,
  serializePreset,
} from "../storage";
import type {
  DownloadInventory,
  InstalledApp,
  Preset,
  QueueState,
  Selection,
  Settings,
  SystemInfo,
} from "../types";
import { date } from "./RunsScreen";
export function Readiness({
  system,
  scanning,
  detectedAt,
  installed,
  queue,
  onScan,
  onPrepare,
  error,
}: {
  system: SystemInfo | null;
  scanning: boolean;
  detectedAt: number | null;
  installed: InstalledApp[];
  queue: QueueState;
  onScan: () => void;
  onPrepare: () => void;
  error: string;
}) {
  return (
    <section className="readiness">
      <div>
        <strong>Готовность компьютера</strong>
        <p>{error || (!system ? "Получаем сведения…" : system.os)}</p>
      </div>
      <dl>
        <div>
          <dt>WinGet</dt>
          <dd>
            {!system ? "Загрузка…" : system.winget || "Не обнаружен / демо"}
          </dd>
        </div>
        <div>
          <dt>Свободно</dt>
          <dd>
            {system?.freeDiskMb == null
              ? "Не определено"
              : `${(system.freeDiskMb / 1024).toFixed(1)} ГБ`}
          </dd>
        </div>
        <div>
          <dt>Обнаружение</dt>
          <dd>{scanning ? "Проверяем…" : date(detectedAt)}</dd>
        </div>
        <div>
          <dt>Обновления</dt>
          <dd>
            {detectedAt
              ? installed.filter((i) => i.availableVersion).length
              : "Не проверено"}
          </dd>
        </div>
        <div>
          <dt>Незавершённые</dt>
          <dd>
            {
              currentTasks(queue).filter(
                (t) => !terminal(t.status) || t.status === "action-required",
              ).length
            }
          </dd>
        </div>
      </dl>
      <div className="row-actions">
        <button className="button secondary" onClick={onPrepare}>
          Подготовить компьютер
        </button>
        <button
          className="button secondary"
          disabled={scanning}
          onClick={onScan}
        >
          {scanning ? "Проверяем…" : "Проверить обновления"}
        </button>
      </div>
    </section>
  );
}
export function UpdatesScreen({
  installed,
  profile,
  mode,
  onReview,
  onScan,
  scanning,
  detectedAt,
  notify,
}: {
  installed: InstalledApp[];
  profile: Selection[];
  mode: Settings["mode"];
  onReview: (items: Selection[]) => void;
  onScan: () => void;
  scanning: boolean;
  detectedAt: number | null;
  notify: (s: string) => void;
}) {
  const [targets, setTargets] = useState<Record<string, string>>({});
  const foundFor = (a: Product) => {
    const entries = installedInstances(a, installed);
    return (
      entries.find((i) => i.packageId === targets[a.id]) ||
      entries.find((i) => i.availableVersion) ||
      entries[0]
    );
  };
  const [selected, setSelected] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>(() =>
    readStorage("update-exclusions", []),
  );
  const rows = apps.filter((a) => matchInstalled(a, installed));
  const supported = rows.filter(
    (a) =>
      a.install.method === "winget" && a.install.verification === "verified",
  );
  const choose = (id: string, on: boolean) =>
    setSelected((s) =>
      on ? [...new Set([...s, id])] : s.filter((x) => x !== id),
    );
  const items = selected.map((id) => {
    const a = getApp(id);
    const pin = profile.find((s) => s.appId === id);
    const found = foundFor(a);
    const edition = a.editions.find(
      (e) => e.packageId?.toLowerCase() === found?.packageId.toLowerCase(),
    );
    return {
      ...defaultSelection(a),
      ...pin,
      options: {
        ...defaultSelection(a).options,
        ...pin?.options,
        ...(edition ? { edition: edition.id } : {}),
      },
      action: "install" as const,
    };
  });
  return (
    <>
      <p className="inline-note">
        Обновления доступны для поддерживаемых продуктов каталога. Версии
        получены из текущего ответа WinGet; закрепления берутся из профиля
        компьютера. {mode === "demo" ? "Демо не читает систему." : ""}
      </p>
      <div className="section-tools wrap">
        <button
          className="button secondary"
          disabled={scanning}
          onClick={onScan}
        >
          Проверить обновления
        </button>
        <span>Последняя проверка: {date(detectedAt)}</span>
        <button
          className="button secondary"
          onClick={() =>
            setSelected(
              supported
                .filter(
                  (a) =>
                    !excluded.includes(a.id) &&
                    !profile.find((s) => s.appId === a.id)?.version &&
                    foundFor(a)?.availableVersion,
                )
                .map((a) => a.id),
            )
          }
        >
          Выбрать доступные
        </button>
        <button
          className="button primary"
          disabled={!selected.length}
          onClick={() => onReview(items)}
        >
          Проверить план обновлений ({selected.length})
        </button>
      </div>
      <div className="workflow-list">
        {rows.map((a) => {
          const pin = profile.find((s) => s.appId === a.id);
          const found = foundFor(a);
          const instances = installedInstances(a, installed);
          const auto =
            a.install.method === "winget" &&
            a.install.verification === "verified" &&
            instances.filter((i) => i.packageId === found.packageId).length <=
              1;
          const fixed = !!pin?.version;
          return (
            <article key={a.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(a.id)}
                  disabled={
                    !auto ||
                    !found.availableVersion ||
                    fixed ||
                    excluded.includes(a.id)
                  }
                  onChange={(e) => choose(a.id, e.target.checked)}
                />
                <strong>{a.name}</strong>
              </label>
              {a.editions.length > 0 && (
                <>
                  <label>
                    Редакция обновления{" "}
                    <select
                      aria-label={"Редакция обновления " + a.name}
                      value={found.packageId}
                      onChange={(e) => {
                        setTargets((t) => ({ ...t, [a.id]: e.target.value }));
                        choose(a.id, false);
                      }}
                    >
                      {[...new Set(instances.map((i) => i.packageId))].map(
                        (id) => (
                          <option key={id} value={id}>
                            {a.editions.find((e) => e.packageId === id)?.name ||
                              id}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  {instances.map((i, index) => (
                    <p key={i.instanceId || index}>
                      Экземпляр: {i.edition || i.packageId} ·{" "}
                      {i.instanceId || "ID не предоставлен"} · {i.version}
                      {i.availableVersion ? " → " + i.availableVersion : ""}
                    </p>
                  ))}
                </>
              )}
              <p>
                Установлена: {found.version} · доступна:{" "}
                {found.availableVersion || "обновление не обнаружено"}
              </p>
              {fixed && (
                <p className="warning-text">
                  Закреплена {pin.version}. Измените политику версии в профиле
                  для обновления.
                </p>
              )}
              {auto ? (
                <label>
                  <input
                    type="checkbox"
                    checked={excluded.includes(a.id)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...excluded, a.id]
                        : excluded.filter((id) => id !== a.id);
                      setExcluded(next);
                      safeWriteStorage("update-exclusions", next);
                      choose(a.id, false);
                    }}
                  />
                  Исключить из массового обновления
                </label>
              ) : (
                <button
                  className="button secondary"
                  onClick={() =>
                    void api.source(a.id).catch((e) => notify(String(e)))
                  }
                >
                  Ручное обновление · официальный источник
                </button>
              )}
            </article>
          );
        })}
      </div>
      {!rows.length && (
        <p className="empty-state">
          Поддерживаемые программы пока не обнаружены. Запустите проверку в
          рабочем режиме.
        </p>
      )}
    </>
  );
}
export function PresetEditor({
  preset,
  onSave,
  onClose,
  mode,
  notify,
}: {
  preset: Preset;
  onSave: (p: Preset) => void;
  onClose: () => void;
  mode: Settings["mode"];
  notify: (s: string) => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(preset));
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<string | null>(null);
  if (edit)
    return (
      <ProductDialog
        app={getApp(edit)}
        selection={draft.items.find((s) => s.appId === edit)}
        mode={mode}
        favorite={false}
        onFavorite={() => {}}
        notify={notify}
        onClose={() => setEdit(null)}
        onApply={(s) => {
          setDraft((d) => ({
            ...d,
            items: d.items.map((i) => (i.appId === s.appId ? s : i)),
          }));
          setEdit(null);
        }}
      />
    );
  return (
    <Modal title="Редактор набора" wide onClose={onClose}>
      <div className="modal-body">
        <label className="form-label">
          Название
          <input
            aria-label="Название набора"
            value={draft.name}
            maxLength={80}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </label>
        <label className="form-label">
          Описание
          <textarea
            aria-label="Описание набора"
            value={draft.description}
            maxLength={300}
            onChange={(e) =>
              setDraft((d) => ({ ...d, description: e.target.value }))
            }
          />
        </label>
        {draft.issues?.map((s, i) => (
          <p className="warning-text" key={i}>
            {s}
          </p>
        ))}
        <button
          className="button secondary"
          onClick={() =>
            setDraft((d) => ({
              ...d,
              items: d.items.map((s) => ({ ...s, version: undefined })),
              issues: [],
            }))
          }
        >
          Использовать последние версии
        </button>
        <input
          aria-label="Найти программу в наборе"
          placeholder="Найти программу"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="editor-products">
          {apps
            .filter((a) =>
              `${a.name} ${a.description}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((a) => {
              const selected = draft.items.find((s) => s.appId === a.id);
              return (
                <div key={a.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!selected}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          items: e.target.checked
                            ? [...d.items, defaultSelection(a)]
                            : d.items.filter((s) => s.appId !== a.id),
                        }))
                      }
                    />
                    {a.name}
                  </label>
                  {selected && (
                    <>
                      <span>
                        {selected.version
                          ? `Закреплена ${selected.version}`
                          : "Последняя доступная"}
                      </span>
                      <button
                        className="button secondary"
                        onClick={() => setEdit(a.id)}
                      >
                        Параметры {a.name}
                      </button>
                    </>
                  )}
                </div>
              );
            })}
        </div>
      </div>
      <div className="modal-footer">
        <span>{draft.items.length} программ</span>
        <button
          className="button primary"
          disabled={!draft.name.trim() || !draft.items.length}
          onClick={() => {
            try {
              draft.items.forEach((s) => sanitizeSelection(s));
              onSave({ ...draft, name: draft.name.trim(), builtin: false });
            } catch (e) {
              notify(String(e));
            }
          }}
        >
          Сохранить набор
        </button>
      </div>
    </Modal>
  );
}
export function PresetsScreen({
  presets,
  setPresets,
  selection,
  onReplace,
  onAdd,
  onUndo,
  canUndo,
  mode,
  notify,
}: {
  presets: Preset[];
  setPresets: (p: Preset[]) => void;
  selection: Selection[];
  onReplace: (items: Selection[]) => void;
  onAdd: (items: Selection[]) => void;
  onUndo: () => void;
  canUndo: boolean;
  mode: Settings["mode"];
  notify: (s: string) => void;
}) {
  const [editing, setEditing] = useState<Preset | null>(null);
  const [imported, setImported] = useState<Preset | null>(null);
  const save = (p: Preset) => {
    setPresets(
      presets.some((x) => x.id === p.id)
        ? presets.map((x) => (x.id === p.id ? p : x))
        : [...presets, p],
    );
    setEditing(null);
    notify("Набор сохранён");
  };
  return (
    <>
      <div className="section-tools wrap">
        <button
          className="button primary"
          onClick={() =>
            setEditing({
              id: crypto.randomUUID(),
              name: "Новый набор",
              description: "",
              items: structuredClone(selection),
              builtin: false,
              icon: "Package",
            })
          }
        >
          Создать набор
        </button>
        <label className="button secondary">
          Импорт JSON
          <input
            aria-label="Импорт набора"
            type="file"
            accept=".json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file)
                try {
                  setImported(parsePreset(await file.text()));
                } catch (err) {
                  notify(String(err));
                }
              e.target.value = "";
            }}
          />
        </label>
        <button
          className="button secondary"
          disabled={!canUndo}
          onClick={onUndo}
        >
          Отменить последнюю замену
        </button>
      </div>
      <div className="preset-grid">
        {[...presets, ...builtinPresets].map((p) => (
          <article className="preset-card" key={p.id}>
            <span className="badge">
              {p.builtin ? "Готовый набор" : "Мой набор"}
            </span>
            <h3>{p.name}</h3>
            {p.items.length > 0 && (
              <ul className="preset-apps" aria-label="Программы в наборе">
                {p.items.map((item) => {
                  const app = getApp(item.appId);
                  return app ? (
                    <li key={item.appId} title={app.name} aria-label={app.name}>
                      <Logo app={app} small />
                    </li>
                  ) : null;
                })}
              </ul>
            )}
            <p>{p.description}</p>
            <p>{p.items.length} программ</p>
            <div className="row-actions">
              <button
                className="button primary"
                onClick={() => onReplace(normalizePresetItems(p.items))}
              >
                Заменить выбор
              </button>
              <button
                className="button secondary"
                onClick={() => onAdd(normalizePresetItems(p.items))}
              >
                Добавить к текущему выбору
              </button>
              <button
                className="button secondary"
                onClick={() =>
                  setEditing({
                    ...structuredClone(p),
                    id: p.builtin ? crypto.randomUUID() : p.id,
                    builtin: false,
                  })
                }
              >
                Редактировать
              </button>
              <button
                className="button secondary"
                onClick={() =>
                  setEditing({
                    ...structuredClone(p),
                    id: crypto.randomUUID(),
                    name: `${p.name} — копия`.slice(0, 80),
                    builtin: false,
                  })
                }
              >
                Дублировать
              </button>
              <button
                className="button secondary"
                onClick={() =>
                  downloadJson(`${p.name}.json`, serializePreset(p))
                }
              >
                Экспорт {p.name}
              </button>
              {!p.builtin && (
                <button
                  className="button secondary"
                  onClick={() =>
                    setPresets(presets.filter((x) => x.id !== p.id))
                  }
                >
                  Удалить
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <PresetEditor
          key={editing.id}
          preset={editing}
          onSave={save}
          onClose={() => setEditing(null)}
          mode={mode}
          notify={notify}
        />
      )}
      {imported && (
        <Modal
          title="Проверка импорта набора"
          wide
          onClose={() => setImported(null)}
        >
          <div className="modal-body">
            <h3>{imported.name}</h3>
            <p>
              {imported.items.length} программ. Все операции потребуют нового
              плана.
            </p>
            {imported.issues?.length ? (
              imported.issues.map((s, i) => (
                <p className="warning-text" key={i}>
                  {s}
                </p>
              ))
            ) : (
              <p>Параметры и зависимости совместимы.</p>
            )}
            <button
              className="button secondary"
              onClick={() =>
                setImported((p) =>
                  p
                    ? {
                        ...p,
                        items: p.items.map((s) => ({
                          ...s,
                          version: undefined,
                        })),
                        issues: [],
                      }
                    : p,
                )
              }
            >
              Разрешить устаревшие версии: выбрать последние
            </button>
          </div>
          <div className="modal-footer">
            <button
              className="button primary"
              onClick={() => {
                save(imported);
                setImported(null);
              }}
            >
              Сохранить импортированный набор
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
interface Profile {
  schemaVersion: 2;
  name: string;
  items: Selection[];
  unsupported: string[];
}
export function useProfile() {
  const [profile, setProfile] = useState<Profile>(() => {
    const p = readStorage<Profile | null>("computer-profile", null);
    if (!p)
      return {
        schemaVersion: 2,
        name: "Мой компьютер",
        items: [],
        unsupported: [],
      };
    try {
      if (!Array.isArray(p.items)) throw new Error();
      return {
        ...p,
        items: p.items.map((s) => sanitizeSelection(itemSchema.parse(s))),
        unsupported: Array.isArray(p.unsupported) ? p.unsupported : [],
      };
    } catch {
      return {
        schemaVersion: 2,
        name: "Мой компьютер",
        items: [],
        unsupported: [
          "Сохранённый профиль повреждён. Импортируйте исправный файл.",
        ],
      };
    }
  });
  useEffect(() => safeWriteStorage("computer-profile", profile), [profile]);
  return [profile, setProfile] as const;
}
export function ProfileScreen({
  profile,
  setProfile,
  installed,
  selection,
  mode,
  onReview,
  notify,
}: {
  profile: Profile;
  setProfile: (p: Profile) => void;
  installed: InstalledApp[];
  selection: Selection[];
  mode: Settings["mode"];
  onReview: (items: Selection[]) => void;
  notify: (s: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [candidate, setCandidate] = useState<Profile | null>(null);
  const missing = profile.items.filter(
    (s) =>
      !matchInstalled(getApp(s.appId), installed, s) ||
      (matchInstalled(getApp(s.appId), installed, s)?.availableVersion &&
        !s.version),
  );
  return (
    <>
      <p className="inline-note">
        Профиль переносит состав программ и параметры AppDock. Пользовательские
        файлы и секреты в перенос не входят. После импорта требуется сравнение с
        этим компьютером и новый план.
      </p>
      <div className="section-tools wrap">
        <button
          className="button secondary"
          disabled={!selection.length}
          onClick={() =>
            setProfile({ ...profile, items: structuredClone(selection) })
          }
        >
          Сохранить текущий выбор
        </button>
        <button
          className="button secondary"
          onClick={() =>
            setProfile({
              ...profile,
              items: apps
                .filter((a) => matchInstalled(a, installed))
                .map((a) => {
                  const found = matchInstalled(a, installed)!;
                  const edition = a.editions.find(
                    (e) =>
                      e.packageId?.toLowerCase() ===
                      found.packageId.toLowerCase(),
                  );
                  return {
                    ...defaultSelection(a),
                    options: {
                      ...defaultSelection(a).options,
                      ...(edition ? { edition: edition.id } : {}),
                    },
                  };
                }),
            })
          }
        >
          Сохранить обнаруженный состав
        </button>
        <button className="button secondary" onClick={() => setEditing(true)}>
          Редактировать профиль
        </button>
        <button
          className="button secondary"
          onClick={() =>
            downloadJson(
              "AppDock-computer-profile.json",
              JSON.stringify(
                {
                  ...profile,
                  items: profile.items.map((s) => sanitizeSelection(s)),
                },
                null,
                2,
              ),
            )
          }
        >
          Экспорт профиля
        </button>
        <label className="button secondary">
          Импорт профиля
          <input
            aria-label="Импорт профиля"
            type="file"
            accept=".json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f)
                try {
                  if (f.size > 200000) throw new Error("Файл больше 200 КБ");
                  const raw = JSON.parse(await f.text());
                  if (
                    ![1, 2].includes(raw.schemaVersion) ||
                    !Array.isArray(raw.items) ||
                    raw.items.length > 100
                  )
                    throw new Error("Неверная схема профиля");
                  const unsupported: string[] = [];
                  const items: Selection[] = [];
                  for (const entry of raw.items) {
                    const s = itemSchema.parse(entry);
                    if (!getApp(s.appId)) {
                      unsupported.push(s.appId);
                      continue;
                    }
                    try {
                      items.push(sanitizeSelection(s));
                    } catch (err) {
                      unsupported.push(`${s.appId}: ${String(err)}`);
                    }
                  }
                  setCandidate({
                    schemaVersion: 2,
                    name:
                      typeof raw.name === "string"
                        ? raw.name.slice(0, 80)
                        : "Импортированный компьютер",
                    items,
                    unsupported,
                  });
                } catch (err) {
                  notify(String(err));
                }
              e.target.value = "";
            }}
          />
        </label>
        <button
          className="button primary"
          disabled={!missing.length}
          onClick={() => onReview(missing)}
        >
          Проверить план профиля ({missing.length})
        </button>
      </div>
      <h2>{profile.name}</h2>
      <div className="workflow-list">
        {profile.items.map((s) => {
          const a = getApp(s.appId),
            i = matchInstalled(a, installed, s);
          const manual =
            s.action === "guide" ||
            ["web", "cloud"].includes(a.type) ||
            !a.platforms.includes("windows");
          const stale = s.version && s.version !== a.version;
          return (
            <article key={s.appId}>
              <h3>{a.name}</h3>
              <span className="badge">
                {manual || stale
                  ? "Требуется ручной шаг"
                  : !i
                    ? "Отсутствует"
                    : i.availableVersion && !s.version
                      ? "Доступно обновление"
                      : s.version && i.version !== s.version
                        ? "Требуется проверка версии"
                        : "Соответствует"}
              </span>
              <p>
                На компьютере: {i?.version || "не обнаружена"} · политика:{" "}
                {s.version ? `конкретная ${s.version}` : "последняя доступная"}{" "}
                · редакция: {String(s.options.edition || "по умолчанию")}
              </p>
              {stale && (
                <p className="warning-text">
                  Версия больше не проверена каталогом. Откройте редактор
                  профиля и выберите последнюю.
                </p>
              )}
            </article>
          );
        })}
        {profile.unsupported.map((id, i) => (
          <article key={i} className="warning-text">
            Не поддерживается: {id}
          </article>
        ))}
      </div>
      {!profile.items.length && (
        <p className="empty-state">
          Сохраните выбор или импортируйте профиль для сравнения.
        </p>
      )}
      {editing && (
        <PresetEditor
          preset={{
            id: "profile",
            name: profile.name,
            description: "Желаемый состав компьютера",
            items: profile.items,
            icon: "Monitor",
            builtin: false,
          }}
          mode={mode}
          notify={notify}
          onClose={() => setEditing(false)}
          onSave={(p) => {
            setProfile({ ...profile, name: p.name, items: p.items });
            setEditing(false);
          }}
        />
      )}
      {candidate && (
        <Modal title="Совместимость профиля" onClose={() => setCandidate(null)}>
          <div className="modal-body">
            <p>
              Поддерживаемых позиций: {candidate.items.length}. Совместимость
              версий будет повторно проверена в плане.
            </p>
            {candidate.unsupported.map((s, i) => (
              <p className="warning-text" key={i}>
                Не поддерживается: {s}
              </p>
            ))}
          </div>
          <div className="modal-footer">
            <button
              className="button primary"
              onClick={() => {
                setProfile(candidate);
                setCandidate(null);
              }}
            >
              Импортировать и сравнить
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function DownloadsScreen({
  notify,
  running,
}: {
  notify: (s: string) => void;
  running: boolean;
}) {
  const [inventory, setInventory] = useState<DownloadInventory | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try {
      setInventory(await api.downloads());
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <>
      <div className="section-tools wrap">
        <button
          className="button secondary"
          disabled={running || !native}
          onClick={() =>
            void api
              .chooseDownloads()
              .then(() => refresh())
              .catch((e) => notify(String(e)))
          }
        >
          Выбрать папку
        </button>
        <button
          className="button secondary"
          onClick={() =>
            void api.openDownloads().catch((e) => notify(String(e)))
          }
        >
          Открыть папку
        </button>
        <button
          className="button secondary"
          disabled={loading}
          onClick={() => void refresh()}
        >
          Обновить список
        </button>
      </div>
      <p>{loading ? "Загрузка списка…" : error || inventory?.folder}</p>
      <p className="inline-note">{inventory?.limitations}</p>
      <div className="workflow-list">
        {inventory?.files.map((f) => (
          <article key={f.id}>
            <h3>{f.name}</h3>
            <p>
              {(f.size / 1024 / 1024).toFixed(2)} МБ · версия:{" "}
              {f.version || "не подтверждена"}
            </p>
            <p>
              {f.verification} · {date(f.checkedAt)}
            </p>
            <p>Источник: {f.source || "не записан"}</p>
            <button
              className="button secondary"
              disabled={running}
              onClick={() =>
                void api
                  .removeDownload(f.id)
                  .then(refresh)
                  .catch((e) => notify(String(e)))
              }
            >
              Удалить из кэша {f.name}
            </button>
          </article>
        ))}
      </div>
      {!inventory?.files.length && !loading && (
        <p className="empty-state">
          Полученных файлов нет. Загрузка создаёт файлы только в рабочем режиме.
        </p>
      )}
    </>
  );
}
