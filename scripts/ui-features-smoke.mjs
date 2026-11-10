import fs from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1020, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const checks = [];
try {
  await page.addInitScript(() => {
    localStorage.setItem(
      "appdock:settings",
      JSON.stringify({
        theme: "dark",
        mode: "demo",
        view: "grid",
        skipCurrent: true,
        parallelDownloads: 2,
      }),
    );
    localStorage.setItem("appdock:selection", JSON.stringify([]));
  });
  await page.goto("http://127.0.0.1:1420");
  await page.getByRole("button", { name: "Офлайн-набор", exact: true }).click();
  await page
    .getByRole("heading", { name: "Поддерживаемые пакеты (3)", exact: true })
    .waitFor();
  const prepare = page.getByRole("button", {
    name: "Подготовить офлайн-набор",
  });
  const packages = page.getByRole("checkbox", {
    name: /^Добавить .* в офлайн-набор$/,
  });
  assert.equal(await packages.count(), 3);
  assert.equal(await prepare.isDisabled(), true);
  await page
    .getByRole("button", { name: "Выбрать все поддерживаемые" })
    .click();
  assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 3);
  await page.getByRole("button", { name: "Снять выбор пакетов" }).click();
  assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 0);
  const search = page.getByRole("textbox", {
    name: "Поиск программ для офлайн-набора",
  });
  await search.fill("git");
  assert.equal(await packages.count(), 1);
  await packages.check();
  await search.fill("Chrome");
  assert.equal(await packages.count(), 0);
  await page
    .getByText(
      "ДЕМО: для этой программы нет подтверждённого полного автономного установщика и его зависимостей.",
      { exact: true },
    )
    .waitFor();
  await search.fill("нет-такой-программы");
  await page
    .getByText("Недоступных программ по запросу нет.", { exact: true })
    .waitFor();
  await search.fill("");
  assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 1);
  assert.equal(await prepare.isDisabled(), true);
  assert.deepEqual(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("appdock:selection")).data,
    ),
    [],
  );
  for (const theme of ["dark", "light"]) {
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
      path: `artifacts/offline-${theme}-1020.png`,
      fullPage: true,
    });
  }
  checks.push(
    "offline picker works with empty catalog selection; bulk selection, search, unsupported reasons and theme layouts",
  );
  await page.getByRole("button", { name: "Выбрать папку набора" }).click();
  assert.equal(await prepare.isDisabled(), false);
  await prepare.click();
  await page
    .getByRole("heading", {
      name: "Демонстрационный результат — реальные файлы не проверялись",
    })
    .waitFor();
  await page
    .getByRole("listitem")
    .filter({ hasText: "Git · 2.49.0 · x64" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Просмотреть план локальной установки" })
      .isDisabled(),
    true,
  );
  checks.push("demo bundle remains explicitly unverified and cannot install");
  await page.getByRole("button", { name: "Профиль ПК", exact: true }).click();
  await page.getByRole("button", { name: "Показать пример конфликта" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByText("Предпросмотр переноса настроек", { exact: true })
    .waitFor();
  const apply = dialog.getByRole("button", {
    name: "Создать копию и применить выбранное",
  });
  assert.equal(await apply.isDisabled(), true);
  await dialog.getByRole("checkbox").first().check();
  await apply.click();
  await page
    .getByText(
      "ДЕМО: изменения и резервная копия виртуальные; компьютер не изменён",
      { exact: true },
    )
    .waitFor();
  await page.getByText("Резервные копии (1)", { exact: true }).click();
  await page
    .getByRole("button", { name: "Восстановить копию", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Восстановить исходные файлы" })
    .click();
  checks.push(
    "conflict defaults to skip; explicit component selection; virtual backup and restoration",
  );
  await page.getByLabel("Импорт настроек программ").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"schemaVersion":99,"components":{}}'),
  });
  await page
    .getByText("Error: Неподдерживаемый формат переноса", { exact: true })
    .waitFor();
  checks.push("invalid transfer format is visible to the user");
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByLabel("Расписание проверки обновлений").selectOption("24");
  await page.getByLabel("Лимит прямых загрузок").fill("123");
  await page.getByLabel("Запускать при входе в Windows").check();
  await page.getByRole("button", { name: "Сохранить настройки фона" }).click();
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem("appdock:demo-background")).data,
  );
  assert.equal(saved.intervalHours, 24);
  assert.equal(saved.downloadLimitKib, 123);
  assert.equal(saved.autostart, true);
  assert.equal(
    await page
      .getByRole("button", { name: "Проверить обновление каталога" })
      .isDisabled(),
    true,
  );
  checks.push(
    "background preferences persist virtually; missing production catalog is explicit",
  );
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert.equal(overflow, false, theme + " horizontal overflow");
    await page.screenshot({ path: `artifacts/features-${theme}-1020.png` });
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    "artifacts/ui-features-smoke.json",
    JSON.stringify(
      {
        passed: true,
        checks,
        scope: "Browser demo UI; native integrations verified separately",
      },
      null,
      2,
    ),
  );
  console.log("PASS: " + checks.join("; "));
} finally {
  await browser.close();
}
