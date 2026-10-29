import { actionNames } from "../catalog";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  Boxes,
  Circle,
  Download,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import { getApp, isWeb } from "../catalog";
import type {
  InstalledApp,
  Product,
  QueueState,
  Selection,
  Settings,
} from "../types";

import { Logo } from "./ui";

import type { Dispatch, SetStateAction } from "react";
export function SelectionPane({
  selection,
  settings,
  queue,
  loading,
  cartOpen,
  setCartOpen,
  setSelection,
  setWizard,
  setDetail,
  getInstalled,
  toggleApp,
  setEditingPreset,
  setSaveName,
  review,
}: {
  selection: Selection[];
  settings: Settings;
  queue: QueueState;
  loading: boolean;
  cartOpen: boolean;
  setCartOpen: Dispatch<SetStateAction<boolean>>;
  setSelection: Dispatch<SetStateAction<Selection[]>>;
  setWizard: (b: boolean) => void;
  setDetail: (a: Product | null) => void;
  getInstalled: (a: Product) => InstalledApp | undefined;
  toggleApp: (a: Product) => void;
  setEditingPreset: (id: string | null) => void;
  setSaveName: (s: string | null) => void;
  review: (downloadOnly?: boolean) => Promise<void>;
}) {
  const selectedApps = selection.filter((s) => !isWeb(getApp(s.appId)));
  const selectedServices = selection.filter((s) => isWeb(getApp(s.appId)));
  const extensionCount = selection.reduce(
    (sum, s) => sum + (s.action === "install" ? s.extensions.length : 0),
    0,
  );
  const knownDownload = selection.reduce(
    (sum, s) => sum + (getApp(s.appId).downloadMb || 0),
    0,
  );
  const unknownDownload = selection.some(
    (s) => !isWeb(getApp(s.appId)) && getApp(s.appId).downloadMb === null,
  );
  const taskTotal = selection.length + extensionCount;

  return (
    <aside className={`selection-pane ${cartOpen ? "cart-open" : ""}`}>
      <button
        className="cart-disclosure button secondary"
        aria-expanded={cartOpen}
        onClick={() => setCartOpen((v) => !v)}
      >
        Ваш выбор · {selection.length} {cartOpen ? "Свернуть" : "Показать"}
      </button>
      <div className="selection-header">
        <div>
          <span className="cart-icon">
            <Download size={18} />
          </span>
          <h2>Ваш выбор</h2>
          <span className="selection-counter">{selection.length}</span>
        </div>
        <button
          className="icon-button"
          disabled={!selection.length}
          onClick={() => setSelection([])}
          aria-label="Очистить выбор"
        >
          <Trash2 size={16} />
        </button>
      </div>
      <div className="selection-scroll">
        {selection.length === 0 ? (
          <div className="cart-empty">
            <div className="empty-stack">
              <div />
              <div />
              <span>
                <Plus size={26} />
              </span>
            </div>
            <h3>Начнём с нужного</h3>
            <p>
              Выбирайте программы в каталоге.
              <br />
              Они появятся здесь.
            </p>
            <button className="text-button" onClick={() => setWizard(true)}>
              <WandSparkles size={15} />
              Помочь с выбором
            </button>
          </div>
        ) : (
          <>
            {selectedApps.length > 0 && (
              <div className="cart-group-label">
                ПРОГРАММЫ И КОМПОНЕНТЫ<span>{selectedApps.length}</span>
              </div>
            )}
            {selectedApps.map((s) => {
              const a = getApp(s.appId);
              return (
                <div className="cart-item" key={s.appId}>
                  <Logo app={a} small />
                  <button
                    className="cart-item-info"
                    onClick={() => setDetail(a)}
                  >
                    <strong>{a.name}</strong>
                    <span>
                      {s.action === "guide"
                        ? "Открыть инструкцию"
                        : s.action === "download"
                          ? "Только скачать"
                          : getInstalled(a)?.availableVersion
                            ? "Обновить"
                            : "Установить"}
                      {s.extensions.length > 0 &&
                        ` · +${s.extensions.length} расширений`}
                    </span>
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Убрать ${a.name}`}
                    onClick={() => toggleApp(a)}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
            {selectedServices.length > 0 && (
              <div className="cart-group-label web-group">
                ВЕБ-СЕРВИСЫ<span>{selectedServices.length}</span>
              </div>
            )}
            {selectedServices.map((s) => {
              const a = getApp(s.appId);
              return (
                <div className="cart-item" key={s.appId}>
                  <Logo app={a} small />
                  <button
                    className="cart-item-info"
                    onClick={() => setDetail(a)}
                  >
                    <strong>{a.name}</strong>
                    <span>
                      {s.action === "shortcut"
                        ? "Создать ярлык"
                        : "Открыть сервис"}
                    </span>
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Убрать ${a.name}`}
                    onClick={() => toggleApp(a)}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
            <button
              className="save-selection"
              onClick={() => {
                setEditingPreset(null);
                setSaveName("Мой набор");
              }}
            >
              <Boxes size={16} />
              Сохранить в набор
              <Plus size={15} />
            </button>
          </>
        )}
        <div className="cart-tip">
          <span className="tip-icon">
            <ShieldCheck size={18} />
          </span>
          <div>
            <strong>Только нужные программы</strong>
            <p>
              Официальные источники.
              <br />
              Ручные шаги отмечены в плане.
            </p>
          </div>
        </div>
      </div>
      <div className="selection-bottom">
        {settings.mode === "demo" && (
          <div className="demo-notice">
            <Circle size={9} fill="currentColor" />
            <span>Демо · без изменений компьютера</span>
          </div>
        )}
        <div className="action-counts">
          {Object.entries(
            selection.reduce(
              (counts, s) => ({
                ...counts,
                [s.action]: (counts[s.action] || 0) + 1,
              }),
              {} as Record<string, number>,
            ),
          ).map(([action, n]) => (
            <span className="badge" key={action}>
              {actionNames[action]}: {n}
            </span>
          ))}
          {extensionCount > 0 && (
            <span className="badge">Расширения: {extensionCount}</span>
          )}
        </div>
        <div className="selection-stats">
          <div>
            <span>Задач в очереди</span>
            <strong>{taskTotal}</strong>
          </div>
          <div>
            <span>Размер загрузки</span>
            <strong>
              {selection.length
                ? unknownDownload
                  ? knownDownload
                    ? `от ${knownDownload} МБ`
                    : "Уточняется"
                  : knownDownload
                    ? `${knownDownload} МБ`
                    : "—"
                : "—"}
            </strong>
          </div>
          <div>
            <span>Место на диске</span>
            <strong>{selection.length ? "Проверим в плане" : "—"}</strong>
          </div>
        </div>
        <button
          className="button primary install-button"
          disabled={!selection.length || loading || queue.running}
          onClick={() => void review()}
        >
          {loading ? (
            <Loader2 size={17} className="spin" />
          ) : (
            <ArrowDownToLine size={18} />
          )}
          <span>{loading ? "Проверяем план…" : "Проверить план"}</span>
          <ArrowRight size={16} />
        </button>
        <button
          className="download-only"
          disabled={
            !selection.some((s) => getApp(s.appId).install.download) ||
            loading ||
            queue.running
          }
          onClick={() => void review(true)}
        >
          <ArrowDown size={14} />
          Только скачать
          <span>
            {selection.filter((s) => getApp(s.appId).install.download).length ||
              ""}
          </span>
        </button>
        <p className="review-hint">
          <ShieldCheck size={12} />
          Сначала покажем итоговый план
        </p>
      </div>
    </aside>
  );
}
