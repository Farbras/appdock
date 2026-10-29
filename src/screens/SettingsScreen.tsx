import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookOpen,
  Check,
  FolderOpen,
  Info,
  Monitor,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { api, native } from "../api";
import { apps } from "../catalog";
import { appVersion } from "../diagnostics";
import type { QueueState, Settings, SystemInfo } from "../types";

import { Brand, Toggle } from "../components/ui";

export function SettingsScreen({
  settings,
  changeSettings,
  notify,
  queue,
  system,
  setSystem,
}: {
  settings: Settings;
  changeSettings: (p: Partial<Settings>) => void;
  notify: (message: string) => void;
  queue: QueueState;
  system: SystemInfo | null;
  setSystem: (s: SystemInfo) => void;
}) {
  return (
    <div className="settings-page">
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <Monitor size={18} />
            <h2>Внешний вид</h2>
          </div>
        </div>
        <div className="theme-options">
          {[
            ["dark", "Тёмная", Moon],
            ["light", "Светлая", Sun],
            ["system", "Как в системе", Monitor],
          ].map(([id, label, Component]) => {
            const C = Component as LucideIcon;
            return (
              <button
                key={id as string}
                className={`theme-choice ${settings.theme === id ? "active" : ""}`}
                onClick={() =>
                  changeSettings({ theme: id as Settings["theme"] })
                }
              >
                <div className={`theme-preview preview-${id}`}>
                  <span />
                  <span />
                  <span />
                </div>
                <div>
                  <C size={16} />
                  {label as string}
                  {settings.theme === id && <Check size={16} />}
                </div>
              </button>
            );
          })}
        </div>
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <ShieldCheck size={18} />
            <h2>Режим работы</h2>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Демонстрационный режим</strong>
            <p>
              {native
                ? "Имитирует очередь без установки и изменения компьютера."
                : "Браузерный просмотр всегда работает в деморежиме. Для системных операций запустите настольное приложение."}
            </p>
          </div>
          <Toggle
            checked={settings.mode === "demo"}
            label="Демонстрационный режим"
            onChange={() => {
              if (!native) {
                notify("Рабочий режим доступен в настольной версии AppDock");
                return;
              }
              if (queue.running) {
                notify("Дождитесь завершения текущей очереди");
                return;
              }
              changeSettings({
                mode: settings.mode === "demo" ? "live" : "demo",
              });
            }}
          />
        </div>
        <div className="setting-row">
          <div>
            <strong>Пропускать актуальные программы</strong>
            <p>Перед каждой задачей заново проверять установленную версию.</p>
          </div>
          <Toggle
            checked={settings.skipCurrent}
            label="Пропускать актуальные программы"
            onChange={() =>
              changeSettings({ skipCurrent: !settings.skipCurrent })
            }
          />
        </div>
        <div className="setting-row">
          <div>
            <strong>Параллельные загрузки</strong>
            <p>
              Только для действия «Только скачать». Установщики запускаются по
              одному.
            </p>
          </div>
          <select
            aria-label="Количество параллельных загрузок"
            value={settings.parallelDownloads}
            onChange={(e) =>
              changeSettings({
                parallelDownloads: Number(e.target.value),
              })
            }
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <Activity size={18} />
            <h2>Состояние системы</h2>
          </div>
          <button
            className="text-button"
            onClick={() =>
              void api
                .system(settings.mode)
                .then(setSystem)
                .catch((e) => notify(String(e)))
            }
          >
            <RefreshCw size={14} />
            Обновить
          </button>
        </div>
        <div className="system-grid">
          {[
            ["Платформа", system?.os || "Проверяется"],
            ["Архитектура", system?.arch || "—"],
            ["WinGet", system?.winget || "Не обнаружен / не проверен"],
            [
              "Свободное место",
              system?.freeDiskMb
                ? `${(system.freeDiskMb / 1024).toFixed(1)} ГБ`
                : "Не определено",
            ],
            [
              "Виртуализация",
              system?.virtualization === true
                ? "Включена"
                : system?.virtualization === false
                  ? "Выключена"
                  : "Не определена",
            ],
            ["WSL", system?.wsl || "Не проверено"],
            ["Hyper-V", system?.hyperV || "Не проверено"],
          ].map(([name, value]) => (
            <div key={name}>
              <span>{name}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <button
          className="button secondary"
          onClick={() =>
            void api.openDownloads().catch((e) => notify(String(e)))
          }
        >
          <FolderOpen size={16} />
          Открыть папку загрузок
        </button>
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <BookOpen size={18} />
            <h2>Источники и ограничения</h2>
          </div>
          <span className="badge">Проверка ID источников · см. каталог</span>
        </div>
        <p className="settings-copy">
          В каталоге {apps.length} продуктов. Для{" "}
          {apps.filter((a) => a.install.verification === "verified").length}{" "}
          проверены пакеты WinGet. Перед выполнением пакет запрашивается заново
          из явно указанного источника winget. Контроль хеша выполняет WinGet;
          отключение проверки не поддерживается.
        </p>
        <div className="limitations-list">
          <p>
            <Info size={16} />
            <span>
              Коммерческие САПР, Office, ArtCraft и серверы БД требуют
              официального мастера. Автоматическая настройка таких продуктов не
              подтверждена.
            </span>
          </p>
          <p>
            <Info size={16} />
            <span>
              Профиль Visual Studio формируется по снимку официального каталога.
              Окончательные совместимость и размер определяет Visual Studio
              Installer; пропущенные компоненты требуют проверки.
            </span>
          </p>
          <p>
            <Info size={16} />
            <span>
              SDK Android, образы, WSL, компоненты ОС, Podman machine и
              эмуляторы облачных БД выполняются отдельными ручными шагами по
              официальной инструкции.
            </span>
          </p>
          <p>
            <Info size={16} />
            <span>
              Обычный веб-ярлык поддерживается. Установка PWA, создание облачных
              ресурсов и автоматическая миграция баз не выполняются.
            </span>
          </p>
        </div>
        <div className="about-footer">
          <Brand />
          <span>Версия {appVersion} · Tauri 2 + React + Rust</span>
        </div>
      </section>
    </div>
  );
}
