import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { feature } from "./feature-api";
import {
  PortabilityScreen,
  SettingsTransfer,
} from "./screens/PortabilityScreen";
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
import { useEffect, useMemo, useRef, useState } from "react";
import { LatestRequest } from "./requests";
import { programs } from "./display";
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
  const [updateSelectionRequest, setUpdateSelectionRequest] = useState(0);
  const [rulesRevision, setRulesRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRulesRevision((n) => n + 1);
    window.addEventListener("appdock-update-rules", changed);
    return () => window.removeEventListener("appdock-update-rules", changed);
  }, []);
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
  const [scanWarning, setScanWarning] = useState("");
  const [updatesChecked, setUpdatesChecked] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [sort, setSort] = useState("name");
  const [cartOpen, setCartOpen] = useState(
    () =>
      matchMedia("(min-width:1251px)").matches &&
      readStorage<Selection[]>("selection", []).length > 0,
  );
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
  const [offlineReviewRoot, setOfflineReviewRoot] = useState<string | null>(
    null,
  );
  const [saveName, setSaveName] = useState<string | null>(null);
  const [editingPreset, setEditingPreset] = useState<string | null>(null);

  const [clearConfirm, setClearConfirm] = useState(false);
  const [showNotices, setShowNotices] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const discoveryRequest = useRef(new LatestRequest());
  const systemRequest = useRef(new LatestRequest());
  const planRequest = useRef(new LatestRequest());
  const modeRef = useRef(settings.mode);
  modeRef.current = settings.mode;
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
  useEffect(() => {
    if (!native) return;
    void invoke("set_runtime_mode", { mode: settings.mode }).catch((e) =>
      notify(String(e)),
    );
    if (settings.mode !== "live") return;
    let alive = true;
    const stops: (() => void)[] = [];
    const navigate = (route: string) => {
      if (!alive) return;
      setNav(route);
      if (route === "updates") setUpdateSelectionRequest((n) => n + 1);
    };
    void listen<string>("appdock-navigate", (e) => navigate(e.payload)).then(
      (fn) => {
        if (alive) stops.push(fn);
        else fn();
      },
    );
    void listen<string>("appdock-background-warning", (e) =>
      notify(e.payload),
    ).then((fn) => {
      if (alive) stops.push(fn);
      else fn();
    });
    const accept = (status: {
      scan?: import("./types").ScanResult;
      error?: string;
      checkedAt?: number;
    }) => {
      if (!alive) return;
      if (status.scan) {
        setInstalled(status.scan.installed);
        setUpdatesChecked(status.scan.updatesChecked);
        setScanWarning(status.scan.warnings.join(" "));
        setDetectedAt(status.checkedAt || Date.now());
      }
      if (status.error) setScanWarning(status.error);
    };
    void listen<Parameters<typeof accept>[0]>("appdock-updates", (e) =>
      accept(e.payload),
    ).then((fn) => {
      if (alive) stops.push(fn);
      else fn();
    });
    void feature<{ route?: string; status: Parameters<typeof accept>[0] }>(
      "background-state",
    )
      .then((r) => {
        accept(r.status);
        if (r.route) navigate(r.route);
      })
      .catch((e) => notify(String(e)));
    return () => {
      alive = false;
      stops.forEach((fn) => fn());
    };
  }, [settings.mode]);
  useEffect(() => {
    if (!native || settings.mode !== "live") return;
    void feature("sync-update-rules", {
      pins: profile.items,
      exclusions: readStorage("update-exclusions", []),
      demo: false,
    }).catch((e) => {
      if (!String(e).includes("Другая операция")) notify(String(e));
    });
  }, [
    settings.mode,
    profile.items,
    nav,
    rulesRevision,
    detectedAt,
    queue.running,
  ]);
  const refreshedRun = useRef("");
  useEffect(() => {
    const run = queue.runs?.find((r) => r.id === queue.currentRunId);
    if (
      run?.finishedAt &&
      !queue.running &&
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
    setDetectedAt(null);
    setSystemError("");
    setScanWarning("");
    setUpdatesChecked(false);
    setScanning(false);
    setPlan(null);
    setLoading(false);
    planRequest.current.invalidate();
    void refreshSystem();
    if (settings.mode === "live" && native) {
      void scan();
    }
    return () => {
      discoveryRequest.current.invalidate();
      systemRequest.current.invalidate();
    };
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
        setCartOpen(false);
        setFocusRequest((v) => v + 1);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!focusRequest) return;
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [nav, focusRequest]);
  const changeSettings = (patch: Partial<Settings>) => {
    if (patch.mode && native) {
      void invoke("set_runtime_mode", { mode: patch.mode })
        .then(() => setSettings((s) => ({ ...s, ...patch })))
        .catch((e) => notify(String(e)));
    } else setSettings((s) => ({ ...s, ...patch }));
  };
  const getInstalled = (app: Product) =>
    matchInstalled(app, installed, undefined);
  const toggleApp = (app: Product) => {
    if (
      !selection.some((s) => s.appId === app.id) &&
      matchMedia("(min-width:1251px)").matches
    )
      setCartOpen(true);
    setSelection((s) =>
      s.some((i) => i.appId === app.id)
        ? s.filter((i) => i.appId !== app.id)
        : [...s, defaultSelection(app)],
    );
  };
  const updateSelection = (s: Selection) => {
    if (matchMedia("(min-width:1251px)").matches) setCartOpen(true);
    setSelection((items) =>
      items.some((i) => i.appId === s.appId)
        ? items.map((i) => (i.appId === s.appId ? s : i))
        : [...items, s],
    );
  };
  const toggleFavorite = (id: string) =>
    setFavorites((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  const scan = async () => {
    const mode = settings.mode;
    const current = discoveryRequest.current.begin();
    const accept = () => current() && modeRef.current === mode;
    setScanning(true);
    try {
      const result = await api.scan(mode);
      if (!accept()) return;
      setInstalled(result.installed);
      setDetectedAt(Date.now());
      setScanWarning(result.warnings.join(" "));
      setUpdatesChecked(result.updatesChecked);
      void refreshSystem();
      notify(
        mode === "demo"
          ? "Демонстрация: сведения об установленных программах не считываются."
          : result.warnings.length
            ? result.warnings.join(" ")
            : `Проверка завершена. Обнаружено пакетов: ${result.installed.length}`,
      );
    } catch (e) {
      if (!accept()) return;
      setScanWarning(String(e));
      setUpdatesChecked(false);
      notify(String(e));
    } finally {
      if (accept()) setScanning(false);
    }
  };
  const refreshSystem = async () => {
    const mode = settings.mode,
      current = systemRequest.current.begin();
    try {
      const value = await api.system(mode);
      if (current() && modeRef.current === mode) {
        setSystem(value);
        setSystemError("");
      }
    } catch (e) {
      if (current() && modeRef.current === mode) setSystemError(String(e));
    }
  };
  const review = async (downloadOnly = false, explicit?: Selection[]) => {
    setOfflineReviewRoot(null);
    const current = planRequest.current.begin(),
      mode = settings.mode;
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
      if (!current() || modeRef.current !== mode) return;
      setPlan(p);
    } catch (e) {
      if (current() && modeRef.current === mode) notify(String(e));
    } finally {
      if (current() && modeRef.current === mode) setLoading(false);
    }
  };
  const reviewOffline = async (
    items: Selection[],
    root = offlineReviewRoot,
  ) => {
    if (!root || !items.length) return;
    const current = planRequest.current.begin(),
      mode = settings.mode;
    setLoading(true);
    try {
      const p = await feature<Plan>(
        "offline-prepare",
        { folder: root, items, includedAppIds: items.map((s) => s.appId) },
        mode,
      );
      if (!current() || modeRef.current !== mode) return;
      setRetryContext(null);
      setReviewItems(p.items.map((i) => i.selection));
      setOfflineReviewRoot(root);
      setPlan(p);
    } catch (e) {
      if (current() && modeRef.current === mode) notify(String(e));
    } finally {
      if (current() && modeRef.current === mode) setLoading(false);
    }
  };
  const launch = async () => {
    if (!plan) return;
    if (plan.mode !== settings.mode) {
      setPlan(null);
      notify("Режим изменился. Проверьте план заново.");
      return;
    }
    setBusy(true);
    try {
      await api.start(plan.token, settings.mode);
      setOfflineReviewRoot(null);
      setPlan(null);
      setCartOpen(false);
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
    const mode = settings.mode;
    try {
      await api.control(action, mode, id);
      const value = await api.queue(mode);
      if (modeRef.current === mode) setQueue(value);
    } catch (e) {
      notify(String(e));
    }
  };
  const replaceSelection = (items: Selection[]) => {
    setUndoSelection(structuredClone(selection));
    setSelection(items);
    setCartOpen(items.length > 0 && matchMedia("(min-width:1251px)").matches);
    notify(
      items.length
        ? "Выбор заменён. Предыдущий выбор можно восстановить."
        : "Выбор очищен. Предыдущий выбор можно восстановить.",
    );
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
    const current = planRequest.current.begin(),
      mode = settings.mode;
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
      if (!current() || modeRef.current !== mode) return;
      setRetryContext({ runId, status, taskId });
      setOfflineReviewRoot(
        p.items.flatMap((i) => i.tasks).find((t) => t.offlineRoot)
          ?.offlineRoot || null,
      );
      setReviewItems(p.items.map((i) => i.selection));
      setPlan(p);
    } catch (e) {
      if (current() && modeRef.current === mode) notify(String(e));
    } finally {
      if (current() && modeRef.current === mode) setLoading(false);
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
  const base = useMemo(
    () =>
      nav === "favorites"
        ? apps.filter((a) => favorites.includes(a.id))
        : nav === "installed"
          ? apps.filter((a) => getInstalled(a))
          : apps,
    [nav, favorites, installed],
  );
  const visible = useMemo(
    () =>
      filterApps(base, filters, installed).sort((a, b) =>
        sort === "publisher"
          ? a.publisher.localeCompare(b.publisher)
          : sort === "automation"
            ? a.install.method.localeCompare(b.install.method)
            : a.name.localeCompare(b.name, "ru"),
      ),
    [base, filters, installed, sort],
  );
  const categoryCounts = useMemo(
    () =>
      Object.fromEntries(
        categories.map((c) => [
          c.id,
          filterApps(apps, { ...filters, category: c.id }, installed).length,
        ]),
      ),
    [filters, installed],
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
    portability: "Переносимый офлайн-набор",
    downloads: "Полученные файлы",
  };
  const pageDescriptions: Record<string, string> = {
    catalog:
      "Выберите программы, проверьте план и выполните автоматические и ручные шаги.",
    installed: "Программы, обнаруженные на этом компьютере.",
    favorites: "Всё, что хочется держать под рукой.",
    queue: "Очередь — действия текущего запуска и шаги, требующие участия.",
    presets:
      "Набор — сохранённый выбор программ с параметрами для повторного применения.",
    history: "История — результаты всех запусков, журналы и отчёты.",
    settings: "Пусть AppDock работает так, как удобно вам.",
    updates: "Выберите поддерживаемые обновления и проверьте план.",
    profile:
      "Профиль — желаемый состав компьютера. Сравните его с обнаруженными программами.",
    portability: "Подготовьте проверенные установщики для компьютера без сети.",
    downloads:
      "Полученные файлы — готовые загрузки, их происхождение и проверка.",
  };

  const catalogScreen = useMemo(
    () =>
      ["catalog", "favorites", "installed"].includes(nav) ? (
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
          detectedAt={detectedAt}
          scan={scan}
          setNav={setNav}
          setWizard={setWizard}
          sort={sort}
          setSort={setSort}
        />
      ) : null,
    [
      installed,
      nav,
      filters,
      settings,
      visible,
      base,
      selection,
      favorites,
      showFilters,
      scanning,
      detectedAt,
      sort,
    ],
  );

  return (
    <div
      className={`app-shell ${selection.length ? "has-selection" : "empty-selection"} ${cartOpen ? "selection-open" : ""}`}
    >
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-caption">ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav aria-label="Основная навигация">
          {navItems.map(([id, label, Component]) => (
            <button
              key={id}
              aria-label={label}
              aria-current={nav === id ? "page" : undefined}
              title={label}
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
                aria-pressed={filters.category === c.id && nav === "catalog"}
                onClick={() => {
                  setNav("catalog");
                  setFilters({ ...initialFilters, category: c.id });
                }}
              >
                <Icon name={c.icon} size={16} />
                <span>{c.name}</span>
                <span className="category-count">{categoryCounts[c.id]}</span>
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
                updatesChecked={updatesChecked}
              />
            )}
            {scanWarning &&
              ["catalog", "installed", "updates", "profile"].includes(nav) && (
                <div role="alert" className="inline-note warning-text">
                  {scanWarning}{" "}
                  <button
                    className="text-button"
                    disabled={scanning}
                    onClick={() => void scan()}
                  >
                    Повторить обнаружение
                  </button>
                </div>
              )}
            {nav === "updates" && (
              <UpdatesScreen
                selectionRequest={updateSelectionRequest}
                installed={installed}
                profile={profile.items}
                mode={settings.mode}
                onReview={(items) => void review(false, items)}
                onScan={() => void scan()}
                scanning={scanning}
                detectedAt={detectedAt}
                updatesChecked={updatesChecked}
                notify={notify}
              />
            )}
            {nav === "profile" && (
              <>
                <SettingsTransfer
                  mode={settings.mode}
                  running={queue.running}
                  notify={notify}
                  onReview={(items) => void review(false, items)}
                />
                <ProfileScreen
                  checked={settings.mode === "demo" || detectedAt !== null}
                  onScan={() => void scan()}
                  profile={profile}
                  setProfile={setProfile}
                  installed={installed}
                  selection={selection}
                  mode={settings.mode}
                  onReview={(items) => void review(false, items)}
                  notify={notify}
                />
              </>
            )}
            {nav === "portability" && (
              <PortabilityScreen
                mode={settings.mode}
                running={queue.running}
                notify={notify}
                onPlan={(p) => {
                  setOfflineReviewRoot(
                    p.items.flatMap((i) => i.tasks).find((t) => t.offlineRoot)
                      ?.offlineRoot || null,
                  );
                  setRetryContext(null);
                  setReviewItems(p.items.map((i) => i.selection));
                  setPlan(p);
                }}
              />
            )}
            {nav === "downloads" && (
              <DownloadsScreen
                key={settings.mode}
                mode={settings.mode}
                notify={notify}
                running={queue.running}
              />
            )}
            {catalogScreen}
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
                refreshSystem={() => void refreshSystem()}
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
        clearSelection={() => replaceSelection([])}
        canUndo={undoSelection !== null}
        onUndo={() => {
          if (undoSelection) setSelection(undoSelection);
          setUndoSelection(null);
        }}
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
            else if (returnToPlan && offlineReviewRoot)
              void reviewOffline(
                reviewItems.map((i) => (i.appId === s.appId ? s : i)),
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
          busy={busy || loading}
          onClose={() => {
            if (!busy) {
              planRequest.current.invalidate();
              setLoading(false);
              setPlan(null);
            }
          }}
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
              if (offlineReviewRoot) void reviewOffline(remaining);
              else if (retryContext)
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
            if (offlineReviewRoot) void reviewOffline(reviewItems);
            else if (retryContext)
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
                  aria-pressed={wizardId === p.id}
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
                : `${programs(selection.length)}. Версии и параметры сохранятся без секретов.`}
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
              Установленные программы останутся на компьютере. Сохранённые части
              удаляемых прямых загрузок также удалятся, если они не нужны
              незавершённой задаче. Готовые файлы сохранятся.
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
