import { formatBytes, formatRemainingTime } from "../display";
import type { QueueTask } from "../types";

export function DownloadStatus({ task }: { task: QueueTask }) {
  const progress = task.downloadProgress;
  if (
    !progress &&
    (task.action !== "download" || task.status !== "downloading")
  )
    return null;
  const complete = task.status === "downloaded";
  const active = task.status === "downloading";
  const percent = complete ? 100 : task.percent;
  const knownPercent = percent != null && Number.isFinite(percent);
  return (
    <div className="download-status">
      <div className="download-status-heading">
        <span>
          {complete
            ? "Загрузка завершена"
            : active
              ? "Скачивание"
              : task.status === "verifying"
                ? "Проверка файла"
                : "Загрузка остановлена"}
        </span>
        <strong>
          {knownPercent
            ? `${percent.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`
            : "Размер неизвестен"}
        </strong>
      </div>
      <progress
        max={100}
        value={knownPercent ? percent : undefined}
        aria-label={`Скачивание ${task.name}`}
      />
      <div className="download-metrics">
        <span>
          Скачано: <b>{formatBytes(progress?.downloadedBytes)}</b>
          {progress?.totalBytes != null &&
            ` из ${formatBytes(progress.totalBytes)}`}
        </span>
        <span>
          Осталось: <b>{formatBytes(progress?.remainingBytes)}</b>
        </span>
        <span>
          Скорость:{" "}
          <b>
            {active && progress
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
    </div>
  );
}
