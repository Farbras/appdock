import fs from "node:fs";
import { chromium } from "playwright";
const label = process.argv[2] || "after";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = { label, starts: [], catalog: [], history: [] };
const products = JSON.parse(fs.readFileSync("catalog/apps.json", "utf8"));
const selection = {
  appId: "chrome",
  action: "install",
  options: Object.fromEntries(
    products
      .find((a) => a.id === "chrome")
      .options.map((o) => [o.id, o.default]),
  ),
  extensions: [],
};
try {
  for (let i = 0; i < 5; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/src/api.ts*", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()) + "\nwindow.auditAPI=api;",
      });
    });
    await page.addInitScript(() => {
      window.samples = [];
      addEventListener("appdock-profile", (e) => window.samples.push(e.detail));
    });
    const start = performance.now();
    await page.goto("http://127.0.0.1:1420/?profile");
    await page.getByRole("textbox", { name: "Поиск программ" }).waitFor();
    await page.locator(".product-card").first().waitFor();
    results.starts.push(performance.now() - start);
    await page.evaluate(() => (window.samples = []));
    for (let k = 0; k < 10; k++) {
      await page.evaluate(async () => {
        await window.auditAPI.control("cancel", "demo");
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    results.catalog.push(await page.evaluate(() => window.samples));
    await context.close();
  }
  const runs = Array.from({ length: 500 }, (_, i) => ({
    id: `run-${i}`,
    createdAt: 1700000000000 + i,
    finishedAt: 1700000001000 + i,
    mode: "demo",
    skipCurrent: true,
    parallelDownloads: 2,
    selections: [selection],
    outcome: "completed",
  }));
  const tasks = runs.flatMap((r) =>
    Array.from({ length: 10 }, (_, i) => ({
      id: `${r.id}-${i}`,
      runId: r.id,
      appId: "chrome",
      name: "Google Chrome",
      action: "install",
      status: "installed",
      message: "Тестовая задача",
      log: Array.from({ length: 5 }, () => "[ТЕСТ] Запись журнала выполнения"),
      percent: null,
      selection,
      dependencies: [],
    })),
  );
  const queue = {
    schemaVersion: 2,
    runs,
    tasks,
    currentRunId: runs.at(-1).id,
    running: false,
    paused: false,
    mode: "demo",
    updatedAt: 1700000010000,
  };
  results.historyBytes = Buffer.byteLength(JSON.stringify(queue));
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((q) => {
    localStorage.setItem("appdock:demo-queue", JSON.stringify(q));
    window.samples = [];
    addEventListener("appdock-profile", (e) => window.samples.push(e.detail));
  }, queue);
  await page.goto("http://127.0.0.1:1420/?profile");
  await page.getByRole("textbox", { name: "Поиск программ" }).waitFor();
  const start = performance.now();
  await page.getByRole("button", { name: "История", exact: true }).click();
  await page.locator(".run-section").first().waitFor();
  results.historyOpenMs = performance.now() - start;
  results.historyRenderedRows = await page.locator(".task-row").count();
  results.history = await page.evaluate(() => window.samples);
  const searchStart = performance.now();
  await page
    .getByRole("textbox", { name: "Поиск по истории" })
    .fill("Нет совпадения");
  await page.locator(".run-section").waitFor({ state: "detached" });
  results.historySearchMs = performance.now() - searchStart;
  results.snapshotCosts = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("appdock:demo-queue"));
    const q = stored.data || stored;
    return Array.from({ length: 10 }, () => {
      let start = performance.now();
      const encoded = JSON.stringify(q);
      const encodeMs = performance.now() - start;
      start = performance.now();
      JSON.parse(encoded);
      const decodeMs = performance.now() - start;
      start = performance.now();
      structuredClone(q);
      const cloneMs = performance.now() - start;
      return { encodeMs, decodeMs, cloneMs };
    });
  });
} finally {
  fs.mkdirSync("artifacts/fix-2026-11-02", { recursive: true });
  fs.writeFileSync(
    `artifacts/fix-2026-11-02/metrics-${label}.json`,
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify(
      results,
      (key, value) =>
        ["catalog", "history"].includes(key) ? undefined : value,
      2,
    ),
  );
  await browser.close();
}
