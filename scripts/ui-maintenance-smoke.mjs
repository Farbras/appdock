import fs from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const checks = [];
const nav = async (name) =>
  page.getByRole("button", { name, exact: true }).click();
const launch = async () => {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Запустить демо", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Результаты запусков", exact: true })
    .waitFor();
};
try {
  await page.goto("http://127.0.0.1:1420");
  await nav("Установленные");
  await page
    .getByRole("checkbox", { name: /Выбрать для удаления Python/ })
    .check();
  await page
    .getByRole("checkbox", { name: /Выбрать для удаления Git/ })
    .check();
  await page.getByRole("button", { name: "Удалить выбранные (2)" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByText("Код продукта: {DEMO-PYTHON}", { exact: false })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Запустить демо", exact: true })
      .isDisabled(),
    true,
  );
  await page.screenshot({
    path: "artifacts/maintenance-uninstall-plan.png",
    animations: "disabled",
  });
  await launch();
  assert.equal(
    await page
      .locator(".task-status")
      .filter({ hasText: "Удаление подтверждено" })
      .count(),
    2,
  );
  await nav("Установленные");
  await page
    .getByRole("checkbox", { name: /Выбрать для удаления/ })
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: /Выбрать для удаления/ }).count(),
    2,
  );
  checks.push(
    "two exact uninstall instances, in-app plan confirmation, sequential queue and refreshed absence",
  );
  // Restore virtual examples for wizard testing only.
  await page.evaluate(() => localStorage.removeItem("appdock:demo-instances"));
  await nav("Мои программы");
  await nav("Установленные");
  const python = page
    .locator(".workflow-list article")
    .filter({ hasText: "Python 3.12.10" });
  await python
    .getByRole("button", { name: "Программа не работает", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Что проверено", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "План исправления PATH", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByText(
      "ДЕМО: исходное значение сохраняется, остальные записи сохраняются.",
      { exact: true },
    )
    .waitFor();
  await launch();
  await page.locator(".task-status.repaired").waitFor();
  checks.push(
    "diagnosis, bounded PATH plan, queue, repeated diagnosis and virtual backup",
  );
  await nav("Установленные");
  await page
    .locator(".workflow-list article")
    .filter({ hasText: "Microsoft Visual Studio Code" })
    .getByRole("button", { name: "Программа не работает", exact: true })
    .click();
  await page.getByRole("dialog").getByLabel("Pylance", { exact: true }).check();
  await page
    .getByRole("button", {
      name: "План восстановления расширений",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("heading", { name: "1 программа · 3 задачи", exact: true })
    .waitFor();
  await launch();
  assert.equal(await page.locator(".task-status.installed").count(), 2);
  await page.locator(".task-status.repaired").waitFor();
  checks.push(
    "selected VS Code extensions expand into ordinary individual queue tasks and a final readiness check",
  );
  await nav("Мои программы");
  await page
    .getByRole("button", { name: "Добавить пример установщика" })
    .click();
  await page.getByLabel("Название моей программы").fill("Мой редактор");
  await page.getByLabel("Личный набор").selectOption("new");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Выбрать установщик Мой редактор" })
    .check();
  await page
    .getByRole("button", { name: "План установки выбранных (1)" })
    .click();
  await page
    .getByRole("dialog")
    .getByText("Подпись отсутствует. Хеш не подтверждает доверие издателю.", {
      exact: true,
    })
    .waitFor();
  await launch();
  await page
    .getByText(
      "ДЕМО: процесс завершён; установка и готовность неизвестной программы не подтверждены.",
      { exact: true },
    )
    .waitFor();
  await nav("Наборы");
  await page
    .getByRole("button", {
      name: "Выбрать локальный файл для Мой редактор",
      exact: true,
    })
    .waitFor();
  checks.push(
    "custom metadata, publisher limits, personal preset and unconfirmed installer result",
  );
  await page.getByLabel("Импорт набора").setInputFiles({
    name: "malicious.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        name: "Injected",
        items: [],
        customPrograms: [
          { name: "X", sha256: "a".repeat(64), command: "cmd.exe" },
        ],
      }),
    ),
  });
  await page
    .getByText(/Собственные программы: разрешены только название и SHA-256/)
    .waitFor();
  checks.push("foreign JSON cannot add commands or executable paths");
  await nav("Мои программы");
  for (const [width, theme] of [
    [1280, "dark"],
    [1020, "light"],
    [760, "dark"],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: `artifacts/maintenance-${theme}-${width}.png`,
    });
  }
  await page
    .getByRole("button", { name: "Удалить запись", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Удалить запись и копию", exact: true })
    .click();
  await page
    .getByText(/Выберите локальный установщик. Повторное добавление/)
    .waitFor();
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    "artifacts/ui-maintenance-smoke.json",
    JSON.stringify(
      {
        passed: true,
        checks,
        scope:
          "Browser demo only; no installed application or system PATH changed",
      },
      null,
      2,
    ),
  );
  console.log("PASS: " + checks.join("; "));
} finally {
  await browser.close();
}
