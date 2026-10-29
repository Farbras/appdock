import { useState } from "react";
import { api } from "../api";
import { actionNames, getApp, statusNames } from "../catalog";
import { Modal } from "../components/ui";
import { buildDiagnostics, readableReport } from "../diagnostics";
import { currentTasks, success, terminal } from "../queue";
import type { QueueState, QueueTask, Settings, TaskStatus } from "../types";
export const date = (value?: number | null) =>
  value ? new Date(value).toLocaleString("ru-RU") : "—";
export function RunsScreen({
  queue,
  history,
  mode,
  onControl,
  onRetry,
  onEdit,
  notify,
}: {
  queue: QueueState;
  history: boolean;
  mode: Settings["mode"];
  onControl: (action: string, id?: string) => void;
  onRetry: (runId: string, status: TaskStatus, taskId?: string) => void;
  onEdit: (task: QueueTask) => void;
  notify: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [runId, setRunId] = useState("all");
  const [preview, setPreview] = useState<string | null>(null);
  const [structured, setStructured] = useState(true);
  const [redact, setRedact] = useState(true);
  const all = history ? queue.tasks : currentTasks(queue);
  const visible = all.filter(
    (t) =>
      (runId === "all" || t.runId === runId) &&
      (filter === "all" || t.status === filter) &&
      `${t.name} ${t.message} ${t.log.join(" ")}`
        .toLocaleLowerCase("ru")
        .includes(query.toLocaleLowerCase("ru")),
  );
  const active = currentTasks(queue);
  const done = active.filter((t) => terminal(t.status)).length;
  const report = (json: boolean, hide = redact) => {
    setStructured(json);
    setPreview(
      json
        ? JSON.stringify(buildDiagnostics(queue, hide), null, 2)
        : readableReport(queue, hide),
    );
  };
  return (
    <>
      <div className="queue-summary">
        <div>
          <h3>
            {queue.running
              ? queue.paused
                ? "Очередь приостановлена"
                : "Выполняем план"
              : "Результаты запусков"}
          </h3>
          <p>
            {mode === "demo"
              ? "Демонстрация · компьютер не изменяется"
              : "Рабочий режим"}{" "}
            · текущий запуск {done}/{active.length}
          </p>
        </div>
        <div className="row-actions">
          {(queue.running || queue.paused) && (
            <button
              className="button secondary"
              onClick={() => onControl(queue.paused ? "resume" : "pause")}
            >
              {queue.paused ? "Продолжить" : "Пауза"}
            </button>
          )}
          <button
            className="button secondary"
            onClick={() => onControl("cancel")}
          >
            Отменить ожидающие
          </button>
        </div>
      </div>
      <div className="overall-progress">
        <div
          style={{
            width: `${active.length ? (done / active.length) * 100 : 0}%`,
          }}
        />
      </div>
      <div className="action-counts">
        {[
          ["Успешно", active.filter((t) => success(t.status)).length],
          ["Ошибки", active.filter((t) => t.status === "error").length],
          ["Отменено", active.filter((t) => t.status === "cancelled").length],
          [
            "Нужно участие",
            active.filter((t) =>
              ["action-required", "attention"].includes(t.status),
            ).length,
          ],
          [
            "Заблокировано",
            active.filter((t) => t.status === "blocked").length,
          ],
        ].map(([label, n]) => (
          <span className="badge" key={label}>
            {label}: {n}
          </span>
        ))}
      </div>
      <div className="section-tools wrap">
        <input
          aria-label="Поиск по истории"
          placeholder="Поиск по задачам и журналу"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Статус задач"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">Все результаты</option>
          {Object.entries(statusNames).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        {history && (
          <select
            aria-label="Запуск"
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
          >
            <option value="all">Все запуски</option>
            {queue.runs?.map((r) => (
              <option key={r.id} value={r.id}>
                {date(r.createdAt)} · {r.id.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
        <button className="button secondary" onClick={() => report(false)}>
          Отчёт
        </button>
        <button className="button secondary" onClick={() => report(true)}>
          Диагностика
        </button>
        <button
          className="button secondary"
          disabled={queue.running}
          onClick={() => onControl("clear")}
        >
          Очистить завершённое
        </button>
      </div>
      {queue.runs
        ?.filter((r) => visible.some((t) => t.runId === r.id))
        .slice()
        .reverse()
        .map((run) => {
          const tasks = visible.filter((t) => t.runId === run.id);
          return (
            <section className="run-section" key={run.id}>
              <h3>
                {date(run.createdAt)} ·{" "}
                {run.mode === "demo" ? "Демо" : "Рабочий"} ·{" "}
                {run.id.slice(0, 8)}
              </h3>
              <p className="muted-text">
                {(
                  {
                    running: "Выполняется",
                    completed: "Завершён",
                    errors: "Есть ошибки",
                    cancelled: "Есть отмены",
                    "action-required": "Требуется участие",
                    migrated: "Перенесено из предыдущей версии",
                  } as Record<string, string>
                )[run.outcome] || run.outcome}{" "}
                ·{" "}
                {run.finishedAt
                  ? `Длительность: ${Math.round((run.finishedAt - run.createdAt) / 1000)} с`
                  : "Запуск не завершён"}{" "}
                · пропуск актуальных: {run.skipCurrent ? "да" : "нет"} ·
                загрузок параллельно: {run.parallelDownloads}
              </p>
              <div className="row-actions">
                {(
                  ["error", "cancelled", "action-required", "blocked"] as const
                ).map((status, i) => (
                  <button
                    key={status}
                    className="button secondary"
                    disabled={
                      queue.running || !tasks.some((t) => t.status === status)
                    }
                    onClick={() => onRetry(run.id, status)}
                  >
                    {
                      [
                        "Повторить ошибки",
                        "Вернуть отменённые",
                        "Повторить ручные действия",
                        "Повторить заблокированные",
                      ][i]
                    }
                  </button>
                ))}
              </div>
              {[...new Set(tasks.map((t) => t.appId))].map((appId) => (
                <details className="task-group" open key={appId}>
                  <summary>
                    {getApp(appId).name} ·{" "}
                    {tasks.filter((t) => t.appId === appId).length} задач
                  </summary>
                  {tasks
                    .filter((t) => t.appId === appId)
                    .map((task) => (
                      <details
                        className={`task-row ${task.parentId ? "subtask" : ""}`}
                        key={task.id}
                      >
                        <summary className="task-main">
                          <div className="task-content">
                            <strong>{task.name}</strong>
                            <span>{task.message}</span>
                          </div>
                          <span className={`task-status ${task.status}`}>
                            {statusNames[task.status]}
                          </span>
                        </summary>
                        <div className="task-details">
                          <p>
                            {actionNames[task.action]} · начало{" "}
                            {date(task.startedAt)} · завершение{" "}
                            {date(task.finishedAt)}
                          </p>
                          <p>
                            Длительность:{" "}
                            {task.startedAt
                              ? `${Math.max(0, Math.round(((task.finishedAt || Date.now()) - task.startedAt) / 1000))} с`
                              : "—"}{" "}
                            · активность: {date(task.lastActivityAt)}
                          </p>
                          <p>
                            Версия: {task.actualVersion || "не подтверждена"} ·{" "}
                            {task.evidence === "detected"
                              ? "Обнаружено в системе"
                              : task.evidence === "user"
                                ? "Отметка пользователя"
                                : "Результат исполнителя"}
                          </p>
                          {task.status === "action-required" && (
                            <>
                              <h4>Памятка для установщика</h4>
                              <ol>
                                <li>
                                  Откройте официальный источник{" "}
                                  {getApp(appId).website}.
                                </li>
                                <li>
                                  Проверьте требования, лицензию и выберите
                                  редакцию.
                                </li>
                                <li>
                                  Выполните установку или настройку:{" "}
                                  {Object.entries(task.selection.options)
                                    .map(([k, v]) => `${k}: ${v}`)
                                    .join("; ") ||
                                    "по инструкции производителя"}
                                  .
                                </li>
                                <li>
                                  Проверьте результат обнаружением или отдельно
                                  отметьте выполненный шаг.
                                </li>
                              </ol>
                              <p>{getApp(appId).notes}</p>
                            </>
                          )}
                          <div className="row-actions">
                            <button
                              className="button secondary"
                              onClick={() =>
                                void api
                                  .source(appId)
                                  .catch((e) => notify(String(e)))
                              }
                            >
                              Официальный источник
                            </button>
                            {["error", "cancelled", "blocked"].includes(
                              task.status,
                            ) && (
                              <>
                                <button
                                  className="button secondary"
                                  disabled={queue.running}
                                  onClick={() =>
                                    onRetry(run.id, task.status, task.id)
                                  }
                                >
                                  Проверить повтор
                                </button>
                                <button
                                  className="button secondary"
                                  disabled={queue.running}
                                  onClick={() => onEdit(task)}
                                >
                                  Изменить параметры
                                </button>
                              </>
                            )}
                            {["action-required", "user-completed"].includes(
                              task.status,
                            ) && (
                              <button
                                className="button secondary"
                                onClick={() =>
                                  void api
                                    .verifyManual(task.id, mode)
                                    .then(() =>
                                      notify("Обнаружение подтверждено"),
                                    )
                                    .catch((e) => notify(String(e)))
                                }
                              >
                                Проверить результат
                              </button>
                            )}
                            {task.status === "action-required" && (
                              <button
                                className="button secondary"
                                onClick={() =>
                                  onControl("complete-manual", task.id)
                                }
                              >
                                Шаг выполнен
                              </button>
                            )}
                            {task.status === "queued" && (
                              <button
                                className="button secondary"
                                onClick={() => onControl("cancel", task.id)}
                              >
                                Отменить
                              </button>
                            )}
                          </div>
                          <pre>{task.log.join("\n") || "Журнал пуст"}</pre>
                        </div>
                      </details>
                    ))}
                </details>
              ))}
            </section>
          );
        })}
      {!visible.length && (
        <p className="empty-state">
          Нет задач по выбранным условиям. Выберите программы и проверьте план.
        </p>
      )}
      <p className="inline-note">
        Пауза откладывает следующие задачи. Отмена касается ожидающих задач;
        работающий установщик завершается штатно. Закрытие приложения с
        работающим установщиком откладывается.
      </p>
      {preview !== null && (
        <Modal
          title="Предварительный просмотр отчёта"
          wide
          onClose={() => setPreview(null)}
        >
          <div className="modal-body">
            <label>
              <input
                type="checkbox"
                checked={redact}
                onChange={(e) => {
                  setRedact(e.target.checked);
                  report(structured, e.target.checked);
                }}
              />
              Скрыть личные пути, имена компьютера и чувствительные значения
            </label>
            <p className="muted-text">
              Проверьте и при необходимости отредактируйте текст перед
              передачей. Сохранение выполняется локально.
            </p>
            <textarea
              className="diagnostic-preview"
              aria-label="Текст отчёта"
              value={preview}
              onChange={(e) => setPreview(e.target.value)}
            />
          </div>
          <div className="modal-footer">
            <button
              className="button primary"
              onClick={() =>
                void api
                  .saveReport(preview, structured)
                  .then(notify)
                  .catch((e) => notify(String(e)))
              }
            >
              Сохранить локально
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
