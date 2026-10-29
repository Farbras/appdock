import { installedInstances } from "../catalog";
import {
  ArrowUpRight,
  Check,
  Code2,
  ExternalLink,
  FileText,
  Globe,
  Heart,
  Info,
  LayoutGrid,
  List,
  Monitor,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import type { Filters } from "../catalog";
import { categories, initialFilters, isWeb, typeNames } from "../catalog";
import type { InstalledApp, Product, Selection, Settings } from "../types";

import { Icon, Logo } from "../components/ui";

import type { Dispatch, RefObject, SetStateAction } from "react";
export function CatalogScreen({
  installed,
  nav,
  filters,
  setFilters,
  settings,
  changeSettings,
  visible,
  base,
  getInstalled,
  selection,
  toggleApp,
  setDetail,
  toggleFavorite,
  favorites,
  showFilters,
  setShowFilters,
  searchRef,
  scanning,
  scan,
  setNav,
  setWizard,
  sort,
  setSort,
}: {
  installed: InstalledApp[];
  nav: string;
  filters: Filters;
  setFilters: Dispatch<SetStateAction<Filters>>;
  settings: Settings;
  changeSettings: (p: Partial<Settings>) => void;
  visible: Product[];
  base: Product[];
  getInstalled: (a: Product) => InstalledApp | undefined;
  selection: Selection[];
  toggleApp: (a: Product) => void;
  setDetail: (a: Product | null) => void;
  toggleFavorite: (id: string) => void;
  favorites: string[];
  showFilters: boolean;
  setShowFilters: Dispatch<SetStateAction<boolean>>;
  searchRef: RefObject<HTMLInputElement | null>;
  scanning: boolean;
  scan: () => Promise<void>;
  setNav: (nav: string) => void;
  setWizard: (v: boolean) => void;
  sort: string;
  setSort: (v: string) => void;
}) {
  return (
    <>
      {nav === "catalog" && filters.category === "all" && !filters.query && (
        <section className="welcome-banner">
          <div className="banner-content">
            <span className="mini-label">
              <Sparkles size={13} />
              КОМПЬЮТЕР, ГОТОВЫЙ К ВАШИМ ЗАДАЧАМ
            </span>
            <h2>Новый старт. Без лишних шагов.</h2>
            <p>
              Браузер, рабочие инструменты и любимые приложения.
              <br />
              Всё нужное — в одной очереди.
            </p>
            <button className="banner-button" onClick={() => setWizard(true)}>
              Подобрать по задаче
              <ArrowUpRight size={16} />
            </button>
          </div>
          <div className="banner-art" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <span className="art-tile tile-code">
              <Code2 />
            </span>
            <span className="art-tile tile-world">
              <Globe />
            </span>
            <span className="art-tile tile-doc">
              <FileText />
            </span>
            <span className="art-main">
              <div className="brand-icon">
                <span />
                <span />
                <span />
                <span />
              </div>
            </span>
            <span className="art-spark">✦</span>
          </div>
        </section>
      )}
      <div className="search-toolbar">
        <div className="search-field">
          <Search size={18} />
          <input
            ref={searchRef}
            value={filters.query}
            onChange={(e) =>
              setFilters((f) => ({ ...f, query: e.target.value }))
            }
            placeholder="Найти программу, издателя или задачу…"
            aria-label="Поиск программ"
          />
          {filters.query ? (
            <button
              aria-label="Очистить поиск"
              onClick={() => setFilters((f) => ({ ...f, query: "" }))}
            >
              <X size={15} />
            </button>
          ) : (
            <kbd>Ctrl K</kbd>
          )}
        </div>
        <button
          className={`button secondary filters-button ${showFilters ? "selected" : ""}`}
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
        >
          <SlidersHorizontal size={17} />
          <span>Фильтры</span>
          {Object.entries(filters).filter(
            ([k, v]) => !["query", "category"].includes(k) && v !== "all",
          ).length > 0 && <span className="filter-dot" />}
        </button>
        <div className="view-switch" aria-label="Вид каталога">
          <button
            className={settings.view === "grid" ? "active" : ""}
            onClick={() => changeSettings({ view: "grid" })}
            aria-label="Карточки"
            aria-pressed={settings.view === "grid"}
          >
            <LayoutGrid size={17} />
          </button>
          <button
            className={settings.view === "list" ? "active" : ""}
            onClick={() => changeSettings({ view: "list" })}
            aria-label="Компактный список"
            aria-pressed={settings.view === "list"}
          >
            <List size={18} />
          </button>
        </div>
      </div>
      {showFilters && (
        <div className="filter-panel">
          {[
            ["category", "Категория", categories.map((c) => [c.id, c.name])],
            [
              "platform",
              "Платформа",
              [
                ["all", "Все платформы"],
                ["windows", "Windows"],
                ["macos", "macOS"],
                ["linux", "Linux"],
                ["ios", "iOS"],
                ["web", "Веб"],
              ],
            ],
            [
              "status",
              "Состояние",
              [
                ["all", "Любое состояние"],
                ["installed", "Установлено"],
                ["missing", "Не установлено"],
                ["update", "Есть обновление"],
              ],
            ],
            [
              "license",
              "Лицензия",
              [
                ["all", "Любая лицензия"],
                ["free", "Бесплатное"],
                ["paid", "Платное"],
                ["trial", "Пробная версия"],
              ],
            ],
            [
              "type",
              "Тип продукта",
              [["all", "Любой тип"], ...Object.entries(typeNames)],
            ],
            [
              "automation",
              "Установка",
              [
                ["all", "Любая установка"],
                ["auto", "Автоматическая"],
                ["manual", "Требуется участие"],
              ],
            ],
          ].map(([key, label, options]) => (
            <label key={key as string}>
              {label as string}
              <select
                aria-label={label as string}
                value={filters[key as keyof Filters]}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    [key as string]: e.target.value,
                  }))
                }
              >
                {(options as string[][]).map(([value, text]) => (
                  <option value={value} key={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button
            className="text-button"
            onClick={() => setFilters(initialFilters)}
          >
            <RotateCcw size={14} />
            Сбросить фильтры
          </button>
        </div>
      )}
      <div className="section-tools wrap">
        <label>
          Сортировка{" "}
          <select
            aria-label="Сортировка"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="name">По названию</option>
            <option value="publisher">По издателю</option>
            <option value="automation">По типу установки</option>
          </select>
        </label>
        <div className="action-counts">
          {Object.entries(filters)
            .filter(([, v]) => v !== "all" && v !== "")
            .map(([k, v]) => (
              <button
                className="badge"
                key={k}
                aria-label={"Снять фильтр " + k}
                onClick={() =>
                  setFilters((f) => ({
                    ...f,
                    [k]: k === "query" ? "" : "all",
                  }))
                }
              >
                {
                  (
                    {
                      platform: "Платформа",
                      status: "Состояние",
                      category: "Категория",
                      license: "Лицензия",
                      type: "Тип",
                      automation: "Действие",
                      query: "Поиск",
                    } as Record<string, string>
                  )[k]
                }
                : {v} ×
              </button>
            ))}
        </div>
      </div>
      <div className="catalog-tabs">
        <div>
          {[
            { id: "all", name: "Все программы" },
            ...categories.filter((c) =>
              ["development", "browsers", "documents", "databases"].includes(
                c.id,
              ),
            ),
          ].map((c) => (
            <button
              key={c.id}
              className={filters.category === c.id ? "active" : ""}
              onClick={() => setFilters((f) => ({ ...f, category: c.id }))}
            >
              {c.name}
              {c.id === "all" && <span>{base.length}</span>}
            </button>
          ))}
        </div>
        <span className="result-count">Найдено: {visible.length}</span>
      </div>
      {nav === "installed" && (
        <div className="inline-note">
          <Info size={17} />
          <span>
            {scanning
              ? "Считываем версии через WinGet и реестр…"
              : settings.mode === "demo"
                ? "В деморежиме установленные программы не считываются."
                : "Здесь показаны программы доверенного каталога, найденные через WinGet, реестр и службы. Это не полный список Windows. Состояние обновляется после завершения запуска."}
          </span>
        </div>
      )}
      {visible.length === 0 ? (
        <div className="empty-state">
          <span>
            <Search size={28} />
          </span>
          <h3>
            {nav === "favorites"
              ? "Пока без избранного"
              : nav === "installed"
                ? "Здесь появятся ваши программы"
                : "Ничего не найдено"}
          </h3>
          <p>
            {nav === "favorites"
              ? "Нажмите на сердечко в карточке программы."
              : nav === "installed"
                ? "Запустите проверку в рабочем режиме."
                : "Попробуйте другое название или измените фильтры."}
          </p>
          <button
            className="button secondary"
            onClick={() => {
              setFilters(initialFilters);
              if (nav === "installed") void scan();
              else if (nav === "favorites") setNav("catalog");
            }}
          >
            {nav === "installed"
              ? "Проверить компьютер"
              : nav === "favorites"
                ? "Открыть каталог"
                : "Сбросить фильтры"}
          </button>
        </div>
      ) : (
        categories
          .filter((c) => c.id !== "all")
          .map((category) => {
            const group = visible.filter((a) => a.category === category.id);
            if (!group.length) return null;
            return (
              <section className="catalog-section" key={category.id}>
                <div className="section-heading">
                  <div>
                    <Icon name={category.icon} size={18} />
                    <h2>{category.name}</h2>
                    <span>{group.length}</span>
                  </div>
                  <span>
                    {category.id === "browsers"
                      ? "Ваше окно в интернет"
                      : category.id === "development"
                        ? "Инструменты для больших идей"
                        : ""}
                  </span>
                </div>
                <div
                  className={`product-grid ${settings.view === "list" ? "list-view" : ""}`}
                >
                  {group.map((app) => {
                    const chosen = selection.some((s) => s.appId === app.id);
                    const ins = getInstalled(app);
                    const unsupported = !app.platforms.includes("windows");
                    return (
                      <article
                        key={app.id}
                        className={`product-card ${chosen ? "chosen" : ""} ${unsupported ? "unsupported" : ""}`}
                      >
                        <div className="card-top">
                          <button
                            className="product-open"
                            onClick={() => setDetail(app)}
                            aria-label={`Настройки ${app.name}`}
                          >
                            <Logo app={app} />
                            <div>
                              <h3>{app.name}</h3>
                              <span className="publisher">{app.publisher}</span>
                            </div>
                          </button>
                          <button
                            className={`selection-check ${chosen ? "checked" : ""}`}
                            aria-label={`${chosen ? "Убрать" : "Выбрать"} ${app.name}`}
                            aria-pressed={chosen}
                            onClick={() => toggleApp(app)}
                          >
                            {chosen && <Check size={15} strokeWidth={3} />}
                          </button>
                        </div>
                        <button
                          className="card-description"
                          onClick={() => setDetail(app)}
                        >
                          {app.description}
                        </button>
                        <div className="card-badges">
                          {unsupported ? (
                            <span className="badge muted">
                              <Info size={11} />
                              Только{" "}
                              {app.id === "safari" ? "macOS / iOS" : "macOS"}
                            </span>
                          ) : isWeb(app) ? (
                            <span className="badge cyan">
                              <Globe size={11} />
                              {typeNames[app.type]}
                            </span>
                          ) : ins ? (
                            <span
                              className={`badge ${ins.availableVersion ? "amber" : "green"}`}
                            >
                              <Check size={11} />
                              {ins.availableVersion
                                ? "Есть обновление"
                                : "Установлено"}{" "}
                              {ins.version}
                            </span>
                          ) : app.install.method === "winget" &&
                            app.install.verification === "verified" ? (
                            <span className="badge">
                              <Monitor size={11} />
                              Windows
                            </span>
                          ) : (
                            <span className="badge amber">
                              <ExternalLink size={11} />
                              {app.id === "atom"
                                ? "Архивный продукт"
                                : "Ручная установка"}
                            </span>
                          )}
                          {app.license === "trial" && (
                            <span className="badge muted">Пробная версия</span>
                          )}
                        </div>
                        {nav === "installed" &&
                          installedInstances(app, installed).map(
                            (record, i) => (
                              <p
                                className="muted-text"
                                key={record.instanceId || i}
                              >
                                {record.edition || "Пакет"}
                                {record.instanceId
                                  ? " · экземпляр " + record.instanceId
                                  : ""}
                                : {record.version}
                                {record.availableVersion
                                  ? " → " + record.availableVersion
                                  : ""}
                              </p>
                            ),
                          )}
                        <div className="card-footer">
                          <span title={app.version}>
                            Доступная:{" "}
                            {app.version === "Уточняется в источнике"
                              ? "Версия у издателя"
                              : app.version}
                          </span>
                          <div>
                            <button
                              className={`icon-button favorite-button ${favorites.includes(app.id) ? "hearted" : ""}`}
                              aria-label={`${favorites.includes(app.id) ? "Удалить из" : "Добавить в"} избранное ${app.name}`}
                              onClick={() => toggleFavorite(app.id)}
                            >
                              <Heart
                                size={15}
                                fill={
                                  favorites.includes(app.id)
                                    ? "currentColor"
                                    : "none"
                                }
                              />
                            </button>
                            <button
                              className="card-settings"
                              onClick={() => setDetail(app)}
                              aria-label={`Параметры ${app.name}`}
                            >
                              <SlidersHorizontal size={14} />
                              <span>Параметры</span>
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })
      )}
      <div className="catalog-footer">
        <ShieldCheck size={15} />
        <span>
          ID источника проверен. Установки и дополнительные настройки могут
          требовать участия.
        </span>
        <button
          onClick={() => {
            setNav("settings");
          }}
        >
          Об интеграциях
          <ArrowUpRight size={13} />
        </button>
      </div>
    </>
  );
}
