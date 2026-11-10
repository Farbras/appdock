import { useEffect, useState } from "react";
import { extensions, getApp } from "../catalog";
import { feature } from "../feature-api";
import type { Plan, Settings, TroubleshootingReport } from "../types";
import { Modal } from "./ui";
export function TroubleshootDialog({
  appId,
  instanceKey,
  appName,
  selectedExtensions = [],
  mode,
  running,
  onClose,
  onPlan,
}: {
  appId: string;
  instanceKey?: string;
  appName?: string;
  selectedExtensions?: string[];
  mode: Settings["mode"];
  running: boolean;
  onClose: () => void;
  onPlan: (p: Plan) => void;
}) {
  const [report, setReport] = useState<TroubleshootingReport | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [chosen, setChosen] = useState(selectedExtensions);
  const [revision, setRevision] = useState(0);
  const [backups, setBackups] = useState<
    { id: string; appId: string; added: string }[]
  >([]);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError("");
    // Native features share an exclusive operation guard; these calls must be sequential.
    void (async () => {
      const r = await feature<TroubleshootingReport>(
        "troubleshoot",
        { appId, instanceKey, extensions: chosen },
        mode,
      );
      const b = await feature<typeof backups>("path-backups", {}, mode);
      return [r, b] as const;
    })()
      .then(([r, b]) => {
        if (alive) {
          setReport(r);
          setBackups(b);
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [appId, instanceKey, mode, chosen, revision]);
  const prepare = async (fix: string, backupId?: string) => {
    setBusy(true);
    setError("");
    try {
      onPlan(
        await feature<Plan>(
          backupId ? "path-restore-prepare" : "fix-prepare",
          backupId
            ? { backupId }
            : { appId, instanceKey, extensions: chosen, fix },
          mode,
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Программа не работает" wide onClose={onClose}>
      <div className="modal-body troubleshoot-body">
        <h3>
          {appName || getApp(appId)?.name || "Выбранная программа Windows"}
        </h3>
        <p>
          Сначала диагностика, затем просмотр и подтверждение конкретного плана.
        </p>
        {mode === "demo" && (
          <p className="inline-note">
            Демонстрация: все проверки и исправления виртуальные.
          </p>
        )}
        {appId === "vscode" && (
          <fieldset>
            <legend>Какие расширения должны быть установлены</legend>
            {extensions.map((e) => (
              <label className="check-row" key={e.id}>
                <input
                  type="checkbox"
                  checked={chosen.includes(e.id)}
                  onChange={(ev) =>
                    setChosen(
                      ev.target.checked
                        ? [...new Set([...chosen, ...e.dependencies, e.id])]
                        : chosen.filter((id) => id !== e.id),
                    )
                  }
                />
                {e.name}
              </label>
            ))}
          </fieldset>
        )}
        {error && (
          <p role="alert" className="warning-text">
            {error}
          </p>
        )}
        {busy && <p role="status">Проверяем…</p>}
        <button
          className="button secondary"
          disabled={busy || running}
          onClick={() => setRevision((r) => r + 1)}
        >
          Повторить диагностику
        </button>
        {report && (
          <>
            <h4>Что проверено</h4>
            <ul>
              {report.checked.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <h4>Подтверждённые проблемы</h4>
            {report.problems.length ? (
              <ul>
                {report.problems.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            ) : (
              <p>
                Подтверждённых проблем нет. Это не проверка всех функций
                приложения.
              </p>
            )}
            <h4>Что проверить не удалось</h4>
            <ul>
              {report.unknown.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <h4>Предлагаемые исправления</h4>
            <div className="row-actions">
              <button
                className="button secondary"
                disabled={busy || running}
                onClick={() => void prepare("recheck")}
              >
                План повторной проверки
              </button>
              <button
                className="button secondary"
                disabled={busy || running || !report.repairAvailable}
                onClick={() => void prepare("repair")}
              >
                План восстановления WinGet
              </button>
              {report.pathAvailable && (
                <button
                  className="button secondary"
                  disabled={busy || running}
                  onClick={() => void prepare("path")}
                >
                  План исправления PATH
                </button>
              )}
              {report.missingExtensions.length > 0 && (
                <button
                  className="button secondary"
                  disabled={busy || running}
                  onClick={() => void prepare("extensions")}
                >
                  План восстановления расширений
                </button>
              )}
            </div>
            {report.path && <p>Проверенная папка: {report.path}</p>}
            <h4>Ручные шаги</h4>
            <ol>
              {report.manual.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </>
        )}
        {backups
          .filter((b) => b.appId === appId)
          .map((b) => (
            <div className="inline-note" key={b.id}>
              Копия PATH: {b.id} · добавлено {b.added}
              <button
                className="button secondary"
                disabled={busy || running}
                onClick={() => void prepare("", b.id)}
              >
                Просмотреть отмену добавления PATH
              </button>
            </div>
          ))}
      </div>
      <div className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </Modal>
  );
}
