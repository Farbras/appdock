import { formatBytes, formatRemainingTime } from "../display";
import type { QueueTask } from "../types";

export function DownloadStatus({
  task,
  onControl,
}: {
  task: QueueTask;
  onControl?: (action: string, id: string) => void;
}) {
  const progress = task.downloadProgress;
  if (!progress && !["downloading", "downloaded"].includes(task.status))
    return null;
  const complete =
    task.status === "downloaded" ||
    (progress?.remainingBytes === 0 && task.status !== "downloading");
  const paused = !!task.downloadPaused;
  const cancelling = !!task.cancelRequested;
  const active = task.status === "downloading" && !paused && !cancelling;
  const controllable =
    task.status === "downloading" && progress?.remainingBytes !== 0;
  const percent = complete
    ? 100
    : progress?.totalBytes != null && progress.totalBytes > 0
      ? (progress.downloadedBytes / progress.totalBytes) * 100
      : task.percent;
  const knownPercent = percent != null && Number.isFinite(percent);
  const boundedPercent = knownPercent
    ? Math.min(100, Math.max(0, percent))
    : undefined;
  return (
    <div className="download-status">
      <div className="download-status-heading">
        <span>
          {cancelling
            ? "Отмена скачивания…"
            : paused
              ? "Скачивание приостановлено"
              : complete
                ? "Загрузка завершена"
                : active
                  ? "Скачивание"
                  : task.status === "verifying"
                    ? "Проверка файла"
                    : "Загрузка остановлена"}
        </span>
        <strong>
          {knownPercent
            ? `${boundedPercent!.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`
            : "Размер неизвестен"}
        </strong>
      </div>
      <progress
        max={100}
        value={boundedPercent}
        aria-label={`Скачивание ${task.name}`}
      />
      <div className="download-metrics">
        <span>
          Скачано: <b>{formatBytes(progress?.downloadedBytes)}</b>
          {progress?.totalBytes != null &&
            ` из ${formatBytes(progress.totalBytes)}`}
        </span>
        <span>
          Осталось:{" "}
          <b>{formatBytes(complete ? 0 : progress?.remainingBytes)}</b>
        </span>
        <span>
          Скорость:{" "}
          <b>
            {paused
              ? "0 Б/с"
              : active && progress
                ? `${formatBytes(progress.bytesPerSecond)}/с`
                : "—"}
          </b>
        </span>
        <span>
          До завершения:{" "}
          <b>
            {complete
              ? "0 с"
              : active
                ? formatRemainingTime(progress?.remainingSeconds)
                : "—"}
          </b>
        </span>
      </div>
      {onControl && controllable && (
        <div className="row-actions download-actions">
          <button
            className="button secondary"
            disabled={cancelling}
            aria-label={`${paused ? "Продолжить" : "Пауза"}: ${task.name}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onControl(paused ? "resume" : "pause", task.id);
            }}
          >
            {paused ? "Продолжить" : "Пауза"}
          </button>
          <button
            className="button secondary"
            disabled={cancelling}
            aria-label={`Отменить: ${task.name}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onControl("cancel", task.id);
            }}
          >
            {cancelling ? "Отмена…" : "Отменить"}
          </button>
        </div>
      )}
    </div>
  );
}
