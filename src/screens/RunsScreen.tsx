import { TaskReadiness, TaskError } from "../components/TaskResult";
import { inResultGroup, resultGroups } from "../task-results";
import { feature } from "../feature-api";
import { useMemo, useState } from "react";
import { optionLabel, optionValue, taskCount, outcomeNames } from "../display";
import { api } from "../api";
import { actionNames, getApp, statusNames } from "../catalog";
import { Modal } from "../components/ui";
import { DownloadStatus } from "../components/DownloadStatus";
import { buildDiagnostics, readableReport } from "../diagnostics";
import { currentTasks, success, terminal } from "../queue";
import type {
  Plan,
  QueueState,
  QueueTask,
  Settings,
  TaskStatus,
} from "../types";
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
  onTroubleshoot,
  onPlan,
}: {
  queue: QueueState;
  history: boolean;
  mode: Settings["mode"];
  onControl: (action: string, id?: string) => void;
  onRetry: (runId: string, status: TaskStatus, taskId?: string) => void;
  onEdit: (task: QueueTask) => void;
  notify: (message: string) => void;
  onTroubleshoot: (t: QueueTask) => void;
  onPlan: (p: Plan) => void;
}) {
  const [restartTask, setRestartTask] = useState<QueueTask | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [runId, setRunId] = useState("all");
  const [preview, setPreview] = useState<string | null>(null);
  const [structured, setStructured] = useState(true);
  const [redact, setRedact] = useState(true);
  const [page, setPage] = useState(0);
  const filtered = useMemo(
    () =>
      (history ? queue.tasks : currentTasks(queue)).filter(
        (t) =>
          (runId === "all" || t.runId === runId) &&
          (filter === "all" ||
            t.status === filter ||
            (filter.startsWith("summary:") &&
              inResultGroup(t, filter.slice(8)))) &&
          `${t.name} ${t.message} ${t.log.join(" ")}`
            .toLocaleLowerCase("ru")
            .includes(query.toLocaleLowerCase("ru")),
      ),
    [queue, history, runId, filter, query],
  );
  const pageSize = 50;
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / pageSize) - 1),
  );
  const visible = history
    ? filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
    : filtered;
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
            · завершена обработка {done} из {active.length} шагов
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
            Отменить
          </button>
        </div>
      </div>
      {queue.running &&
        !queue.paused &&
        active.some(
          (t) =>
            !terminal(t.status) && t.status !== "queued" && !t.downloadPaused,
        ) && (
          <div
            className="stage-progress"
            role="progressbar"
            aria-label="Выполнение текущего этапа"
          />
        )}
      {active
        .filter((t) => !terminal(t.status) && t.status !== "queued")
        .map((t) => (
          <p className="inline-note" key={t.id}>
            {t.name}:{" "}
            {t.cancelRequested
              ? "Отмена…"
              : t.downloadPaused
                ? "На паузе"
                : statusNames[t.status]}{" "}
            · последнее сообщение {date(t.lastActivityAt)}
            {t.percent == null
              ? " · процент этапа неизвестен"
              : ` · ${t.percent}%`}
          </p>
        ))}
      <div className="overall-progress">
        <div
          style={{
            width: `${active.length ? (done / active.length) * 100 : 0}%`,
          }}
        />
      </div>
      {queue.paused &&
        !queue.running &&
        active.some((t) => t.status === "queued") && (
          <p className="inline-note">
            Восстановлены незавершённые задачи. Нажмите «Продолжить», чтобы
            проверить состояние и возобновить очередь. Прямые загрузки
            используют сохранённые части только после подтверждения Range и
            идентичности файла сервером. WinGet начинает свою операцию заново.
          </p>
        )}
      <div className="action-counts" aria-label="Итог запуска">
        {resultGroups.map((group, i) => (
          <button
            className="button secondary"
            key={group}
            onClick={() => {
              setFilter("summary:" + group);
              setPage(0);
            }}
          >
            {
              [
                "Установлено",
                "Обновлено",
                "Пропущено",
                "Ошибки",
                "Требует действий",
              ][i]
            }
            : {active.filter((t) => inResultGroup(t, group)).length}
          </button>
        ))}
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
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        <select
          aria-label="Статус задач"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(0);
          }}
        >
          <option value="all">Все результаты</option>
          {resultGroups.map((g, i) => (
            <option key={g} value={"summary:" + g}>
              {
                [
                  "Установлено",
                  "Обновлено",
                  "Пропущено",
                  "Ошибки",
                  "Требует действий",
                ][i]
              }
            </option>
          ))}
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
            onChange={(e) => {
              setRunId(e.target.value);
              setPage(0);
            }}
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
      {history && filtered.length > pageSize && (
        <div className="history-pages">
          <button
            className="button secondary"
            disabled={!currentPage}
            onClick={() => setPage(currentPage - 1)}
          >
            Предыдущая страница
          </button>
          <span>
            Задачи {currentPage * pageSize + 1}–
            {Math.min((currentPage + 1) * pageSize, filtered.length)} из{" "}
            {filtered.length}. Полная история включена в отчёт.
          </span>
          <button
            className="button secondary"
            disabled={(currentPage + 1) * pageSize >= filtered.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Следующая страница
          </button>
        </div>
      )}
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
                {outcomeNames[run.outcome] || "Итог не определён"} ·{" "}
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
                      queue.running ||
                      !tasks.some((t) => t.status === status && !t.operation)
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
                    {getApp(appId)?.name ||
                      tasks.find((t) => t.appId === appId)?.name}{" "}
                    · {taskCount(tasks.filter((t) => t.appId === appId).length)}
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
                            {task.readiness && (
                              <span>
                                {
                                  {
                                    ready: "Готово к работе",
                                    action: "Установлено, требуется действие",
                                    unknown: "Не удалось проверить",
                                  }[task.readiness.state]
                                }{" "}
                                · {task.readiness.reason}
                              </span>
                            )}
                            <DownloadStatus task={task} onControl={onControl} />
                          </div>
                          <span className={`task-status ${task.status}`}>
                            {task.cancelRequested
                              ? "Отмена…"
                              : task.downloadPaused
                                ? "На паузе"
                                : statusNames[task.status]}
                          </span>
                        </summary>
                        <div className="task-details">
                          {["error", "blocked", "cancelled"].includes(
                            task.status,
                          ) && <TaskError task={task} />}
                          <TaskReadiness
                            task={task}
                            mode={mode}
                            running={queue.running}
                            notify={notify}
                          />
                          {task.action !== "uninstall" &&
                            [
                              "error",
                              "blocked",
                              "action-required",
                              "installed",
                              "current",
                              "reboot-required",
                              "repaired",
                              "checked",
                            ].includes(task.status) && (
                              <button
                                className="button secondary"
                                disabled={queue.running}
                                onClick={() => onTroubleshoot(task)}
                              >
                                Программа не работает
                              </button>
                            )}
                          {task.operation && (
                            <p>
                              Результат команды:{" "}
                              {(
                                {
                                  "uninstaller-completed":
                                    "деинсталлятор завершился успешно",
                                  "uninstaller-failed":
                                    "деинсталлятор сообщил ошибку",
                                  "process-completed":
                                    "процесс завершился; установка не подтверждена",
                                  "repair-completed":
                                    "команда восстановления завершилась",
                                  "repair-failed":
                                    "команда восстановления сообщила ошибку",
                                  "process-failed":
                                    "процесс сообщил ошибку или отмену",
                                  "check-completed":
                                    "проверка / действие завершены",
                                  "fix-failed":
                                    "исправление завершилось ошибкой",
                                } as Record<string, string>
                              )[task.installationOutcome || ""] ||
                                task.installationOutcome ||
                                "ещё неизвестен"}
                              .{" "}
                              {task.evidence === "absent"
                                ? "Отсутствие экземпляра подтверждено обнаружением."
                                : task.action === "uninstall"
                                  ? "Отсутствие программы не подтверждено."
                                  : ""}
                            </p>
                          )}
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
                          {!task.operation &&
                            task.status === "action-required" && (
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
                                      .map(
                                        ([k, v]) =>
                                          `${optionLabel(getApp(appId), k)}: ${optionValue(getApp(appId), k, v)}`,
                                      )
                                      .join("; ") ||
                                      "по инструкции производителя"}
                                    .
                                  </li>
                                  <li>
                                    Проверьте результат обнаружением или
                                    отдельно отметьте выполненный шаг.
                                  </li>
                                </ol>
                                <p>{getApp(appId).notes}</p>
                              </>
                            )}
                          <div className="row-actions">
                            {getApp(appId) && (
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
                            )}
                            {task.operation &&
                              [
                                "error",
                                "cancelled",
                                "blocked",
                                "action-required",
                              ].includes(task.status) && (
                                <button
                                  className="button secondary"
                                  disabled={queue.running}
                                  onClick={() => {
                                    const op =
                                      task.action === "uninstall"
                                        ? "uninstall-prepare"
                                        : task.action === "custom-install"
                                          ? "custom-prepare"
                                          : "fix-prepare";
                                    const args =
                                      task.action === "uninstall"
                                        ? {
                                            keys: [
                                              task.operation!.instance?.key,
                                            ],
                                          }
                                        : task.action === "custom-install"
                                          ? { ids: [task.appId] }
                                          : {
                                              appId: task.appId,
                                              extensions:
                                                task.selection.extensions,
                                              fix: "recheck",
                                            };
                                    void feature<Plan>(op, args, mode)
                                      .then(onPlan)
                                      .catch((e) => notify(String(e)));
                                  }}
                                >
                                  Просмотреть новый план
                                </button>
                              )}
                            {!task.operation &&
                              ["error", "cancelled", "blocked"].includes(
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
                            {!task.operation &&
                              ["action-required", "user-completed"].includes(
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
                            {!task.operation &&
                              task.status === "action-required" && (
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
                          {task.action === "download" &&
                            ["error", "cancelled", "queued"].includes(
                              task.status,
                            ) && (
                              <button
                                className="button secondary"
                                disabled={queue.running}
                                onClick={() => setRestartTask(task)}
                              >
                                Скачать заново
                              </button>
                            )}
                          <details>
                            <summary>Технические подробности</summary>
                            <pre>{task.log.join("\n") || "Журнал пуст"}</pre>
                          </details>
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
        Пауза останавливает текущие скачивания и откладывает следующие задачи.
        Кнопки у программы управляют только её скачиванием. Отмена останавливает
        загрузки и отменяет ожидающие задачи; работающий установщик завершается
        штатно. Закрытие приложения с работающим установщиком откладывается.
      </p>
      {restartTask && (
        <Modal
          title="Начать загрузку заново"
          onClose={() => setRestartTask(null)}
        >
          <div className="modal-body">
            <p>
              Удалить сохранённые незавершённые части «{restartTask.name}»?
              Готовые файлы сохранятся. Затем используйте существующий повтор с
              просмотром плана.
            </p>
          </div>
          <div className="modal-footer">
            <button
              className="button primary"
              onClick={() =>
                void feature<{ message: string }>(
                  "restart-download",
                  { taskId: restartTask.id },
                  mode,
                )
                  .then((r) => {
                    notify(r.message);
                    setRestartTask(null);
                  })
                  .catch((e) => notify(String(e)))
              }
            >
              Удалить незавершённые части
            </button>
          </div>
        </Modal>
      )}
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
