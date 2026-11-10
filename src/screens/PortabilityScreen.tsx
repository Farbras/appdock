import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { native } from "../api";
import { apps, defaultSelection, getApp } from "../catalog";
import { Logo, Modal } from "../components/ui";
import {
  feature,
  type BundleReport,
  type OfflineSupport,
  type TransferPreview,
} from "../feature-api";
import { downloadJson } from "../storage";
import type { Plan, Selection, Settings } from "../types";

type Common = {
  mode: Settings["mode"];
  running: boolean;
  notify: (s: string) => void;
};
const components = [
  ["vscode-settings", "VS Code: безопасные настройки"],
  ["vscode-keys", "VS Code: сочетания клавиш"],
  ["vscode-extensions", "VS Code: расширения из каталога"],
  ["git", "Git: безопасные параметры"],
  ["terminal", "Windows Terminal: внешний вид и профили"],
];
export function SettingsTransfer({
  mode,
  running,
  notify,
  onReview,
}: Common & { onReview: (s: Selection[]) => void }) {
  const [chosen, setChosen] = useState(components.map(([id]) => id));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [included, setIncluded] = useState<string[]>([]);
  const [backups, setBackups] = useState<string[]>([]);
  const [restore, setRestore] = useState<string | null>(null);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [extensions, setExtensions] = useState<string[]>([]);
  const refresh = () =>
    feature<string[]>("backups", {}, mode)
      .then(setBackups)
      .catch((e) => notify(String(e)));
  useEffect(() => {
    void refresh();
  }, [mode]);
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section portability-section">
      <h2>Перенос настроек программ</h2>
      <p className="muted-text">
        Выберите компоненты. Экспорт содержит только безопасный список
        параметров. Пароли, токены, ключи, Git aliases/helpers, команды Terminal
        и произвольные команды клавиш исключаются. Пути целевых файлов
        определяет AppDock на этом компьютере.
      </p>
      {mode === "demo" && (
        <p className="inline-note">
          ДЕМО · все данные и резервные копии виртуальные.
        </p>
      )}
      <div className="transfer-components">
        {components.map(([id, label]) => (
          <label key={id}>
            <input
              type="checkbox"
              checked={chosen.includes(id)}
              onChange={(e) =>
                setChosen((p) =>
                  e.target.checked ? [...p, id] : p.filter((c) => c !== id),
                )
              }
            />
            {label}
          </label>
        ))}
      </div>
      <div className="row-actions">
        <button
          className="button secondary"
          disabled={busy || running || !chosen.length}
          onClick={() =>
            void work(async () => {
              const data = await feature<{ exclusions: string[] }>(
                "settings-export",
                { components: chosen },
                mode,
              );
              setExclusions(data.exclusions);
              downloadJson(
                "AppDock-settings.json",
                JSON.stringify(data, null, 2),
              );
            })
          }
        >
          Экспорт настроек
        </button>
        <label className="button secondary">
          Импорт настроек
          <input
            aria-label="Импорт настроек программ"
            type="file"
            accept=".json"
            disabled={busy || running}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file)
                void work(async () => {
                  if (file.size > 2_000_000)
                    throw new Error("Файл больше 2 МБ");
                  const p = await feature<TransferPreview>(
                    "settings-preview",
                    { text: await file.text() },
                    mode,
                  );
                  setPreview(p);
                  setIncluded(
                    p.rows
                      .filter((r) => r.available && !r.conflict)
                      .map((r) => r.component),
                  );
                });
            }}
          />
        </label>
        {mode === "demo" && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void work(async () => {
                const p = await feature<TransferPreview>(
                  "settings-preview",
                  {
                    text: JSON.stringify(
                      await feature("settings-export", {}, mode),
                    ),
                  },
                  mode,
                );
                setPreview(p);
                setIncluded([]);
              })
            }
          >
            Показать пример конфликта
          </button>
        )}
      </div>
      {!!exclusions.length && (
        <details>
          <summary>Исключения экспорта ({exclusions.length})</summary>
          <ul>
            {exclusions.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      )}
      {busy && <p role="status">Обрабатываем настройки…</p>}
      {!!extensions.length && (
        <button
          className="button primary"
          onClick={() =>
            onReview([{ ...defaultSelection(getApp("vscode")), extensions }])
          }
        >
          Проверить план установки расширений ({extensions.length})
        </button>
      )}
      <details>
        <summary>Резервные копии ({backups.length})</summary>
        <p>
          Восстановление заменяет изменённые файлы их исходными версиями. Если
          файл после переноса изменился ещё раз, AppDock остановится и сохранит
          новые изменения.
        </p>
        {backups.length ? (
          backups.map((id) => (
            <div className="setting-row" key={id}>
              <code>{id}</code>
              <button
                className="button secondary"
                disabled={busy || running}
                onClick={() => setRestore(id)}
              >
                Восстановить копию
              </button>
            </div>
          ))
        ) : (
          <p>Резервных копий ещё нет.</p>
        )}
      </details>
      {preview && (
        <Modal
          title="Предпросмотр переноса настроек"
          wide
          onClose={() => !busy && setPreview(null)}
        >
          <div className="modal-body">
            <p>
              Отметьте компоненты для применения. При конфликте выбор по
              умолчанию — пропустить. Выбранные безопасные поля заменят
              локальные значения; остальные параметры сохранятся. Перед записью
              AppDock создаст резервную копию. JSONC будет сохранён как JSON без
              комментариев.
            </p>
            {preview.rows.map((row) => (
              <details className="transfer-row" key={row.component} open>
                <summary>
                  {components.find(([id]) => id === row.component)?.[1] ||
                    row.component}{" "}
                  ·{" "}
                  {row.available
                    ? row.conflict
                      ? "Конфликт"
                      : "Готов к переносу"
                    : "Пропущен"}
                </summary>
                <label>
                  <input
                    type="checkbox"
                    checked={included.includes(row.component)}
                    disabled={!row.available || busy}
                    onChange={(e) =>
                      setIncluded((p) =>
                        e.target.checked
                          ? [...p, row.component]
                          : p.filter((c) => c !== row.component),
                      )
                    }
                  />
                  Применить безопасные поля / заменить конфликтующие значения
                </label>
                <p>{row.reason}</p>
                <div className="transfer-diff">
                  <div>
                    <strong>На этом компьютере</strong>
                    <pre>{JSON.stringify(row.before, null, 2)}</pre>
                  </div>
                  <div>
                    <strong>Из файла</strong>
                    <pre>{JSON.stringify(row.after, null, 2)}</pre>
                  </div>
                </div>
              </details>
            ))}
            {!!preview.exclusions.length && (
              <details>
                <summary>Исключённые параметры и ограничения</summary>
                <ul>
                  {preview.exclusions.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          <div className="modal-footer">
            <button
              className="button primary"
              disabled={busy || running || !included.length}
              onClick={() =>
                void work(async () => {
                  const result = await feature<{
                    backupId: string;
                    extensions: string[];
                    message: string;
                  }>(
                    "settings-apply",
                    { token: preview.token, components: included },
                    mode,
                  );
                  setExtensions(result.extensions);
                  setPreview(null);
                  notify(result.message);
                  await refresh();
                })
              }
            >
              Создать копию и применить выбранное
            </button>
          </div>
        </Modal>
      )}
      {restore && (
        <Modal title="Восстановление настроек" onClose={() => setRestore(null)}>
          <div className="modal-body">
            <p>
              Исходные файлы из копии {restore} заменят настройки, изменённые
              этим переносом. Расширения не удаляются. Проверка изменений
              защитит более новые правки.
            </p>
          </div>
          <div className="modal-footer">
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  const r = await feature<{ message: string }>(
                    "settings-restore",
                    { backupId: restore },
                    mode,
                  );
                  notify(r.message);
                  setRestore(null);
                })
              }
            >
              Восстановить исходные файлы
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

const offlineCandidates = apps.map(defaultSelection);

export function PortabilityScreen({
  mode,
  running,
  onPlan,
}: Common & { onPlan: (p: Plan) => void }) {
  const [folder, setFolder] = useState("");
  const [support, setSupport] = useState<OfflineSupport[]>([]);
  const [checkingSupport, setCheckingSupport] = useState(true);
  const [supportError, setSupportError] = useState("");
  const [supportAttempt, setSupportAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [included, setIncluded] = useState<string[]>([]);
  const [report, setReport] = useState<BundleReport | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  useEffect(() => {
    let alive = true;
    setCheckingSupport(true);
    setSupportError("");
    setSupport([]);
    setIncluded([]);
    void feature<OfflineSupport[]>(
      "offline-support",
      { items: offlineCandidates },
      mode,
    )
      .then((rows) => {
        if (alive) setSupport(rows);
      })
      .catch((e) => alive && setSupportError(String(e)))
      .finally(() => alive && setCheckingSupport(false));
    return () => {
      alive = false;
    };
  }, [mode, supportAttempt]);
  useEffect(() => {
    if (!native || mode === "demo") return;
    let stop: (() => void) | undefined;
    let alive = true;
    void listen<{ appId: string; bytes: number }>(
      "appdock-feature-progress",
      (e) =>
        setProgress(
          `${getApp(e.payload.appId).name}: ${(e.payload.bytes / 1048576).toFixed(1)} МБ получено`,
        ),
    ).then((fn) => {
      if (alive) stop = fn;
      else fn();
    });
    return () => {
      alive = false;
      stop?.();
    };
  }, [mode]);
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setProgress("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const available = support.filter((row) => row.supported);
  const matchesQuery = (row: OfflineSupport) => {
    const app = getApp(row.appId);
    return [app.name, ...app.aliases, row.version || ""]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
  };
  const visibleAvailable = available.filter(matchesQuery);
  const unavailable = support.filter(
    (row) => !row.supported && matchesQuery(row),
  );
  return (
    <div className="settings-page">
      <section className="settings-section portability-section">
        <h2>Офлайн-набор на флешку</h2>
        <p>
          Выберите программы для набора прямо в этом разделе и укажите папку.
          AppDock скачает полные установщики, сверит встроенные SHA-256 и
          запишет манифест, контрольные суммы и инструкцию. На другом компьютере
          откройте созданную подпапку с manifest.json.
        </p>
        <p className="inline-note">
          Пакеты для Windows x64 устанавливаются со стандартными параметрами.
          Версии автономного снимка показаны в списке; обновления требуют нового
          доверенного рецепта. Расширения, веб-установщики и обязательные
          сетевые компоненты в набор не включаются. Наличие функции «Только
          скачать» не означает автономность.
        </p>
        {mode === "demo" && (
          <p className="inline-note">
            ДЕМО · набор и папка виртуальные, установщики не скачиваются.
          </p>
        )}
        <h3>Программы для набора</h3>
        <input
          aria-label="Поиск программ для офлайн-набора"
          placeholder="Название программы"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {checkingSupport && (
          <p role="status">Проверяем поддерживаемые пакеты…</p>
        )}
        {supportError && (
          <div role="alert" className="inline-note warning-text">
            <p>Не удалось проверить поддержку пакетов: {supportError}</p>
            <button
              className="button secondary"
              onClick={() => setSupportAttempt((n) => n + 1)}
            >
              Повторить проверку пакетов
            </button>
          </div>
        )}
        {!checkingSupport && !supportError && (
          <>
            <h3>Поддерживаемые пакеты ({available.length})</h3>
            <div className="row-actions">
              <span role="status">Выбрано для набора: {included.length}</span>
              <button
                className="button secondary"
                disabled={
                  busy ||
                  running ||
                  !available.length ||
                  included.length === available.length
                }
                onClick={() => setIncluded(available.map((row) => row.appId))}
              >
                Выбрать все поддерживаемые
              </button>
              <button
                className="button secondary"
                disabled={busy || running || !included.length}
                onClick={() => setIncluded([])}
              >
                Снять выбор пакетов
              </button>
            </div>
            {!visibleAvailable.length && (
              <p className="inline-note">
                {query.trim()
                  ? "По запросу нет поддерживаемых пакетов. Проверьте список недоступных программ ниже."
                  : "В текущем каталоге нет подтверждённых автономных пакетов. Открытие готового набора доступно ниже."}
              </p>
            )}
            {visibleAvailable.map((row) => (
              <div className="transfer-row" key={row.appId}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Добавить ${getApp(row.appId).name} в офлайн-набор`}
                    aria-describedby={`offline-reason-${row.appId}`}
                    disabled={busy || running}
                    checked={included.includes(row.appId)}
                    onChange={(e) =>
                      setIncluded((p) =>
                        e.target.checked
                          ? [...p, row.appId]
                          : p.filter((id) => id !== row.appId),
                      )
                    }
                  />
                  <Logo app={getApp(row.appId)} small />
                  <strong>{getApp(row.appId).name}</strong> · {row.version} ·
                  x64
                </label>
                <p id={`offline-reason-${row.appId}`}>{row.reason}</p>
              </div>
            ))}
            <details open={!!query.trim()}>
              <summary>
                Недоступны для автономного набора ({unavailable.length})
              </summary>
              {unavailable.map((row) => (
                <div className="transfer-row" key={row.appId}>
                  <strong>{getApp(row.appId).name}</strong>
                  <p>{row.reason}</p>
                </div>
              ))}
              {!unavailable.length && (
                <p>Недоступных программ по запросу нет.</p>
              )}
            </details>
          </>
        )}
        <div className="setting-row">
          <div>
            <strong>Папка набора</strong>
            <input
              aria-label="Путь к офлайн-набору"
              placeholder="Выберите или вставьте путь к папке"
              value={folder}
              disabled={busy || running}
              onChange={(e) => {
                setFolder(e.target.value);
                setReport(null);
              }}
            />
          </div>
          <button
            className="button secondary"
            disabled={busy || running}
            onClick={() =>
              void work(async () => {
                setFolder(await feature<string>("choose-folder", {}, mode));
                setReport(null);
              })
            }
          >
            Выбрать папку набора
          </button>
        </div>
        <div className="row-actions">
          <button
            className="button primary"
            disabled={busy || running || !folder || !included.length}
            onClick={() =>
              void work(async () => {
                setPreparing(true);
                try {
                  setReport(
                    await feature<BundleReport>(
                      "offline-create",
                      {
                        folder,
                        items: offlineCandidates.filter((s) =>
                          included.includes(s.appId),
                        ),
                      },
                      mode,
                    ),
                  );
                } finally {
                  setPreparing(false);
                }
              })
            }
          >
            Подготовить офлайн-набор
          </button>
          <button
            className="button secondary"
            disabled={busy || running || !folder}
            onClick={() =>
              void work(async () => {
                setReport(
                  await feature<BundleReport>(
                    "offline-inspect",
                    { folder },
                    mode,
                  ),
                );
              })
            }
          >
            Открыть и проверить набор
          </button>
        </div>
        {busy && <p role="status">Подготовка и проверка… {progress}</p>}
        {preparing && (
          <button
            className="button secondary"
            onClick={() =>
              void feature("offline-cancel", {}, mode).catch((e) =>
                setError(String(e)),
              )
            }
          >
            Отменить подготовку набора
          </button>
        )}
        {error && (
          <div role="alert" className="inline-note warning-text">
            {error}
          </div>
        )}
        {report && (
          <div className="transfer-row">
            <h3>
              {report.verified
                ? "Комплектность и доверенные SHA-256 подтверждены"
                : "Демонстрационный результат — реальные файлы не проверялись"}
            </h3>
            <p className="break-path">{report.folder}</p>
            <p>{report.requirements}</p>
            <ul>
              {report.packages.map((p) => (
                <li key={p.appId}>
                  {getApp(p.appId).name} · {p.version} · {p.architecture} ·{" "}
                  {p.file}
                </li>
              ))}
            </ul>
            <button
              className="button primary"
              disabled={
                busy || running || !report.compatible || !report.verified
              }
              onClick={() =>
                void work(async () => {
                  onPlan(
                    await feature<Plan>(
                      "offline-prepare",
                      { folder: report.folder },
                      mode,
                    ),
                  );
                })
              }
            >
              Просмотреть план локальной установки
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
