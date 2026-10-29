import fs from "node:fs";
import { pathToFileURL } from "node:url";
const runtime = process.env.APPDOCK_PLAYWRIGHT;
const { chromium } = await import(
  runtime
    ? runtime.startsWith("file:")
      ? runtime
      : pathToFileURL(runtime).href
    : "playwright"
);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
const appData = JSON.parse(fs.readFileSync("catalog/apps.json", "utf8"));
const selection = (id) => {
  const a = appData.find((a) => a.id === id);
  return {
    appId: id,
    action:
      a.install.method === "manual"
        ? "guide"
        : ["web", "cloud"].includes(a.type)
          ? "open"
          : "install",
    options: Object.fromEntries(a.options.map((o) => [o.id, o.default])),
    extensions: [],
  };
};
const open = async (seed = {}, routeMock = false) => {
  const context = await browser.newContext({
    viewport: { width: 1500, height: 960 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((seed) => {
    for (const [k, v] of Object.entries(seed))
      localStorage.setItem("appdock:" + k, JSON.stringify(v));
  }, seed);
  if (routeMock)
    await page.route("**/src/api.ts*", async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      body = body.replace(
        "async scan(mode) {",
        'async scan(mode) { return [{packageId:"Google.Chrome.EXE",version:"100",availableVersion:"101"},{packageId:"appdock:postgres",version:"16"}];',
      );
      await route.fulfill({ response, body });
    });
  await page.goto("http://127.0.0.1:1420/");
  await page
    .getByRole("heading", {
      name: "Подготовьте компьютер к работе",
      exact: true,
    })
    .waitFor();
  return { context, page };
};
const check = (value, message) => {
  if (!value) throw new Error(message);
};
const run = async (page) => {
  await page
    .getByRole("checkbox", {
      name: "Запустить демонстрацию выполнения без изменения компьютера.",
    })
    .check();
  await page
    .getByRole("button", { name: "Запустить демо", exact: true })
    .click();
};
const results = [];
const record = (message) => {
  results.push(message);
  console.log("PASS: " + message);
};
fs.mkdirSync("artifacts", { recursive: true });
try {
  // New user, readable plan, demo, keyboard focus, minimum width and zoom.
  let { page, context } = await open();
  check(
    (await page.locator(".product-card").count()) === 78,
    "Windows defaults",
  );
  check(
    (await page.locator(".selection-counter").textContent()) === "0",
    "No preselection",
  );
  await page
    .getByRole("button", { name: "Выбрать Google Chrome", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Параметры Visual Studio Code", exact: true })
    .click();
  await page
    .getByLabel("Профиль расширений", { exact: true })
    .selectOption("Python");
  check(
    (await page.locator(".extension-list input:checked").count()) >= 3,
    "Python profile dependencies",
  );
  await page
    .getByRole("button", { name: "Добавить в выбор", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Проверить план", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Проверим всё перед запуском" })
    .waitFor();
  check(
    (await page.locator(".plan-expanded li").count()) >= 5,
    "Expanded plan tasks",
  );
  await page.screenshot({ path: "artifacts/plan-v020.png" });
  await run(page);
  await page.waitForFunction(() => {
    const q = JSON.parse(localStorage.getItem("appdock:demo-queue") || "null");
    return q?.data && !q.data.running;
  });
  check((await page.locator(".task-row").count()) >= 5, "Run tasks");
  record("new user → exact plan → demo run");
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Поиск программ" }).waitFor();
  check(
    await page
      .getByRole("textbox", { name: "Поиск программ" })
      .evaluate((e) => e === document.activeElement),
    "Ctrl+K focus",
  );
  await page
    .getByRole("textbox", { name: "Поиск программ" })
    .fill("Fusion 360");
  check((await page.locator(".product-card").count()) === 1, "Alias search");
  await page.getByRole("textbox", { name: "Поиск программ" }).fill("");
  await page.setViewportSize({ width: 1020, height: 700 });
  await page.getByRole("button", { name: "Ваш выбор · 0 Показать" }).click();
  check(
    await page
      .locator(".selection-pane")
      .getAttribute("class")
      .then((s) => s.includes("cart-open")),
    "Accessible cart disclosure",
  );
  await page.getByRole("button", { name: "Ваш выбор · 0 Свернуть" }).click();
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Minimum width overflow",
  );
  await page.screenshot({ path: "artifacts/minimum-v020.png" });
  await page.evaluate(() => (document.body.style.zoom = "1.25"));
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "125 percent overflow",
  );
  await page.screenshot({ path: "artifacts/zoom125-v020.png" });
  record("Ctrl+K from settings; 1020×700; 125% scale");
  await context.close();
  // Error task corrected and retried, preserving original cancelled/manual records.
  const id = "old-run";
  const now = Date.now() - 5000;
  const tasks = ["chrome", "firefox", "postgres"].map((appId, i) => ({
    id: "old-" + i,
    runId: id,
    appId,
    name: appData.find((a) => a.id === appId).name,
    action: selection(appId).action,
    status: ["error", "cancelled", "action-required"][i],
    message:
      i === 0
        ? "Код WinGet: 0x8A150014. Выберите последнюю доступную версию."
        : "Нужен ручной шаг",
    log: [],
    percent: null,
    selection: {
      ...selection(appId),
      ...(i === 0 ? { version: "0.0.1" } : {}),
    },
    dependencies: [],
    startedAt: now,
    finishedAt: now + 1000,
  }));
  ({ page, context } = await open({
    "demo-queue": {
      schemaVersion: 2,
      currentRunId: id,
      runs: [
        {
          id,
          createdAt: now,
          finishedAt: now + 1000,
          mode: "demo",
          skipCurrent: false,
          parallelDownloads: 3,
          selections: tasks.map((t) => t.selection),
          outcome: "errors",
        },
      ],
      tasks,
      running: false,
      paused: false,
      mode: "demo",
      updatedAt: now,
    },
  }));
  await page.getByRole("button", { name: "История", exact: true }).click();
  await page.locator(".task-row").first().locator("summary").click();
  await page
    .getByRole("button", { name: "Изменить параметры", exact: true })
    .click();
  await page
    .getByLabel("Устанавливаемая версия", { exact: true })
    .selectOption("latest");
  await page
    .getByRole("button", { name: "Сохранить параметры", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Проверим всё перед запуском" })
    .waitFor();
  check(
    (await page.locator(".plan-expanded").count()) === 1,
    "Retry only failed task",
  );
  await page
    .getByRole("button", { name: "Повторить проверку", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Проверим всё перед запуском" })
    .waitFor();
  await run(page);
  await page.waitForFunction(
    () => !JSON.parse(localStorage.getItem("appdock:demo-queue")).data.running,
  );
  const q = await page.evaluate(
    () => JSON.parse(localStorage.getItem("appdock:demo-queue")).data,
  );
  check(q.runs.length === 2 && q.tasks.length === 4, "Separate retry run");
  check(
    q.tasks[1].status === "cancelled" &&
      q.tasks[2].status === "action-required",
    "Retry preserved other statuses",
  );
  check(
    q.runs[1].parallelDownloads === 3 && !q.runs[1].skipCurrent,
    "Original run policy",
  );
  record(
    "edited failed task → new exact retry plan; cancelled/manual untouched",
  );
  await page.getByRole("button", { name: "История", exact: true }).click();
  const manual = page.locator(".task-row").filter({ hasText: "PostgreSQL" });
  await manual.locator("summary").click();
  await page.getByRole("button", { name: "Шаг выполнен", exact: true }).click();
  check(
    await manual
      .textContent()
      .then((s) => s.includes("Шаг отмечен пользователем")),
    "User manual evidence",
  );
  record("manual completion retains user evidence");
  await page.getByRole("button", { name: "Диагностика", exact: true }).click();
  check(
    await page
      .getByRole("textbox", { name: "Текст отчёта" })
      .inputValue()
      .then((s) => s.includes("appVersion")),
    "Diagnostic preview",
  );
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Сохранить локально", exact: true })
    .click();
  await (await downloadPromise).saveAs("artifacts/ui-diagnostic-redacted.json");
  await context.close();
  // Set editor, export/import and replacement undo.
  ({ page, context } = await open());
  await page.getByRole("button", { name: "Наборы", exact: true }).click();
  await page
    .getByRole("button", { name: "Создать набор", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Название набора", exact: true })
    .fill("Сквозной набор");
  await page
    .getByRole("textbox", { name: "Описание набора", exact: true })
    .fill("Проверка редактора");
  await page
    .getByRole("checkbox", { name: "Google Chrome", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Сохранить набор", exact: true })
    .click();
  const card = page
    .locator(".preset-card")
    .filter({ hasText: "Сквозной набор" });
  await card
    .getByRole("button", { name: "Редактировать", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Mozilla Firefox", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Сохранить набор", exact: true })
    .click();
  const exported = page.waitForEvent("download");
  await card
    .getByRole("button", { name: "Экспорт Сквозной набор", exact: true })
    .click();
  await (await exported).saveAs("artifacts/ui-preset.json");
  await page
    .getByLabel("Импорт набора", { exact: true })
    .setInputFiles("artifacts/ui-preset.json");
  await page
    .getByRole("button", {
      name: "Сохранить импортированный набор",
      exact: true,
    })
    .click();
  check(
    (await page
      .locator(".preset-card")
      .filter({ hasText: "Сквозной набор" })
      .count()) === 2,
    "Preset roundtrip",
  );
  await page
    .locator(".preset-card")
    .filter({ hasText: "Сквозной набор" })
    .first()
    .getByRole("button", { name: "Заменить выбор", exact: true })
    .click();
  check(
    (await page.locator(".selection-counter").textContent()) === "2",
    "Replace selection",
  );
  await page
    .getByRole("button", { name: "Отменить последнюю замену", exact: true })
    .click();
  check(
    (await page.locator(".selection-counter").textContent()) === "0",
    "Undo replace",
  );
  record("preset create/edit/export/import/replace/undo");
  await page
    .locator(".preset-card")
    .filter({ hasText: "Сквозной набор" })
    .first()
    .getByRole("button", { name: "Добавить к текущему выбору", exact: true })
    .click();
  await page.getByRole("button", { name: "Профиль ПК", exact: true }).click();
  await page
    .getByRole("button", { name: "Сохранить текущий выбор", exact: true })
    .click();
  check(
    (await page.locator(".workflow-list article").count()) === 2,
    "Profile compare rows",
  );
  await page
    .getByRole("button", { name: "Проверить план профиля (2)", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Проверим всё перед запуском" })
    .waitFor();
  await page
    .getByRole("button", { name: "Вернуться к выбору", exact: true })
    .click();
  record("profile saved → compared missing → reviewed new plan");
  await context.close();
  // Partial downloads keep unsupported selection and options.
  ({ page, context } = await open({
    selection: ["chrome", "postgres", "github"].map(selection),
  }));
  await page.getByRole("button", { name: /^Только скачать/ }).click();
  check(
    (await page.locator(".plan-expanded").count()) === 3,
    "Mixed plan shows exclusions",
  );
  await run(page);
  check(
    (await page.locator(".selection-counter").textContent()) === "2",
    "Unsupported selection retained",
  );
  await page.waitForFunction(
    () => !JSON.parse(localStorage.getItem("appdock:demo-queue")).data.running,
  );
  record(
    "mixed downloads show excluded products and preserve remaining selection",
  );
  await context.close();
  // Restored queue pauses until user resumes; clear preserves unfinished tasks.
  const restored = {
    ...tasks[0],
    id: "restored",
    status: "installing",
    selection: selection("chrome"),
  };
  ({ page, context } = await open({
    "demo-queue": {
      tasks: [restored],
      running: true,
      paused: false,
      mode: "demo",
      updatedAt: now,
    },
  }));
  await page
    .getByRole("button", { name: "Загрузки и установка", exact: true })
    .click();
  check(
    await page
      .getByRole("button", { name: "Продолжить", exact: true })
      .isVisible(),
    "Restored paused queue",
  );
  await page
    .getByRole("button", { name: "Очистить завершённое", exact: true })
    .click();
  await page.getByRole("button", { name: "Очистить", exact: true }).click();
  check(
    (await page.locator(".task-row").count()) === 1,
    "Clear keeps queued task",
  );
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.waitForFunction(
    () => !JSON.parse(localStorage.getItem("appdock:demo-queue")).data.running,
  );
  record(
    "restart → paused recovery → clear keeps unfinished → explicit resume",
  );
  await context.close();
  // Read-only fake discovery adapter for update selection, with no install commands.
  ({ page, context } = await open({}, true));
  await page.getByRole("button", { name: "Обновления", exact: true }).click();
  await page
    .getByRole("button", { name: "Проверить обновления", exact: true })
    .click();
  await page
    .locator(".workflow-list article")
    .filter({ hasText: "Google Chrome" })
    .waitFor();
  await page
    .getByRole("button", { name: "Выбрать доступные", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Проверить план обновлений (1)", exact: true })
    .click();
  check(
    (await page.locator(".plan-expanded").count()) === 1,
    "Separate updates plan",
  );
  record("fake read-only discovery → multi-update selection → separate plan");
  await context.close();
  check(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  fs.writeFileSync(
    "artifacts/ui-smoke-v020.json",
    JSON.stringify({ passed: true, results, browserErrors: errors }, null, 2),
  );
  console.log("PASS: " + results.join("; "));
} finally {
  await browser.close();
}
