import fs from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const root = "artifacts/fix-2026-11-02";
fs.mkdirSync(root, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
let currentPage;
const products = JSON.parse(fs.readFileSync("catalog/apps.json", "utf8"));
const makeSelection = (id, action) => {
  const a = products.find((a) => a.id === id);
  return {
    appId: id,
    action:
      action ||
      (a.install.downloadUrl
        ? "download"
        : a.install.method === "manual"
          ? "guide"
          : ["web", "cloud"].includes(a.type)
            ? "open"
            : "install"),
    options: Object.fromEntries(a.options.map((o) => [o.id, o.default])),
    extensions: [],
  };
};
const errors = [],
  results = [],
  layouts = [],
  contrasts = [];
const record = (s) => {
  results.push(s);
  console.log("PASS: " + s);
};
const longName =
  "Google Chrome — Очень длинное название программы для проверки переноса строк и доступности кнопок ПараметрыБезПробелов";
async function open(seed = {}, bridge = null, longNames = false) {
  const context = await browser.newContext({
    viewport: { width: 1500, height: 960 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  currentPage = page;
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  if (longNames)
    await page.route("**/catalog/apps.json*", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace("Google Chrome", longName),
      });
    });
  await page.addInitScript(
    ({ seed, bridge }) => {
      for (const [key, value] of Object.entries(seed))
        localStorage.setItem("appdock:" + key, JSON.stringify(value));
      if (bridge) {
        window.isTauri = true;
        window.calls = [];
        window.scanData = bridge.scan || {
          installed: [],
          warnings: [],
          updatesChecked: true,
        };
        window.delayed = bridge.delayed;
        window.waiting = [];
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
        window.__TAURI_INTERNALS__ = {
          transformCallback: () => 1,
          invoke: async (command, args) => {
            window.calls.push({ command, args });
            if (command.startsWith("plugin:event|")) return 1;
            if (command === "queue_snapshot")
              return {
                schemaVersion: 2,
                runs: [],
                tasks: [],
                running: false,
                paused: false,
                mode: "live",
                updatedAt: 1,
              };
            if (command === "scan_installed")
              return window.delayed
                ? new Promise((resolve) =>
                    window.waiting.push(() => resolve(window.scanData)),
                  )
                : structuredClone(window.scanData);
            if (command === "system_info") {
              const value = {
                windows: true,
                arch: "x64",
                winget: "fixture",
                freeDiskMb: 100000,
                virtualization: true,
                wsl: "Тест",
                hyperV: "Тест",
                admin: false,
                os: "WINDOWS LIVE FIXTURE",
              };
              return window.delayed
                ? new Promise((resolve) =>
                    window.waiting.push(() => resolve(value)),
                  )
                : value;
            }
            throw new Error("Unexpected native command: " + command);
          },
        };
      }
    },
    { seed, bridge },
  );
  await page.goto("http://127.0.0.1:1420/");
  await page.getByRole("textbox", { name: "Поиск программ" }).waitFor();
  return { page, context };
}
const nav = (page, name) =>
  page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
async function stable(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
}
async function shot(page, name) {
  await stable(page);
  await page.screenshot({ path: `${root}/${name}.png` });
}
async function contrast(page, selector, label) {
  const rows = await page.locator(selector).evaluateAll((nodes) => {
    const rgba = (s) => {
      const v = s.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0];
      return [v[0], v[1], v[2], v[3] ?? 1];
    };
    const over = (a, b) => [
      ...a.slice(0, 3).map((v, i) => v * a[3] + b[i] * (1 - a[3])),
      1,
    ];
    const lum = (c) =>
      c
        .slice(0, 3)
        .map((v) => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        })
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    return nodes
      .filter((n) => n.getBoundingClientRect().width && !n.disabled)
      .map((n) => {
        const ancestors = [];
        for (let e = n; e; e = e.parentElement) ancestors.unshift(e);
        let bg = [255, 255, 255, 1];
        for (const e of ancestors)
          bg = over(rgba(getComputedStyle(e).backgroundColor), bg);
        const c = over(rgba(getComputedStyle(n).color), bg),
          a = lum(c),
          b = lum(bg);
        return {
          text: n.textContent.trim().slice(0, 70),
          color: c,
          background: bg,
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        };
      });
  });
  contrasts.push({ label, rows });
  for (const row of rows)
    assert(
      row.ratio >= 4.5,
      `${label} «${row.text}» contrast ${row.ratio.toFixed(2)}`,
    );
}
try {
  // A native host flag must not let demo downloads reach the bridge.
  let { page, context } = await open({ settings: { mode: "demo" } }, {});
  await nav(page, "Полученные файлы");
  await page.getByRole("heading", { name: "Пример Office 2024.img" }).waitFor();
  await page
    .getByRole("button", { name: "Выбрать папку", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Удалить из кэша Пример Office 2024.img" })
    .click();
  const deletion = page.getByRole("dialog", {
    name: "Удалить полученный файл?",
  });
  await deletion.waitFor();
  await deletion.getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(
    await page.getByRole("heading", { name: "Пример Office 2024.img" }).count(),
    1,
  );
  await page
    .getByRole("button", { name: "Удалить из кэша Пример Office 2024.img" })
    .click();
  await deletion
    .getByRole("button", { name: "Удалить файл", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Пример Office 2024.img" })
    .waitFor({ state: "detached" });
  assert.equal((await page.evaluate(() => window.calls)).length, 0);
  record(
    "F01: native-flag demo folder/delete never invokes native commands; confirmation can be cancelled",
  );
  await context.close();

  const office = makeSelection("word", "download"),
    web = makeSelection("google-docs", "shortcut");
  ({ page, context } = await open({
    presets: [
      {
        id: "actions",
        name: "Действия",
        description: "",
        icon: "Package",
        builtin: false,
        items: [office, web],
      },
    ],
  }));
  await nav(page, "Наборы");
  const preset = page.locator(".preset-card").filter({
    has: page.getByRole("heading", { name: "Действия", exact: true }),
  });
  await preset
    .getByRole("button", { name: "Заменить выбор", exact: true })
    .click();
  const items = await page.evaluate(
    () => JSON.parse(localStorage.getItem("appdock:selection")).data,
  );
  assert.deepEqual(
    items.map((s) => s.action),
    ["download", "shortcut"],
  );
  await page
    .getByRole("button", { name: "Проверить план", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Проверим всё перед запуском" })
    .waitFor();
  assert(
    (await page.locator(".plan-expanded").allTextContents())
      .join(" ")
      .includes("Веб-ярлык"),
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Очистить выбор", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Восстановить предыдущий выбор", exact: true })
    .click();
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("appdock:selection")).data.map(
        (s) => s.action,
      ),
    ),
    ["download", "shortcut"],
  );
  await preset.locator("summary").click();
  await preset.getByRole("button", { name: "Удалить", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Удалить набор?" })
    .getByRole("button", { name: "Отмена", exact: true })
    .click();
  assert.equal(await preset.count(), 1);
  record(
    "F02/U02: Office download and web shortcut survive preset application, plan, clear/undo; preset delete has confirmation",
  );
  await context.close();

  ({ page, context } = await open());
  await nav(page, "Профиль ПК");
  await page.getByLabel("Импорт профиля", { exact: true }).setInputFiles({
    name: "duplicate.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        name: "Дубликат",
        items: [makeSelection("chrome"), makeSelection("chrome")],
      }),
    ),
  });
  await page
    .getByRole("status")
    .filter({ hasText: "Повторяющаяся программа: Google Chrome" })
    .waitFor();
  assert.equal(
    await page.getByRole("dialog", { name: "Совместимость профиля" }).count(),
    0,
  );
  record(
    "F04: duplicate profile import rejected before confirmation, with product name",
  );
  await context.close();

  const manualSelection = makeSelection("chrome", "guide"),
    finishedSelection = makeSelection("firefox");
  const tasks = [manualSelection, finishedSelection].map((selection, i) => ({
    id: "manual-" + i,
    runId: "manual-run",
    appId: selection.appId,
    name: products.find((a) => a.id === selection.appId).name,
    action: selection.action,
    status: i ? "installed" : "action-required",
    message: i ? "Готово" : "Нужна ручная установка",
    log: [],
    percent: null,
    selection,
    dependencies: [],
    finishedAt: 2,
  }));
  ({ page, context } = await open({
    "demo-queue": {
      schemaVersion: 2,
      currentRunId: "manual-run",
      runs: [
        {
          id: "manual-run",
          createdAt: 1,
          finishedAt: 2,
          mode: "demo",
          skipCurrent: true,
          parallelDownloads: 2,
          selections: [manualSelection, finishedSelection],
          outcome: "action-required",
        },
      ],
      tasks,
      running: false,
      paused: false,
      mode: "demo",
      updatedAt: 2,
    },
  }));
  await nav(page, "Загрузки и установка");
  await page
    .getByRole("button", { name: "Очистить завершённое", exact: true })
    .click();
  await page.getByRole("button", { name: "Очистить", exact: true }).click();
  assert.equal(await page.locator(".task-row").count(), 1);
  await page.locator(".task-row summary").click();
  await page
    .getByRole("button", { name: "Шаг выполнен", exact: true })
    .waitFor();
  await shot(page, "manual-task-after-clear");
  record(
    "F05: clear removes finished work and retains the visible manual action",
  );
  await context.close();

  const a = products.find((a) => a.id === "chrome"),
    pin = { ...makeSelection("chrome"), version: a.version };
  ({ page, context } = await open(
    {
      "computer-profile": {
        schemaVersion: 2,
        name: "Профиль тест",
        items: [pin],
        unsupported: [],
      },
    },
    {
      scan: {
        installed: [{ packageId: a.install.packageId, version: "100" }],
        warnings: [],
        updatesChecked: true,
      },
    },
  ));
  await page.waitForFunction(() =>
    window.calls.some((c) => c.command === "scan_installed"),
  );
  await nav(page, "Профиль ПК");
  await page
    .getByText("Обновить до закреплённой версии", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Проверить план профиля (1)", exact: true })
      .isEnabled(),
    true,
  );
  record(
    "F03: pinned older installed version has matching row status and actionable plan count",
  );
  await shot(page, "profile-pinned-live-fixture");
  await context.close();

  const vs = products.find((a) => a.id === "visual-studio"),
    packageId = vs.editions[0].packageId;
  ({ page, context } = await open(
    {},
    {
      scan: {
        installed: [
          {
            packageId,
            instanceId: "one",
            version: "18.0",
            availableVersion: "18.1",
          },
          {
            packageId,
            instanceId: "two",
            version: "18.0",
            availableVersion: "18.1",
          },
          {
            packageId: a.install.packageId,
            version: "100",
            availableVersion: "101",
          },
        ],
        warnings: [],
        updatesChecked: true,
      },
    },
  ));
  await nav(page, "Обновления");
  await page
    .getByRole("button", { name: "Выбрать доступные", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "Обновить " + vs.name, exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("checkbox", { name: "Обновить Google Chrome", exact: true })
      .isChecked(),
    true,
  );
  await page
    .getByRole("button", { name: "Проверить план обновлений (1)", exact: true })
    .waitFor();
  await shot(page, "updates-ambiguous-live-fixture");
  await page.evaluate(
    () =>
      (window.scanData = {
        installed: [],
        warnings: [
          "Установленные программы считаны; обновления проверить не удалось",
        ],
        updatesChecked: false,
      }),
  );
  await page
    .getByRole("button", { name: "Проверить обновления", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Проверить план обновлений (0)", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", {
        name: "Проверить план обновлений (0)",
        exact: true,
      })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("alert")
    .filter({ hasText: "обновления проверить не удалось" })
    .waitFor();
  record(
    "F06/O05: bulk selection excludes ambiguous instances and invalidates stale choices; partial scan failure is explicit",
  );
  await context.close();

  ({ page, context } = await open(
    {},
    {
      delayed: true,
      scan: {
        installed: [{ packageId: a.install.packageId, version: "STALE LIVE" }],
        warnings: ["STALE WARNING"],
        updatesChecked: true,
      },
    },
  ));
  await page.waitForFunction(() => window.waiting.length >= 2);
  await nav(page, "Настройки");
  await page
    .getByRole("switch", { name: "Демонстрационный режим", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem("appdock:settings")).data.mode === "demo",
  );
  await page.evaluate(() => {
    window.waiting.splice(0).forEach((resolve) => resolve());
  });
  await nav(page, "Установленные");
  assert.equal(await page.locator(".product-card").count(), 0);
  assert(!(await page.locator("body").textContent()).includes("STALE LIVE"));
  assert(
    !(await page.locator("body").textContent()).includes(
      "WINDOWS LIVE FIXTURE",
    ),
  );
  record("O05: delayed live system/scan responses cannot overwrite demo state");
  await context.close();

  for (const theme of ["dark", "light"]) {
    ({ page, context } = await open({
      settings: { theme },
      favorites: ["chrome"],
    }));
    for (const [width, height] of [
      [1500, 960],
      [1366, 768],
      [1280, 720],
      [1020, 700],
    ]) {
      await page.setViewportSize({ width, height });
      for (const view of ["grid", "list"]) {
        await page
          .getByRole("button", {
            name: view === "grid" ? "Карточки" : "Компактный список",
            exact: true,
          })
          .click();
        await stable(page);
        const layout = await page.evaluate(() => {
          const cards = [...document.querySelectorAll(".product-card")]
            .slice(0, 2)
            .map((e) => e.getBoundingClientRect().toJSON());
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            cards,
            search: document
              .querySelector('[aria-label="Поиск программ"]')
              .getBoundingClientRect()
              .toJSON(),
            pane: document
              .querySelector(".selection-pane")
              .getBoundingClientRect()
              .toJSON(),
          };
        });
        layouts.push({ theme, width, height, view, ...layout });
        assert.equal(layout.overflow, false);
        if (view === "list")
          assert(
            layout.cards[1].y >= layout.cards[0].bottom,
            "one card per readable list row",
          );
        if (width === 1366 && view === "grid")
          assert(
            layout.cards[0].bottom <= height - layout.pane.height,
            "complete first card row visible at 1366x768",
          );
        assert(
          layout.pane.height <= 48,
          "empty selection occupies only the disclosure bar",
        );
        await shot(page, `${theme}-${width}-${height}-${view}`);
      }
    }
    await page.setViewportSize({ width: 1500, height: 960 });
    for (const [id, label] of [
      ["installed", "Установленные"],
      ["updates", "Обновления"],
      ["presets", "Наборы"],
      ["profile", "Профиль ПК"],
      ["files", "Полученные файлы"],
      ["queue", "Загрузки и установка"],
      ["history", "История"],
      ["settings", "Настройки"],
    ]) {
      await nav(page, label);
      await shot(page, `${theme}-screen-${id}`);
    }
    await nav(page, "Каталог");
    await page.setViewportSize({ width: 1366, height: 768 });
    await contrast(
      page,
      ".nav-item,.category-nav,.catalog-tabs button.active,.view-switch button.active,.badge",
      theme + " navigation/default",
    );
    for (const state of ["hover", "focus"]) {
      const current = page
        .getByRole("navigation")
        .getByRole("button", { name: "Каталог", exact: true });
      if (state === "hover") await current.hover();
      else {
        await page.mouse.move(1400, 0);
        await current.focus();
      }
      await stable(page);
      await contrast(page, ".nav-item.active", theme + " navigation/" + state);
    }
    await page
      .getByRole("button", { name: "Выбрать Google Chrome", exact: true })
      .click();
    await contrast(
      page,
      ".button.primary:not(:disabled)",
      theme + " primary/default",
    );
    const primary = page.getByRole("button", {
      name: "Проверить план",
      exact: true,
    });
    for (const state of ["hover", "focus"]) {
      if (state === "hover") await primary.hover();
      else await primary.focus();
      await stable(page);
      await contrast(
        page,
        ".button.primary:not(:disabled)",
        theme + " primary/" + state,
      );
    }
    await primary.click();
    await page.getByRole("dialog").waitFor();
    await shot(page, `${theme}-plan`);
    await page.keyboard.press("Tab");
    assert(
      await page
        .getByRole("dialog")
        .evaluate((e) => e.contains(document.activeElement)),
    );
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Закрыть панель выбора", exact: true })
      .click();
    await page.setViewportSize({ width: 1020, height: 700 });
    await page
      .getByRole("button", { name: "Ваш выбор · 1 Показать", exact: true })
      .click();
    await shot(page, `${theme}-selection-open-1020`);
    const overlap = await page.evaluate(() => {
      const a = document.querySelector(".main-pane").getBoundingClientRect(),
        b = document.querySelector(".selection-pane").getBoundingClientRect();
      return a.bottom > b.top + 1;
    });
    assert.equal(overlap, false);
    await page
      .getByRole("button", { name: "Закрыть панель выбора", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Ваш выбор · 1 Показать", exact: true })
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await nav(page, "Избранное");
    await page
      .getByRole("textbox", { name: "Поиск программ" })
      .fill("Нет такой программы");
    await page
      .getByRole("heading", { name: "Ничего не найдено по фильтрам" })
      .waitFor();
    await shot(page, `${theme}-favorites-filter-empty`);
    await page
      .getByRole("button", { name: "Сбросить фильтры", exact: true })
      .click();
    assert.equal(await page.locator(".product-card").count(), 1);
    for (let i = 0; i < 20; i++) {
      await nav(page, "Настройки");
      await page.keyboard.press("Control+k");
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("aria-label") ===
          "Поиск программ",
      );
    }
    await page
      .getByRole("textbox", { name: "Поиск программ" })
      .fill("Visual Studio Code");
    await page
      .getByRole("button", {
        name: "Параметры Visual Studio Code",
        exact: true,
      })
      .click();
    assert.equal(
      await page.locator(".extension-list input:checked").count(),
      0,
    );
    await shot(page, `${theme}-vscode-options`);
    await page.keyboard.press("Escape");
    await page.getByRole("textbox", { name: "Поиск программ" }).fill("");
    for (const zoom of [1.25, 1.5, 2]) {
      await page.evaluate(
        (zoom) => (document.body.style.zoom = String(zoom)),
        zoom,
      );
      await stable(page);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      assert(
        await page
          .locator(".selection-pane")
          .evaluate((e) => e.getBoundingClientRect().bottom <= innerHeight + 1),
      );
      await shot(page, `${theme}-zoom-${zoom}`);
    }
    await page.evaluate(() => (document.body.style.zoom = "1"));
    for (const [width, height] of [
      [816, 560],
      [680, 467],
      [510, 350],
    ]) {
      await page.setViewportSize({ width, height });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await shot(page, `${theme}-reflow-${width}`);
    }
    await context.close();
    ({ page, context } = await open({ settings: { theme } }, null, true));
    await page.setViewportSize({ width: 1020, height: 700 });
    await page
      .getByRole("textbox", { name: "Поиск программ" })
      .fill("Google Chrome");
    await page
      .getByRole("button", { name: "Компактный список", exact: true })
      .click();
    await shot(page, `${theme}-long-name-list`);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page
      .getByRole("button", { name: "Параметры " + longName, exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    assert(
      await page
        .getByRole("dialog")
        .evaluate((e) => e.scrollWidth <= e.clientWidth),
    );
    await shot(page, `${theme}-long-name-dialog`);
    await page.evaluate(() => (document.body.style.zoom = "2"));
    await stable(page);
    assert(
      await page
        .getByRole("dialog")
        .evaluate(
          (e) =>
            e.getBoundingClientRect().bottom <= innerHeight + 1 &&
            e.getBoundingClientRect().top >= -1,
        ),
    );
    await shot(page, `${theme}-dialog-zoom-2`);
    await page.keyboard.press("Escape");
    await context.close();
  }
  record(
    "F07–F11/U01/U08: both themes, four viewports, list rows, no overlay, full first row, keyboard/focus, 125/150/200% reflow, actual color contrast",
  );
  assert.deepEqual(errors, []);
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: `${root}/failure.png` });
    fs.writeFileSync(
      `${root}/failure.json`,
      JSON.stringify(
        await currentPage.evaluate(() => ({
          url: location.href,
          visibility: document.visibilityState,
          settings: localStorage.getItem("appdock:settings"),
          calls: window.calls,
          scanData: window.scanData,
          text: document.body.innerText,
        })),
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  fs.writeFileSync(
    `${root}/ui-regressions.json`,
    JSON.stringify({ results, errors, layouts, contrasts }, null, 2),
  );
  await browser.close();
}
