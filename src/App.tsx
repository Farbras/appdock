import {
  ArrowRight,
  Bell,
  Check,
  ChevronRight,
  CircleHelp,
  Info,
  Loader2,
  Monitor,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, emptyQueue, native, normalizePresetItems } from "./api";
import type { Filters } from "./catalog";
import {
  apps,
  builtinPresets,
  categories,
  defaultSelection,
  filterApps,
  getApp,
  initialFilters,
  matchInstalled,
} from "./catalog";
import { PlanDialog } from "./components/PlanDialog";
import { ScreenBoundary } from "./components/ScreenBoundary";
import { SelectionPane } from "./components/SelectionPane";
import { appVersion } from "./diagnostics";
import { currentTasks } from "./queue";
import { CatalogScreen } from "./screens/CatalogScreen";
import { RunsScreen } from "./screens/RunsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import {
  DownloadsScreen,
  PresetsScreen,
  ProfileScreen,
  Readiness,
  UpdatesScreen,
  useProfile,
} from "./screens/Workflows";
import { readStorage, safeWriteStorage, storageIssues } from "./storage";
import type {
  InstalledApp,
  Plan,
  Preset,
  Product,
  QueueState,
  QueueTask,
  Selection,
  Settings,
  SystemInfo,
} from "./types";

import { ProductDialog } from "./components/ProductDialog";
import {
  Brand,
  Icon,
  Logo,
  Modal,
  navItems,
  terminalStatuses,
} from "./components/ui";
function App() {
  const [profile, setProfile] = useProfile();
  const [undoSelection, setUndoSelection] = useState<Selection[] | null>(null);
  const [reviewItems, setReviewItems] = useState<Selection[]>([]);
  const [editDraft, setEditDraft] = useState<Selection | undefined>();
  const [retryTarget, setRetryTarget] = useState<QueueTask | null>(null);
  const [retryContext, setRetryContext] = useState<{
    runId: string;
    status: QueueTask["status"];
    taskId?: string;
  } | null>(null);
  const [returnToPlan, setReturnToPlan] = useState(false);
  const [storageError, setStorageError] = useState(storageIssues().join("\n"));
  const [systemError, setSystemError] = useState("");
  const [detectedAt, setDetectedAt] = useState<number | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [sort, setSort] = useState("name");
  const [cartOpen, setCartOpen] = useState(false);
  const [nav, setNav] = useState("catalog");
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [settings, setSettings] = useState<Settings>(() => ({
    ...{
      theme: "dark",
      mode: native ? "live" : "demo",
      view: "grid",
      skipCurrent: true,
      parallelDownloads: 2,
    },
    ...readStorage<Partial<Settings>>("settings", {}),
    ...(!native ? { mode: "demo" as const } : {}),
  }));
  const [selection, setSelection] = useState<Selection[]>(() =>
    readStorage<Selection[]>("selection", []).filter((s) =>
      apps.some((a) => a.id === s.appId),
    ),
  );
  const [favorites, setFavorites] = useState<string[]>(() =>
    readStorage("favorites", []),
  );
  const [presets, setPresets] = useState<Preset[]>(() =>
    readStorage("presets", []),
  );
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [queue, setQueue] = useState<QueueState>(emptyQueue);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [detail, setDetail] = useState<Product | null>(null);
  const [toast, setToast] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [wizardId, setWizardId] = useState("python-dev");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [editingPreset, setEditingPreset] = useState<string | null>(null);

  const [clearConfirm, setClearConfirm] = useState(false);
  const [showNotices, setShowNotices] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const notify = (message: string) => setToast(message);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 5500);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    safeWriteStorage("settings", settings);
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      document.documentElement.dataset.theme =
        settings.theme === "system"
          ? media.matches
            ? "light"
            : "dark"
          : settings.theme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings]);
  useEffect(() => safeWriteStorage("selection", selection), [selection]);
  useEffect(() => safeWriteStorage("favorites", favorites), [favorites]);
  useEffect(() => safeWriteStorage("presets", presets), [presets]);
  useEffect(() => {
    const onError = (e: Event) =>
      setStorageError((e as CustomEvent<string>).detail);
    window.addEventListener("appdock-storage-error", onError);
    return () => window.removeEventListener("appdock-storage-error", onError);
  }, []);
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const accept = (q: QueueState) => {
      if (alive) setQueue(q);
    };
    const refresh = () =>
      api
        .queue(settings.mode)
        .then(accept)
        .catch((e) => alive && notify(String(e)));
    void api.subscribe(settings.mode, accept).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    void refresh();
    const id = setInterval(() => void refresh(), 15000);
    return () => {
      alive = false;
      unlisten?.();
      clearInterval(id);
    };
  }, [settings.mode]);
  const refreshedRun = useRef("");
  useEffect(() => {
    const run = queue.runs?.find((r) => r.id === queue.currentRunId);
    if (
      run?.finishedAt &&
      refreshedRun.current !== run.id &&
      settings.mode === "live"
    ) {
      refreshedRun.current = run.id;
      void scan();
    }
  }, [queue.currentRunId, queue.running, queue.runs, settings.mode]);
  useEffect(() => {
    setInstalled([]);
    setSystem(null);
    void api
      .system(settings.mode)
      .then(setSystem)
      .catch((e) => {
        setSystemError(String(e));
        notify(String(e));
      });
    if (settings.mode === "live" && native) {
      setScanning(true);
      void api
        .scan(settings.mode)
        .then((result) => {
          setInstalled(result);
          setDetectedAt(Date.now());
        })
        .catch((e) => notify(String(e)))
        .finally(() => setScanning(false));
    }
  }, [settings.mode]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setNav("catalog");
        setDetail(null);
        setPlan(null);
        setWizard(false);
        setShowNotices(false);
        setSaveName(null);
        setClearConfirm(false);
        setFocusRequest((v) => v + 1);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!focusRequest) return;
    const id = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [nav, focusRequest]);
  const changeSettings = (patch: Partial<Settings>) =>
    setSettings((s) => ({ ...s, ...patch }));
  const getInstalled = (app: Product) =>
    matchInstalled(app, installed, undefined);
  const toggleApp = (app: Product) =>
    setSelection((s) =>
      s.some((i) => i.appId === app.id)
        ? s.filter((i) => i.appId !== app.id)
        : [...s, defaultSelection(app)],
    );
  const updateSelection = (s: Selection) =>
    setSelection((items) =>
      items.some((i) => i.appId === s.appId)
        ? items.map((i) => (i.appId === s.appId ? s : i))
        : [...items, s],
    );
  const toggleFavorite = (id: string) =>
    setFavorites((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  const scan = async () => {
    setScanning(true);
    try {
      const result = await api.scan(settings.mode);
      setInstalled(result);
      setDetectedAt(Date.now());
      setSystemError("");
      setSystem(await api.system(settings.mode));
      notify(
        settings.mode === "demo"
          ? "Демонстрация: сведения об установленных программах не считываются."
          : `Проверка завершена. Обнаружено пакетов: ${result.length}`,
      );
    } catch (e) {
      setSystemError(String(e));
      notify(String(e));
    } finally {
      setScanning(false);
    }
  };
  const review = async (downloadOnly = false, explicit?: Selection[]) => {
    setRetryContext(null);
    const chosen = explicit || selection;
    if (!chosen.length) return;
    setLoading(true);
    try {
      const items = downloadOnly
        ? chosen.map((s) => ({
            ...s,
            action: "download" as const,
            extensions: [],
          }))
        : chosen;
      setReviewItems(items);
      const p = await api.plan(items, settings);

      setPlan(p);
    } catch (e) {
      notify(String(e));
    } finally {
      setLoading(false);
    }
  };
  const launch = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await api.start(plan.token, settings.mode);
      setPlan(null);
      setNav("queue");
      setSelection((items) =>
        items.filter(
          (s) => !plan.items.some((i) => i.appId === s.appId && !i.excluded),
        ),
      );
      setQueue(await api.queue(settings.mode));
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };
  const control = async (action: string, id?: string) => {
    try {
      await api.control(action, settings.mode, id);
      setQueue(await api.queue(settings.mode));
    } catch (e) {
      notify(String(e));
    }
  };
  const replaceSelection = (items: Selection[]) => {
    setUndoSelection(structuredClone(selection));
    setSelection(items);
    notify("Выбор заменён. Последнюю замену можно отменить в наборах.");
  };
  const loadPreset = (p: Preset) => {
    replaceSelection(normalizePresetItems(p.items));
    setNav("catalog");
    setFilters(initialFilters);
    setWizard(false);
  };
  const retry = async (
    runId: string,
    status: QueueTask["status"],
    taskId?: string,
    edited?: Selection | Selection[],
    includedAppIds?: string[],
  ) => {
    setLoading(true);
    try {
      const p = await api.retryPlan(
        runId,
        status,
        settings.mode,
        taskId,
        edited,
        includedAppIds,
      );
      setRetryContext({ runId, status, taskId });
      setReviewItems(p.items.map((i) => i.selection));
      setPlan(p);
    } catch (e) {
      notify(String(e));
    } finally {
      setLoading(false);
    }
  };
  const editTask = (task: QueueTask) => {
    setRetryTarget(task);
    setEditDraft(
      queue.runs
        ?.find((r) => r.id === task.runId)
        ?.selections.find((s) => s.appId === task.appId) || task.selection,
    );
    setDetail(getApp(task.appId));
  };
  const savePreset = () => {
    const name = saveName?.trim();
    if (!name) return;
    if (editingPreset) {
      setPresets((ps) =>
        ps.map((p) => (p.id === editingPreset ? { ...p, name } : p)),
      );
      setEditingPreset(null);
    } else {
      setPresets((ps) => [
        ...ps,
        {
          id: crypto.randomUUID(),
          name,
          description: "Мой набор программ",
          icon: "Package",
          items: structuredClone(selection),
          builtin: false,
        },
      ]);
    }
    setSaveName(null);
    notify("Набор сохранён");
  };
  const base =
    nav === "favorites"
      ? apps.filter((a) => favorites.includes(a.id))
      : nav === "installed"
        ? apps.filter((a) => getInstalled(a))
        : apps;
  const visible = filterApps(base, filters, installed).sort((a, b) =>
    sort === "publisher"
      ? a.publisher.localeCompare(b.publisher)
      : sort === "automation"
        ? a.install.method.localeCompare(b.install.method)
        : a.name.localeCompare(b.name, "ru"),
  );
  const activeTasks = currentTasks(queue).filter(
    (t) => !terminalStatuses.includes(t.status),
  );
  const pageTitles: Record<string, string> = {
    catalog: "Подготовьте компьютер к работе",
    installed: "Установленные программы",
    favorites: "Ваши любимые программы",
    queue: "Загрузки и установка",
    presets: "Нужные программы — в одном наборе",
    history: "История действий",
    settings: "Настройки",
    updates: "Центр обновлений",
    profile: "Профиль компьютера",
    downloads: "Полученные файлы",
  };
  const pageDescriptions: Record<string, string> = {
    catalog:
      "Выберите программы, проверьте план и выполните автоматические и ручные шаги.",
    installed: "Программы, обнаруженные на этом компьютере.",
    favorites: "Всё, что хочется держать под рукой.",
    queue: "Каждый шаг под контролем. Результаты — без догадок.",
    presets: "Сохраните свой выбор или начните с готового решения.",
    history: "Результаты установок, загрузок и веб-действий.",
    settings: "Пусть AppDock работает так, как удобно вам.",
    updates: "Выберите поддерживаемые обновления и проверьте план.",
    profile: "Сравните желаемый состав с этим компьютером.",
    downloads: "Файлы, происхождение и ограничения загрузок.",
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-caption">ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav aria-label="Основная навигация">
          {navItems.map(([id, label, Component]) => (
            <button
              key={id}
              aria-label={label}
              className={`nav-item ${nav === id ? "active" : ""}`}
              onClick={() => {
                setNav(id);
                setFilters(initialFilters);
              }}
            >
              <Component size={18} />
              <span>{label}</span>
              {id === "queue" && activeTasks.length > 0 ? (
                <span className="nav-count">{activeTasks.length}</span>
              ) : id === "favorites" && favorites.length > 0 ? (
                <span className="nav-count quiet">{favorites.length}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-categories">
          <div className="sidebar-caption">КАТЕГОРИИ</div>
          {categories
            .filter((c) => c.id !== "all")
            .map((c) => (
              <button
                key={c.id}
                className={`category-nav ${filters.category === c.id && nav === "catalog" ? "active" : ""}`}
                onClick={() => {
                  setNav("catalog");
                  setFilters({ ...initialFilters, category: c.id });
                }}
              >
                <Icon name={c.icon} size={16} />
                <span>{c.name}</span>
                <span className="category-count">
                  {apps.filter((a) => a.category === c.id).length}
                </span>
              </button>
            ))}
        </div>
        <div className="sidebar-bottom">
          <div className="device-icon">
            <Monitor size={19} />
          </div>
          <div>
            <strong>Этот компьютер</strong>
            <span>
              {system?.os || "Windows 11"} · {system?.arch || "x64"}
            </span>
          </div>
          <span
            className={`status-dot ${settings.mode === "demo" ? "demo" : ""}`}
          />
        </div>
        <div className="sidebar-version">
          <span>AppDock {appVersion}</span>
          <button
            onClick={() => {
              setNav("settings");
            }}
            aria-label="О приложении"
          >
            <CircleHelp size={15} />
          </button>
        </div>
      </aside>
      <main className="main-pane">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Рабочее пространство</span>
            <ChevronRight size={13} />
            <strong>{navItems.find((n) => n[0] === nav)?.[1]}</strong>
          </div>
          <div className="topbar-actions">
            <span className={`mode-pill ${settings.mode}`}>
              <span />
              {settings.mode === "demo"
                ? "Демонстрационный режим"
                : "Рабочий режим"}
            </span>
            <button
              className="icon-button"
              aria-label="Уведомления"
              onClick={() => setShowNotices(true)}
            >
              <Bell size={18} />
              {queue.tasks.some((t) => t.status === "error") && (
                <i className="notification-dot" />
              )}
            </button>
          </div>
        </header>
        <div className="main-scroll" key={nav}>
          <ScreenBoundary screen={nav}>
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  {nav === "catalog"
                    ? "МЕНЬШЕ РУТИНЫ. БОЛЬШЕ ВОЗМОЖНОСТЕЙ."
                    : "APPDOCK / " +
                      (
                        navItems.find((n) => n[0] === nav)?.[1] || ""
                      ).toUpperCase()}
                </div>
                <h1>{pageTitles[nav]}</h1>
                <p>{pageDescriptions[nav]}</p>
              </div>
              {nav === "installed" && (
                <button
                  className="button secondary"
                  onClick={scan}
                  disabled={scanning}
                >
                  {scanning ? (
                    <Loader2 size={16} className="spin" />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                  Проверить
                </button>
              )}
            </div>
            {(storageError || queue.storageError) && (
              <div role="alert" className="inline-note warning-text">
                {storageError || queue.storageError}
              </div>
            )}
            {nav === "catalog" && (
              <Readiness
                system={system}
                scanning={scanning}
                detectedAt={detectedAt}
                installed={installed}
                queue={queue}
                onScan={() => void scan()}
                onPrepare={() => setWizard(true)}
                error={systemError}
              />
            )}
            {nav === "updates" && (
              <UpdatesScreen
                installed={installed}
                profile={profile.items}
                mode={settings.mode}
                onReview={(items) => void review(false, items)}
                onScan={() => void scan()}
                scanning={scanning}
                detectedAt={detectedAt}
                notify={notify}
              />
            )}
            {nav === "profile" && (
              <ProfileScreen
                profile={profile}
                setProfile={setProfile}
                installed={installed}
                selection={selection}
                mode={settings.mode}
                onReview={(items) => void review(false, items)}
                notify={notify}
              />
            )}
            {nav === "downloads" && (
              <DownloadsScreen notify={notify} running={queue.running} />
            )}
            {["catalog", "favorites", "installed"].includes(nav) && (
              <CatalogScreen
                installed={installed}
                nav={nav}
                filters={filters}
                setFilters={setFilters}
                settings={settings}
                changeSettings={changeSettings}
                visible={visible}
                base={base}
                getInstalled={getInstalled}
                selection={selection}
                toggleApp={toggleApp}
                setDetail={setDetail}
                toggleFavorite={toggleFavorite}
                favorites={favorites}
                showFilters={showFilters}
                setShowFilters={setShowFilters}
                searchRef={searchRef}
                scanning={scanning}
                scan={scan}
                setNav={setNav}
                setWizard={setWizard}
                sort={sort}
                setSort={setSort}
              />
            )}{" "}
            {nav === "presets" && (
              <PresetsScreen
                presets={presets}
                setPresets={setPresets}
                selection={selection}
                onReplace={replaceSelection}
                onAdd={(items) =>
                  setSelection((previous) => [
                    ...previous,
                    ...items.filter(
                      (s) => !previous.some((p) => p.appId === s.appId),
                    ),
                  ])
                }
                canUndo={undoSelection !== null}
                onUndo={() => {
                  if (undoSelection) setSelection(undoSelection);
                  setUndoSelection(null);
                }}
                mode={settings.mode}
                notify={notify}
              />
            )}
            {(nav === "queue" || nav === "history") && (
              <RunsScreen
                queue={queue}
                history={nav === "history"}
                mode={settings.mode}
                onControl={(action, id) =>
                  action === "clear"
                    ? setClearConfirm(true)
                    : void control(action, id)
                }
                onRetry={(runId, status, id) => void retry(runId, status, id)}
                onEdit={editTask}
                notify={notify}
              />
            )}
            {nav === "settings" && (
              <SettingsScreen
                settings={settings}
                changeSettings={changeSettings}
                notify={notify}
                queue={queue}
                system={system}
                setSystem={setSystem}
              />
            )}
          </ScreenBoundary>
        </div>
      </main>

      <SelectionPane
        selection={selection}
        settings={settings}
        queue={queue}
        loading={loading}
        cartOpen={cartOpen}
        setCartOpen={setCartOpen}
        setSelection={setSelection}
        setWizard={setWizard}
        setDetail={setDetail}
        getInstalled={getInstalled}
        toggleApp={toggleApp}
        setEditingPreset={setEditingPreset}
        setSaveName={setSaveName}
        review={review}
      />
      {detail && (
        <ProductDialog
          app={detail}
          selection={editDraft || selection.find((s) => s.appId === detail.id)}
          installed={getInstalled(detail)}
          installedRecords={installed}
          mode={settings.mode}
          onClose={() => {
            setDetail(null);
            setEditDraft(undefined);
            setRetryTarget(null);
            setReturnToPlan(false);
          }}
          onApply={(s) => {
            if (retryTarget)
              void retry(
                retryTarget.runId!,
                retryTarget.status,
                retryTarget.id,
                s,
              );
            else if (returnToPlan && retryContext)
              void retry(
                retryContext.runId,
                retryContext.status,
                retryContext.taskId,
                reviewItems.map((i) => (i.appId === s.appId ? s : i)),
                reviewItems.map((i) => i.appId),
              );
            else if (returnToPlan)
              void review(
                false,
                reviewItems.map((i) => (i.appId === s.appId ? s : i)),
              );
            updateSelection(s);
            setDetail(null);
            setEditDraft(undefined);
            setRetryTarget(null);
            setReturnToPlan(false);
          }}
          onFavorite={() => toggleFavorite(detail.id)}
          favorite={favorites.includes(detail.id)}
          notify={notify}
        />
      )}
      {plan && (
        <PlanDialog
          key={plan.token}
          plan={plan}
          settings={settings}
          busy={busy}
          onClose={() => !busy && setPlan(null)}
          onStart={() => void launch()}
          onEdit={(s) => {
            setEditDraft(s);
            setReturnToPlan(true);
            setDetail(getApp(s.appId));
            setPlan(null);
          }}
          onRemove={(id) => {
            const remaining = reviewItems.filter((s) => s.appId !== id);
            setPlan(null);
            if (remaining.length) {
              if (retryContext)
                void retry(
                  retryContext.runId,
                  retryContext.status,
                  retryContext.taskId,
                  remaining,
                  remaining.map((s) => s.appId),
                );
              else void review(false, remaining);
            }
          }}
          onRefresh={() => {
            if (retryContext)
              void retry(
                retryContext.runId,
                retryContext.status,
                retryContext.taskId,
                reviewItems,
                reviewItems.map((s) => s.appId),
              );
            else void review(false, reviewItems);
          }}
        />
      )}
      {wizard && (
        <Modal
          title="Для чего нужен компьютер?"
          wide
          onClose={() => setWizard(false)}
        >
          <div className="modal-body">
            <p className="modal-description">
              Подберём основу, а окончательный выбор останется за вами.
            </p>
            <div className="wizard-options">
              {builtinPresets.map((p) => (
                <button
                  key={p.id}
                  className={wizardId === p.id ? "active" : ""}
                  onClick={() => setWizardId(p.id)}
                >
                  <Icon name={p.icon} size={22} />
                  <span>{p.name}</span>
                  {wizardId === p.id && <Check size={17} />}
                </button>
              ))}
            </div>
            <div className="wizard-recommendation">
              <Sparkles size={20} />
              <div>
                <strong>Почему этот набор</strong>
                <p>
                  {builtinPresets.find((p) => p.id === wizardId)?.description}
                </p>
                <div className="recommended-names">
                  {builtinPresets
                    .find((p) => p.id === wizardId)
                    ?.items.map((s) => (
                      <span key={s.appId}>
                        <Logo app={getApp(s.appId)} small />
                        {getApp(s.appId).name}
                      </span>
                    ))}
                </div>
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <span>Выбор заменит текущий список</span>
            <button
              className="button primary"
              onClick={() =>
                loadPreset(builtinPresets.find((p) => p.id === wizardId)!)
              }
            >
              Выбрать этот набор
              <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
      {saveName !== null && (
        <Modal
          title={editingPreset ? "Переименовать набор" : "Сохранить ваш набор"}
          onClose={() => setSaveName(null)}
        >
          <div className="modal-body">
            <label className="form-label">
              Название набора
              <input
                autoFocus
                maxLength={80}
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") savePreset();
                }}
              />
            </label>
            <p className="muted-text">
              {editingPreset
                ? "Состав набора сохранится."
                : `${selection.length} программ. Версии и параметры сохранятся без секретов.`}
            </p>
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => setSaveName(null)}
            >
              Отмена
            </button>
            <button
              className="button primary"
              disabled={!saveName.trim()}
              onClick={savePreset}
            >
              Сохранить
            </button>
          </div>
        </Modal>
      )}
      {showNotices && (
        <Modal title="Уведомления" onClose={() => setShowNotices(false)}>
          <div className="modal-body">
            <div className="inline-note">
              <Bell size={18} />
              <span>
                {queue.tasks.some((t) => t.status === "error")
                  ? "В очереди есть ошибки. Откройте подробности задачи, чтобы повторить её или узнать причину."
                  : queue.paused
                    ? "Сохранённая очередь ожидает продолжения. Состояние программ будет проверено заново."
                    : "Новых уведомлений нет. Все результаты доступны в истории."}
              </span>
            </div>
            <button
              className="button secondary"
              onClick={() => {
                setShowNotices(false);
                setNav("queue");
              }}
            >
              Открыть очередь
              <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
      {clearConfirm && (
        <Modal title="Очистить историю?" onClose={() => setClearConfirm(false)}>
          <div className="modal-body">
            <p>
              Будут удалены результаты и журналы завершённых задач.
              Установленные программы останутся на компьютере.
            </p>
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => setClearConfirm(false)}
            >
              Отмена
            </button>
            <button
              className="button primary"
              onClick={() => {
                void control("clear");
                setClearConfirm(false);
              }}
            >
              Очистить
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Info size={18} />
          <span>{toast}</span>
          <button aria-label="Закрыть уведомление" onClick={() => setToast("")}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
