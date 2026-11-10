import { useState } from "react";
import vsProfiles from "../../catalog/vs-profiles.json";
import {
  programs,
  taskCount,
  scopeNames,
  optionLabel,
  optionValue,
} from "../display";
import { actionNames, getApp } from "../catalog";
import type { Plan, Selection, Settings } from "../types";
import { Modal } from "./ui";
export function PlanDialog({
  plan,
  settings,
  busy,
  onClose,
  onStart,
  onEdit,
  onRemove,
  onRefresh,
}: {
  plan: Plan;
  settings: Settings;
  busy: boolean;
  onClose: () => void;
  onStart: () => void;
  onEdit: (s: Selection) => void;
  onRemove: (id: string) => void;
  onRefresh: () => void;
}) {
  const [ack, setAck] = useState(false);
  const tasks = plan.items.flatMap((i) => i.tasks);
  const local = tasks.some((t) => t.offlineRoot);
  const operationPlan = tasks.some((t) => t.operation);
  const counts = Object.entries(
    tasks.reduce(
      (r, t) => ({ ...r, [t.action]: (r[t.action] || 0) + 1 }),
      {} as Record<string, number>,
    ),
  );
  return (
    <Modal title="Проверим всё перед запуском" wide onClose={onClose}>
      <div className="modal-body">
        <h3>
          {programs(new Set(plan.items.map((i) => i.appId)).size)} ·{" "}
          {taskCount(tasks.length)}
        </h3>
        <p className="muted-text">
          {plan.mode === "demo"
            ? "Демонстрация без изменения компьютера"
            : "Рабочий режим"}{" "}
          ·{" "}
          {operationPlan
            ? "Последовательное выполнение подтверждённого плана"
            : local
              ? "Последовательная локальная установка без скачивания"
              : settings.skipCurrent
                ? "Пропускать актуальные версии"
                : "Проверять обновление установленных"}{" "}
          {!local && !operationPlan && (
            <> · параллельных загрузок: {settings.parallelDownloads}</>
          )}
        </p>
        <div className="action-counts">
          {counts.map(([a, n]) => (
            <span className="badge" key={a}>
              {actionNames[a]}: {n}
            </span>
          ))}
        </div>
        {plan.warnings.map((w, i) => (
          <p className="inline-note" key={i}>
            {w}
          </p>
        ))}
        <div className="plan-items">
          {plan.items.map((item) => {
            if (operationPlan)
              return (
                <section
                  className="plan-item plan-expanded"
                  key={item.tasks[0]?.id || item.appId}
                >
                  <div>
                    <h3>{item.name}</h3>
                    <p>{actionNames[item.action]}</p>
                    {item.installedVersion && (
                      <p>Установленная версия: {item.installedVersion}</p>
                    )}
                    <p>{item.expected}</p>
                    {item.warnings.map((w, i) => (
                      <p className="file-detail" key={i}>
                        {w}
                      </p>
                    ))}
                    {item.tasks[0]?.operation?.instance && (
                      <p>
                        Область:{" "}
                        {item.tasks[0].operation.instance.scope === "user"
                          ? "Текущий пользователь"
                          : "Все пользователи"}
                      </p>
                    )}
                  </div>
                </section>
              );
            const app = getApp(item.appId);
            const s = item.selection;
            const edition = app.editions.find(
              (e) => e.id === (s.options.edition || app.editions[0]?.id),
            );
            const profile = vsProfiles.editions.find(
              (e) => e.id === edition?.id,
            );
            return (
              <section className="plan-item plan-expanded" key={item.appId}>
                <div>
                  <h3>{item.name}</h3>
                  <p>
                    {actionNames[item.action]}
                    {item.expected !== item.action
                      ? ` · ${actionNames[item.expected] || item.expected}`
                      : ""}
                  </p>
                  <p>
                    Версия:{" "}
                    {s.version ||
                      (app.id === "python"
                        ? "3.12.10 · проверенный пакет"
                        : "последняя доступная в источнике")}
                    {edition ? ` · ${edition.name}` : ""}
                  </p>
                  <p>
                    Установлена: {item.installedVersion || "не обнаружена"} ·
                    область:{" "}
                    {scopeNames[
                      String(s.options.scope || app.install.scope || "default")
                    ] || "Определяет установщик"}
                  </p>
                  <dl className="parameter-list">
                    {Object.entries(s.options).map(([key, v]) => (
                      <div key={key}>
                        <dt>{optionLabel(app, key)}</dt>
                        <dd>{optionValue(app, key, v)}</dd>
                      </div>
                    ))}
                  </dl>
                  <details open>
                    <summary>Задачи ({item.tasks.length})</summary>
                    <ol>
                      {item.tasks.map((t) => (
                        <li key={t.id}>
                          {t.name} — {actionNames[t.action]}
                          {t.dependencies?.length
                            ? ` · зависимостей: ${t.dependencies.length}`
                            : ""}
                        </li>
                      ))}
                    </ol>
                  </details>
                  {s.options.fullProfile === true && profile && (
                    <details>
                      <summary>
                        Дополнительные компоненты Visual Studio (
                        {profile.components.length})
                      </summary>
                      <ul>
                        {profile.components.map((c) => (
                          <li key={c.id}>{c.id}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {item.warnings.map((w, i) => (
                    <p
                      key={i}
                      className={item.blocked ? "warning-text" : "muted-text"}
                    >
                      {w}
                    </p>
                  ))}
                  {item.excluded && (
                    <strong className="warning-text">
                      Исключено из выполнения, останется в выборе
                    </strong>
                  )}
                  <div className="row-actions">
                    <button
                      className="button secondary"
                      onClick={() => onEdit(s)}
                      disabled={busy}
                    >
                      Изменить параметры
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => onRemove(item.appId)}
                      disabled={busy}
                    >
                      Убрать из запуска
                    </button>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
        <p className="muted-text">
          {local
            ? "WinGet не используется"
            : `WinGet: ${plan.system.winget || "не обнаружен / демо"}`}{" "}
          · место:{" "}
          {plan.system.freeDiskMb == null
            ? "не определено"
            : `${(plan.system.freeDiskMb / 1024).toFixed(1)} ГБ`}{" "}
          · {plan.system.arch}
        </p>
        {!operationPlan && (
          <button
            className="button secondary"
            onClick={onRefresh}
            disabled={busy}
          >
            Повторить проверку
          </button>
        )}
        <label className="acknowledgement">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          <span>
            {plan.mode === "demo"
              ? "Запустить демонстрацию выполнения без изменения компьютера."
              : "Я проверил состав и условия лицензирования. Разрешаю перечисленные действия; UAC и ручные шаги потребуют участия."}
          </span>
        </label>
      </div>
      <div className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          Вернуться к выбору
        </button>
        <button
          className="button primary"
          disabled={
            !ack || busy || !tasks.length || plan.items.some((i) => i.blocked)
          }
          onClick={onStart}
        >
          {busy
            ? "Подготовка…"
            : plan.mode === "demo"
              ? "Запустить демо"
              : "Начать выполнение"}
        </button>
      </div>
    </Modal>
  );
}
