import { useState } from "react";
import vsProfiles from "../../catalog/vs-profiles.json";
const scopeNames: Record<string, string> = {
  user: "Текущий пользователь",
  machine: "Все пользователи",
  default: "Определяет установщик",
};
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
          {plan.items.length} программ · {tasks.length} задач
        </h3>
        <p className="muted-text">
          {plan.mode === "demo"
            ? "Демонстрация без изменения компьютера"
            : "Рабочий режим"}{" "}
          ·{" "}
          {settings.skipCurrent
            ? "Пропускать актуальные версии"
            : "Проверять обновление установленных"}{" "}
          · параллельных загрузок: {settings.parallelDownloads}
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
                        <dt>
                          {app.options.find((o) => o.id === key)?.label ||
                            (
                              {
                                edition: "Редакция",
                                fullProfile: "Полный профиль Visual Studio",
                              } as Record<string, string>
                            )[key] ||
                            key}
                        </dt>
                        <dd>
                          {typeof v === "boolean"
                            ? v
                              ? "Да"
                              : "Нет"
                            : key === "scope"
                              ? scopeNames[String(v)] || String(v)
                              : key === "edition"
                                ? app.editions.find((e) => e.id === v)?.name ||
                                  String(v)
                                : String(v)}
                        </dd>
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
                    >
                      Изменить параметры
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => onRemove(item.appId)}
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
          WinGet: {plan.system.winget || "не обнаружен / демо"} · место:{" "}
          {plan.system.freeDiskMb == null
            ? "не определено"
            : `${(plan.system.freeDiskMb / 1024).toFixed(1)} ГБ`}{" "}
          · {plan.system.arch}
        </p>
        <button
          className="button secondary"
          onClick={onRefresh}
          disabled={busy}
        >
          Повторить проверку
        </button>
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
