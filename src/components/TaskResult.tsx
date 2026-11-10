import { useState } from "react";
import { feature } from "../feature-api";
import { explainError } from "../task-results";
import { statusNames } from "../catalog";
import type { QueueTask, ReadinessResult, Settings } from "../types";
export function TaskReadiness({
  task,
  mode,
  running,
  notify,
}: {
  task: QueueTask;
  mode: Settings["mode"];
  running: boolean;
  notify: (s: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<ReadinessResult | null>(null);
  const result = checked || task.readiness;
  if (
    !["install", "extension"].includes(task.action) ||
    ![
      "installed",
      "current",
      "action-required",
      "reboot-required",
      "user-completed",
    ].includes(task.status)
  )
    return null;
  const work = async (op: "readiness" | "launch") => {
    setBusy(true);
    try {
      const r = await feature<ReadinessResult>(op, { taskId: task.id }, mode);
      if (op === "readiness") setChecked(r);
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="readiness-result">
      <h4>
        {result
          ? {
              ready: "Готово к работе",
              action: "Установлено, требуется действие",
              unknown: "Не удалось проверить",
            }[result.state]
          : "Готовность ещё не проверялась"}
      </h4>
      <p>
        {result?.reason ||
          "Старая задача не содержит результата проверки готовности. Запустите проверку без переустановки."}
      </p>
      {result && (
        <>
          <p>{result.nextStep}</p>
          <p className="muted-text">
            Версия: {result.version || "не подтверждена"} ·{" "}
            {new Date(result.checkedAt).toLocaleString("ru-RU")}
          </p>
        </>
      )}
      <div className="row-actions">
        <button
          className="button secondary"
          disabled={busy || running}
          onClick={() => void work("readiness")}
        >
          {busy ? "Проверяем…" : "Проверить готовность"}
        </button>
        {result?.state === "ready" && result.canLaunch && (
          <button
            className="button primary"
            disabled={busy || running}
            onClick={() => void work("launch")}
          >
            Открыть программу
          </button>
        )}
      </div>
    </section>
  );
}
export function TaskError({ task }: { task: QueueTask }) {
  const error = explainError(task);
  return (
    <div className="inline-note warning-text">
      <strong>{error.title}</strong>
      <p>Этап: {statusNames[error.stage] || error.stage}.</p>
      <p>{error.action}</p>
    </div>
  );
}
