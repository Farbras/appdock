import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DownloadStatus } from "../src/components/DownloadStatus";
import { formatBytes, formatRemainingTime } from "../src/display";
import { expandTasks } from "../src/queue";
import { defaultSelection, getApp } from "../src/catalog";

describe("download status", () => {
  it("shows large image sizes, speed, percentage and ETA before opening task details", () => {
    const task = expandTasks([defaultSelection(getApp("office-2021"))])[0];
    task.status = "downloading";
    task.percent = 25;
    task.downloadProgress = {
      downloadedBytes: 1073741824,
      totalBytes: 4294967296,
      remainingBytes: 3221225472,
      bytesPerSecond: 10485760,
      remainingSeconds: 308,
    };
    const html = renderToStaticMarkup(createElement(DownloadStatus, { task }));
    for (const label of ["25%", "1 ГБ", "4 ГБ", "3 ГБ", "10 МБ/с", "≈ 6 мин"])
      expect(html).toContain(label);
    expect(html).toContain('value="25"');
    task.downloadProgress.totalBytes = null;
    task.downloadProgress.remainingBytes = null;
    task.downloadProgress.remainingSeconds = null;
    task.percent = null;
    const unknown = renderToStaticMarkup(
      createElement(DownloadStatus, { task }),
    );
    expect(unknown).toContain("Размер неизвестен");
    expect(unknown).toContain("рассчитывается…");
    expect(unknown).not.toContain("value=");
    task.status = "error";
    const stopped = renderToStaticMarkup(
      createElement(DownloadStatus, { task }),
    );
    expect(stopped).toContain("Загрузка остановлена");
    expect(stopped).not.toContain("10 МБ/с");
  });
  it("formats unknown values and durations without invalid or negative metrics", () => {
    expect(formatBytes(null)).toBe("неизвестно");
    expect(formatBytes(NaN)).toBe("неизвестно");
    expect(formatBytes(0)).toBe("0 Б");
    expect(formatRemainingTime(null)).toBe("рассчитывается…");
    expect(formatRemainingTime(0)).toBe("0 с");
    expect(formatRemainingTime(65)).toBe("≈ 2 мин");
    expect(formatRemainingTime(3660)).toBe("≈ 1 ч 1 мин");
  });
});
