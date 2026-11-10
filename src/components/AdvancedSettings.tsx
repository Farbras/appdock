import { useEffect, useState } from "react";
import {
  feature,
  backgroundDefaults,
  type BackgroundPreferences,
} from "../feature-api";
import { date } from "../screens/RunsScreen";
import { appVersion } from "../diagnostics";
import type { Settings } from "../types";
export function AdvancedSettings({
  mode,
  running,
  notify,
}: {
  mode: Settings["mode"];
  running: boolean;
  notify: (s: string) => void;
}) {
  const [draft, setDraft] = useState<BackgroundPreferences | null>(null);
  const [status, setStatus] = useState<{
    revision: number;
    checkedAt?: number;
    configured: boolean;
    limitations: string;
  } | null>(null);
  const [background, setBackground] = useState<{
    checkedAt?: number;
    error?: string;
  }>({});
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void Promise.all([
      feature<{
        preferences: BackgroundPreferences;
        status: typeof background;
      }>("background-state", {}, mode),
      feature<{ status: NonNullable<typeof status> }>(
        "catalog-snapshot",
        {},
        mode,
      ),
    ])
      .then(([b, c]) => {
        if (alive) {
          setDraft(b.preferences);
          setBackground(b.status);
          setStatus(c.status);
        }
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
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
      <section className="settings-section">
        <h2>Фоновая работа и загрузки</h2>
        {mode === "demo" && (
          <p className="inline-note">
            ДЕМО · настройки фона виртуальные; автозапуск и уведомления Windows
            не изменяются.
          </p>
        )}
        {!draft ? (
          <p role="status">Читаем настройки…</p>
        ) : (
          <>
            <div className="setting-row">
              <div>
                <strong>Расписание проверки программ</strong>
                <p>
                  Проверяет доступные обновления при работающем AppDock, включая
                  трей. После пропущенного времени — одна проверка. Установки
                  всегда требуют просмотра плана.
                </p>
              </div>
              <select
                aria-label="Расписание проверки обновлений"
                value={draft.intervalHours}
                onChange={(e) =>
                  setDraft({ ...draft, intervalHours: Number(e.target.value) })
                }
              >
                {[
                  [0, "Выключено"],
                  [1, "Каждый час"],
                  [6, "Каждые 6 часов"],
                  [12, "Каждые 12 часов"],
                  [24, "Раз в сутки"],
                  [48, "Раз в 2 дня"],
                  [168, "Раз в неделю"],
                ].map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <p className="muted-text">
              Последняя фоновая проверка: {date(background.checkedAt)}{" "}
              {background.error && `· ${background.error}`}
            </p>
            {(
              [
                [
                  "autostart",
                  "Запускать при входе в Windows",
                  "Добавит или удалит запись AppDock в автозапуске текущего пользователя; запуск происходит в трее.",
                ],
                [
                  "closeToTray",
                  "Закрывать окно в трей",
                  "Крестик скрывает окно; приложение продолжает работать. Для полного выхода используйте «Выйти» в меню трея. При выключении крестик сохраняет прямые загрузки и выходит; работающий установщик задержит выход.",
                ],
                [
                  "notifications",
                  "Системные уведомления",
                  "Сообщать об окончании очереди, ошибках и необходимости участия. Повторы одинакового сообщения подавляются на сутки. Доставка зависит от настроек уведомлений Windows.",
                ],
                [
                  "preventSleep",
                  "Не переходить в сон во время работы очереди",
                  "Удерживает систему активной во время выполнения задач; при остановке, общей паузе и завершении блокировка снимается. Экран может гаснуть.",
                ],
              ] as const
            ).map(([key, label, help]) => (
              <div className="setting-row" key={key}>
                <div>
                  <strong>{label}</strong>
                  <p>{help}</p>
                </div>
                <input
                  type="checkbox"
                  aria-label={label}
                  checked={draft[key]}
                  onChange={(e) =>
                    setDraft({ ...draft, [key]: e.target.checked })
                  }
                />
              </div>
            ))}
            <div className="setting-row">
              <div>
                <strong>Лимит прямых загрузок, КиБ/с</strong>
                <p>
                  0 — без ограничения. Применяется к каждой прямой загрузке
                  AppDock и подготовке офлайн-набора. WinGet, Marketplace и
                  сторонние установщики этим лимитом не управляются.
                </p>
              </div>
              <input
                aria-label="Лимит прямых загрузок"
                type="number"
                min="0"
                max="1000000"
                value={draft.downloadLimitKib}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    downloadLimitKib: Number(e.target.value),
                  })
                }
              />
            </div>
            <p className="inline-note">
              Сохранение применит выбранное расписание, поведение закрытия и
              ограничения. Переключатель автозапуска меняет запись Windows для
              текущего пользователя.
            </p>
            <button
              className="button primary"
              disabled={
                busy ||
                running ||
                !Number.isInteger(draft.downloadLimitKib) ||
                draft.downloadLimitKib < 0 ||
                draft.downloadLimitKib > 1_000_000
              }
              onClick={() =>
                void work(async () => {
                  const p = await feature<BackgroundPreferences>(
                    "save-background",
                    { ...backgroundDefaults, ...draft, demo: mode === "demo" },
                    mode,
                  );
                  setDraft(p);
                  notify(
                    mode === "demo"
                      ? "ДЕМО: виртуальные настройки сохранены"
                      : "Настройки фоновой работы сохранены",
                  );
                })
              }
            >
              Сохранить настройки фона
            </button>
          </>
        )}
      </section>
      <section className="settings-section">
        <h2>Каталог AppDock</h2>
        <p>
          Версия:{" "}
          {status
            ? status.revision
              ? `подписанная ревизия ${status.revision}`
              : `встроенный каталог ${appVersion}`
            : "читается"}{" "}
          · последняя проверка: {date(status?.checkedAt)}
        </p>
        <p>{status?.limitations}</p>
        {status && !status.configured && (
          <p className="inline-note">
            Production-адрес и публичный ключ публикации не настроены.
            Используется встроенный каталог. Механизм подписи проверяется
            отдельными тестами; тестовый источник не используется в приложении.
          </p>
        )}
        <div className="row-actions">
          <button
            className="button secondary"
            disabled={busy || running || !status?.configured}
            onClick={() =>
              void work(async () => {
                const r = await feature<{ available: boolean }>(
                  "catalog-check",
                  {},
                  mode,
                );
                setAvailable(r.available);
                setStatus(
                  (
                    await feature<{ status: NonNullable<typeof status> }>(
                      "catalog-snapshot",
                      {},
                      mode,
                    )
                  ).status,
                );
                notify(
                  r.available
                    ? "Найден подписанный каталог; можно применить"
                    : "Каталог актуален",
                );
              })
            }
          >
            Проверить обновление каталога
          </button>
          <button
            className="button primary"
            disabled={busy || running || !available}
            onClick={() =>
              void work(async () => {
                await feature("catalog-apply", {}, mode);
                location.reload();
              })
            }
          >
            Применить каталог и перезагрузить интерфейс
          </button>
        </div>
        <p className="muted-text">
          Применение атомарно сохраняет проверенную версию и предыдущую копию.
          Невыполненные планы нужно проверить заново.
        </p>
      </section>
      {error && (
        <p role="alert" className="inline-note warning-text">
          {error}
        </p>
      )}
      {busy && <p role="status">Выполняется операция…</p>}
    </>
  );
}
