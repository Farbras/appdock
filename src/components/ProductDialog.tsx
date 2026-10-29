import { matchInstalled } from "../catalog";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDown,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  Code2,
  Download,
  ExternalLink,
  Globe,
  HardDrive,
  Heart,
  Info,
  Monitor,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useState } from "react";
import vsProfiles from "../../catalog/vs-profiles.json";
import { api } from "../api";
import {
  addExtension,
  defaultSelection,
  extensionProfiles,
  extensions,
  isWeb,
  removeExtension,
  typeNames,
} from "../catalog";
import {
  downloadJson,
  readStorage,
  safeWriteStorage,
  selectionErrors,
} from "../storage";
import type { InstalledApp, Product, Selection } from "../types";

import { Logo, Modal } from "./ui";
export function ProductDialog({
  app,
  selection,
  installed: initialInstalled,
  installedRecords,
  mode,
  onClose,
  onApply,
  favorite,
  onFavorite,
  notify,
}: {
  app: Product;
  selection?: Selection;
  installed?: InstalledApp;
  installedRecords?: InstalledApp[];
  mode: string;
  onClose: () => void;
  onApply: (s: Selection) => void;
  favorite: boolean;
  onFavorite: () => void;
  notify: (s: string) => void;
}) {
  const [draft, setDraft] = useState<Selection>(() =>
    structuredClone(selection || defaultSelection(app)),
  );
  const installed = installedRecords
    ? matchInstalled(app, installedRecords, draft)
    : initialInstalled;
  const [profileName, setProfileName] = useState("Текущий состав");
  const [profiles, setProfiles] = useState<Record<string, string[]>>(() => {
    const saved = readStorage<Record<string, string[]>>(
      "extension-profiles",
      {},
    );
    return Object.fromEntries(
      Object.entries(extensionProfiles).map(([name, ids]) => [
        name,
        Array.isArray(saved[name])
          ? saved[name].filter((id) => extensions.some((e) => e.id === id))
          : ids,
      ]),
    );
  });
  const errors = selectionErrors(draft);
  const [portStatus, setPortStatus] = useState("");
  const opt = (key: string, value: string | number | boolean) =>
    setDraft((s) => ({ ...s, options: { ...s.options, [key]: value } }));
  const edition = String(draft.options.edition || "community");
  const profile =
    vsProfiles.editions.find((e) => e.id === edition) || vsProfiles.editions[0];
  return (
    <Modal title="Параметры программы" wide onClose={onClose}>
      <div className="modal-body">
        <div className="product-detail-heading">
          <Logo app={app} />
          <div>
            <h2>{app.name}</h2>
            <p>
              {app.publisher} · {typeNames[app.type]}
            </p>
          </div>
          <button
            className={`icon-button ${favorite ? "hearted" : ""}`}
            onClick={onFavorite}
            aria-label="Избранное"
          >
            <Heart size={20} fill={favorite ? "currentColor" : "none"} />
          </button>
        </div>
        <p className="detail-description">{app.description}</p>
        <div className="detail-meta">
          <span className="badge">
            <Monitor size={12} />
            {app.platforms.join(" / ")}
          </span>
          <span className="badge">{app.version}</span>
          {installed && (
            <span className="badge green">Установлена {installed.version}</span>
          )}
          <span
            className={`badge ${app.install.verification === "verified" ? "green" : "amber"}`}
          >
            <ShieldCheck size={12} />
            {app.install.verification === "verified"
              ? "ID пакета проверен"
              : "Автоматизация не проверена"}
          </span>
        </div>
        {app.notes && (
          <div className="inline-note">
            <Info size={18} />
            <span>{app.notes}</span>
          </div>
        )}
        <div className="detail-section">
          <h3>Действие</h3>
          <div className="action-options">
            {(isWeb(app)
              ? [
                  ["open", "Открыть сервис", Globe],
                  ["shortcut", "Создать ярлык", ArrowUpRight],
                ]
              : app.install.method === "winget" &&
                  app.platforms.includes("windows")
                ? [
                    [
                      "install",
                      installed?.availableVersion ? "Обновить" : "Установить",
                      Download,
                    ],
                    ...(app.install.download
                      ? [["download", "Только скачать", ArrowDown]]
                      : []),
                    ["guide", "Открыть источник", ExternalLink],
                  ]
                : [["guide", "Открыть инструкцию", BookOpen]]
            ).map(([id, label, C]) => {
              const Component = C as LucideIcon;
              return (
                <button
                  key={id as string}
                  className={`button secondary ${draft.action === id ? "selected" : ""}`}
                  onClick={() =>
                    setDraft((s) => ({
                      ...s,
                      action: id as Selection["action"],
                    }))
                  }
                >
                  <Component size={15} />
                  {label as string}
                  {draft.action === id && <Check size={14} />}
                </button>
              );
            })}
          </div>
        </div>
        {app.install.method === "winget" && app.id !== "python" && (
          <div className="detail-section">
            <h3>Версия</h3>
            <label className="version-picker">
              <span>Устанавливаемая версия</span>
              <select
                aria-label="Устанавливаемая версия"
                value={draft.version || "latest"}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    version:
                      e.target.value === "latest" ? undefined : e.target.value,
                  }))
                }
              >
                <option value="latest">Последняя доступная в WinGet</option>
                <option value={app.version}>
                  {app.version} · проверена в каталоге
                </option>
                {draft.version && draft.version !== app.version && (
                  <option value={draft.version}>
                    {draft.version} · из набора, требует проверки
                  </option>
                )}
              </select>
            </label>
            <p className="muted-text">
              В наборе сохраняется выбранная политика версии: последняя
              доступная или конкретная. Старые версии требуют проверки
              источника.
            </p>
          </div>
        )}
        {app.editions.length > 0 && (
          <div className="detail-section">
            <h3>Редакция / продукт</h3>
            {app.editions.map((e) => (
              <label key={e.id} className="edition-option">
                <input
                  type="radio"
                  name="edition"
                  checked={
                    String(draft.options.edition || app.editions[0].id) === e.id
                  }
                  onChange={() => opt("edition", e.id)}
                />
                <div>
                  <strong>{e.name}</strong>
                  <p>{e.description}</p>
                </div>
              </label>
            ))}
          </div>
        )}
        {app.options.length > 0 && (
          <div className="detail-section">
            <h3>
              {app.install.method === "manual"
                ? "Памятка для установщика"
                : "Параметры установки"}
            </h3>
            <div className="product-options">
              {app.options.map((o) => (
                <label
                  className={`option-row ${o.type === "boolean" ? "boolean-option" : ""}`}
                  key={o.id}
                >
                  <div>
                    <strong>{o.label}</strong>
                    {o.help && <p>{o.help}</p>}
                  </div>
                  {o.type === "boolean" ? (
                    <input
                      type="checkbox"
                      checked={Boolean(draft.options[o.id] ?? o.default)}
                      onChange={(e) => opt(o.id, e.target.checked)}
                    />
                  ) : o.type === "select" ? (
                    <select
                      value={String(draft.options[o.id] ?? o.default)}
                      onChange={(e) => opt(o.id, e.target.value)}
                    >
                      {o.values?.map((v) => (
                        <option key={v} value={v}>
                          {v === "user"
                            ? "Текущий пользователь"
                            : v === "machine"
                              ? "Все пользователи"
                              : v}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={o.type === "number" ? "number" : "text"}
                      min={o.type === "number" ? 1 : undefined}
                      max={o.type === "number" ? 65535 : undefined}
                      maxLength={500}
                      value={String(draft.options[o.id] ?? o.default)}
                      onChange={(e) => {
                        opt(
                          o.id,
                          o.type === "number"
                            ? Number(e.target.value)
                            : e.target.value,
                        );
                        if (o.id === "port") setPortStatus("");
                      }}
                    />
                  )}
                </label>
              ))}
            </div>
            {app.type === "database-server" && (
              <>
                <div className="inline-note">
                  <ShieldCheck size={16} />
                  <span>
                    Пароль задайте в официальном мастере. AppDock его не
                    запрашивает, не сохраняет и не экспортирует. Параметры
                    сервера — памятка для ручной установки.
                  </span>
                </div>
                <button
                  className="button secondary"
                  onClick={async () => {
                    try {
                      if (mode === "demo") {
                        setPortStatus("Демо: порт не проверяется");
                        return;
                      }
                      const available = await api.port(
                        Number(draft.options.port),
                      );
                      setPortStatus(
                        available
                          ? "Порт свободен на момент проверки"
                          : "Порт занят или недоступен. Выберите другой.",
                      );
                    } catch (e) {
                      setPortStatus(String(e));
                    }
                  }}
                >
                  Проверить порт {String(draft.options.port)}
                </button>
                <span className="port-status">{portStatus}</span>
              </>
            )}
          </div>
        )}
        {app.id === "vscode" && draft.action === "install" && (
          <div className="detail-section">
            <div className="section-heading">
              <div>
                <Code2 size={17} />
                <h3>Расширения VS Code</h3>
              </div>
              <span>
                {draft.extensions.length} из {extensions.length}
              </span>
            </div>
            <div className="section-tools wrap">
              <label>
                Профиль расширений{" "}
                <select
                  aria-label="Профиль расширений"
                  value={profileName}
                  onChange={(e) => {
                    setProfileName(e.target.value);
                    if (!profiles[e.target.value]) return;
                    setDraft((s) => ({
                      ...s,
                      extensions: profiles[e.target.value].reduce(
                        (ids, id) => addExtension(ids, id),
                        [] as string[],
                      ),
                    }));
                  }}
                >
                  <option value="Текущий состав">Текущий состав</option>
                  {Object.keys(profiles).map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <button
                className="button secondary"
                disabled={profileName === "Текущий состав"}
                onClick={() => {
                  const next = { ...profiles, [profileName]: draft.extensions };
                  setProfiles(next);
                  safeWriteStorage("extension-profiles", next);
                  notify("Состав профиля расширений сохранён");
                }}
              >
                Сохранить состав профиля
              </button>
            </div>
            <p className="muted-text">
              В профиль текущего пользователя, после установки редактора.
              Зависимые расширения включаются вместе с Python.
            </p>
            <div className="extension-list">
              {extensions.map((e) => (
                <label key={e.id}>
                  <input
                    type="checkbox"
                    checked={draft.extensions.includes(e.id)}
                    onChange={(event) =>
                      setDraft((s) => ({
                        ...s,
                        extensions: event.target.checked
                          ? addExtension(s.extensions, e.id)
                          : removeExtension(s.extensions, e.id),
                      }))
                    }
                  />
                  <span>
                    <strong>{e.name}</strong>
                    <small>{e.id}</small>
                  </span>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`Источник ${e.name}`}
                    onClick={() => {
                      const index = app.sources.findIndex(
                        (s) => s === e.source,
                      );
                      if (index >= 0) void api.source(app.id, index);
                      else
                        window.open(e.source, "_blank", "noopener,noreferrer");
                    }}
                  >
                    <ArrowUpRight size={14} />
                  </button>
                </label>
              ))}
            </div>
          </div>
        )}
        {app.id === "visual-studio" && (
          <div className="detail-section">
            <label className="profile-option">
              <input
                type="checkbox"
                checked={draft.options.fullProfile === true}
                onChange={(e) => opt("fullProfile", e.target.checked)}
              />
              <span>
                <strong>
                  Классические и мобильные приложения — полный набор
                </strong>
                <small>
                  Все нагрузки раздела + обязательные, рекомендуемые и
                  дополнительные компоненты
                </small>
              </span>
            </label>
            {draft.options.fullProfile === true && (
              <>
                <div className="inline-note">
                  <HardDrive size={18} />
                  <span>
                    Снимок каталога {vsProfiles.version}. Нагрузок:{" "}
                    {profile.workloads.length}, компонентов:{" "}
                    {profile.components.length}. Размер уточняется в Visual
                    Studio Installer; часть компонентов может быть неприменима.
                    Проверьте итоговый состав перед подтверждением в Installer.
                  </span>
                </div>
                <details className="profile-details">
                  <summary>
                    Состав профиля и ограничения <ChevronDown size={15} />
                  </summary>
                  {profile.workloads.map((w) => (
                    <p key={w.id}>
                      <Check size={13} />
                      <span>
                        {w.name}
                        <small>{w.id}</small>
                      </span>
                    </p>
                  ))}
                  {profile.excluded.map((e, i) => (
                    <p className="warning-text" key={i}>
                      <Info size={13} />
                      <span>
                        {e.id}
                        <small>{e.reason}</small>
                      </span>
                    </p>
                  ))}
                  <div className="component-ids">
                    {profile.components.map((c) => (
                      <div key={c.id}>
                        <code>{c.id}</code>
                        <span>{c.type}</span>
                      </div>
                    ))}
                  </div>
                </details>
                <button
                  className="button secondary"
                  onClick={() =>
                    downloadJson(
                      `AppDock-${edition}.vsconfig`,
                      JSON.stringify(
                        {
                          version: "1.0",
                          components: profile.components.map((c) => c.id),
                        },
                        null,
                        2,
                      ),
                    )
                  }
                >
                  <Download size={15} />
                  Экспорт .vsconfig
                </button>
              </>
            )}
          </div>
        )}
        {[
          "android-studio",
          "podman",
          "dynamodb",
          "firebase",
          "redis",
          "cassandra",
          "clickhouse",
          "docker",
          "virtualbox",
        ].includes(app.id) && (
          <div className="detail-section">
            <h3>Отдельные шаги и зависимости</h3>
            <p className="muted-text">
              Эти действия не выполняются вместе с основной установкой. Откройте
              официальную инструкцию и подтвердите изменения в соответствующем
              инструменте.
            </p>
            <div className="additional-steps">
              {(app.id === "android-studio"
                ? [
                    "Android SDK",
                    "Android Emulator",
                    "Образы устройств и лицензии",
                  ]
                : app.id === "podman"
                  ? [
                      "Podman Desktop",
                      "Podman machine · создать виртуальную машину",
                    ]
                  : app.id === "dynamodb"
                    ? ["DynamoDB Local · локальное окружение"]
                    : app.id === "firebase"
                      ? ["Firebase Emulator Suite · Node.js / Java / CLI"]
                      : app.id === "docker"
                        ? [
                            "WSL 2 / Hyper-V · проверить и включить компоненты Windows",
                          ]
                        : app.id === "virtualbox"
                          ? ["Аппаратная виртуализация · BIOS / UEFI"]
                          : [
                              "WSL 2 · локальное окружение",
                              "Официальный контейнер · отдельная настройка данных и портов",
                            ]
              ).map((label, i) => (
                <button
                  key={label}
                  onClick={() =>
                    void api
                      .source(app.id, Math.min(i + 1, app.sources.length - 1))
                      .catch((e) => notify(String(e)))
                  }
                >
                  <BookOpen size={16} />
                  <span>{label}</span>
                  <ExternalLink size={14} />
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="detail-section license-section">
          <h3>Лицензия и источник</h3>
          <p>{app.licenseNote}</p>
          <button
            className="text-button"
            onClick={() =>
              void api.source(app.id).catch((e) => notify(String(e)))
            }
          >
            <ExternalLink size={14} />
            {new URL(app.website).hostname}
          </button>
          {app.install.packageId && (
            <p className="package-id">
              <Terminal size={13} />
              {app.install.packageId} · источник winget
            </p>
          )}
          <span className="muted-text">
            Сведения каталога: {app.checkedAt || "проверка не выполнялась"}
            {app.install.verifiedAt
              ? ` · WinGet ${app.install.verifiedAt}`
              : ""}
          </span>
        </div>
      </div>
      {errors.length > 0 && (
        <div className="inline-note warning-text" role="alert">
          {errors.join("; ")}
        </div>
      )}
      {app.install.method === "manual" && (
        <button
          className="button secondary"
          onClick={() =>
            void navigator.clipboard
              .writeText(
                [
                  app.name,
                  app.website,
                  ...Object.entries(draft.options).map(
                    ([key, v]) =>
                      (app.options.find((o) => o.id === key)?.label || key) +
                      ": " +
                      v,
                  ),
                  app.notes,
                ].join("\n"),
              )
              .then(() => notify("Памятка скопирована"))
              .catch(() => notify("Буфер обмена недоступен"))
          }
        >
          Копировать памятку
        </button>
      )}
      <div className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          Закрыть
        </button>
        <button
          className="button primary"
          onClick={() => onApply(draft)}
          disabled={
            errors.length > 0 ||
            (app.id === "vmware" && draft.options.edition === "fusion")
          }
        >
          <Check size={16} />
          {selection ? "Сохранить параметры" : "Добавить в выбор"}
        </button>
      </div>
    </Modal>
  );
}
