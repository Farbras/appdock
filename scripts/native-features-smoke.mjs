import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
const session = JSON.parse(
  fs
    .readFileSync("artifacts/native-features-session.json", "utf8")
    .replace(/^\uFEFF/, ""),
);
const root = path.resolve(session.root);
assert(
  root.startsWith(path.resolve("artifacts") + path.sep),
  "Only isolated test data is allowed",
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9226");
const page = browser.contexts().flatMap((c) => c.pages())[0];
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function call(op, args = {}) {
  return page.evaluate(
    ({ op, args }) =>
      window.__TAURI_INTERNALS__.invoke("feature", { op, args, mode: "live" }),
    { op, args },
  );
}
async function idleCall(op, args = {}) {
  for (let n = 0; n < 150; n++) {
    try {
      return await call(op, args);
    } catch (e) {
      if (!String(e).includes("Другая операция")) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Native operation remained busy");
}
const checks = [];
try {
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Офлайн-набор", exact: true })
    .waitFor();
  const snapshot = await call("catalog-snapshot");
  assert.equal(snapshot.apps.length, 83);
  assert.equal(snapshot.status.configured, false);
  checks.push("native catalog IPC, explicit unconfigured publication");
  const items = [
    {
      appId: "python",
      action: "install",
      options: { pip: true, path: true, scope: "user" },
      extensions: [],
    },
  ];
  assert.equal((await call("offline-support", { items }))[0].supported, true);
  const prior = fs.existsSync("artifacts/native-features-smoke.json")
    ? JSON.parse(
        fs.readFileSync("artifacts/native-features-smoke.json", "utf8"),
      ).bundle
    : null;
  const reuse =
    process.env.APPDOCK_FORCE_OFFLINE_DOWNLOAD !== "1" &&
    prior &&
    path.resolve(prior).startsWith(root + path.sep) &&
    fs.existsSync(path.join(prior, "manifest.json"));
  const report = reuse
    ? await idleCall("offline-inspect", { folder: prior })
    : await idleCall("offline-create", { folder: root, items });
  assert.equal(report.verified, true);
  assert.equal(report.packages[0].version, "3.12.10");
  checks.push(
    reuse
      ? "existing real Python HTTPS installer fixture revalidated against compiled SHA-256"
      : "real Python full installer downloaded over HTTPS and matched compiled SHA-256",
  );
  const installer = path.join(report.folder, report.packages[0].file);
  const original = fs.readFileSync(installer);
  const corrupted = Buffer.from(original);
  corrupted[10] ^= 1;
  fs.writeFileSync(installer, corrupted);
  await assert.rejects(
    call("offline-inspect", { folder: report.folder }),
    /SHA-256/,
  );
  fs.writeFileSync(installer, original);
  assert.equal(
    (await call("offline-inspect", { folder: report.folder })).verified,
    true,
  );
  checks.push("corrupted actual installer rejected; intact bundle revalidated");
  const plan = await call("offline-prepare", { folder: report.folder });
  assert.equal(plan.mode, "live");
  assert(plan.items[0].tasks[0].offlineRoot);
  assert(plan.items[0].expected.includes("3.12.10"));
  assert.equal(
    (
      await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("queue_snapshot"),
      )
    ).tasks.length,
    0,
  );
  checks.push("native offline plan prepared without starting any installer");
  const imported = {
    schemaVersion: 1,
    components: {
      "vscode-settings": {
        "editor.fontSize": 16,
        "secret.token": "must-not-transfer",
      },
      git: { "credential.helper": "!evil", "core.autocrlf": "true" },
    },
    exclusions: [],
  };
  const preview = await call("settings-preview", {
    text: JSON.stringify(imported),
  });
  assert(preview.exclusions.length >= 2);
  assert(!JSON.stringify(preview).includes("must-not-transfer"));
  assert(!JSON.stringify(preview).includes("!evil"));
  checks.push("native secret/command filtering and settings preview");
  await assert.rejects(
    call("settings-preview", {
      text: '{"schemaVersion":999,"components":{},"exclusions":[]}',
    }),
  );
  await page.getByRole("button", { name: "Офлайн-набор", exact: true }).click();
  await page.getByLabel("Путь к офлайн-набору").fill(report.folder);
  await page.getByRole("button", { name: "Открыть и проверить набор" }).click();
  await page
    .getByRole("heading", {
      name: "Комплектность и доверенные SHA-256 подтверждены",
    })
    .waitFor();
  await page
    .getByRole("button", { name: "Просмотреть план локальной установки" })
    .click();
  await page
    .getByRole("dialog", { name: "Проверим всё перед запуском" })
    .getByRole("button", { name: "Повторить проверку" })
    .click();
  const review = page.getByRole("dialog", {
    name: "Проверим всё перед запуском",
  });
  await review.waitFor();
  await review.getByRole("button", { name: "Изменить параметры" }).click();
  const editor = page.getByRole("dialog");
  await editor.getByRole("checkbox", { name: "Установить pip" }).uncheck();
  await editor.getByRole("button", { name: "Сохранить параметры" }).click();
  await review.waitFor();
  await review.getByText(/Локальная версия 3.12.10/).waitFor();
  assert.equal(
    await review
      .locator(".parameter-list > div")
      .filter({ hasText: "Установить pip" })
      .locator("dd")
      .innerText(),
    "Нет",
  );
  checks.push(
    "real native UI import, plan refresh and option edits preserve local installation without downloads",
  );
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "artifacts/native-features.png" });
  const background = await call("background-state");
  try {
    await call("save-background", {
      ...background.preferences,
      notifications: false,
      downloadLimitKib: 1,
    });
    const preparation = call("offline-create", { folder: root, items }).then(
      () => null,
      (error) => String(error),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    await call("offline-cancel");
    assert.match(await preparation, /отменена/);
    checks.push(
      "actual rate-limited bundle preparation cancels during native HTTP transfer",
    );
  } finally {
    await call("save-background", background.preferences);
  }
  const second = spawn(
    path.resolve("src-tauri/target/debug/appdock.exe"),
    ["--background"],
    {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        APPDOCK_TEST_DATA_DIR: path.join(root, "data"),
        WEBVIEW2_USER_DATA_FOLDER: path.join(root, "webview"),
      },
    },
  );
  const exited = await Promise.race([
    new Promise((resolve) => second.once("exit", (code) => resolve(code))),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Second instance did not exit")),
        10000,
      ),
    ),
  ]);
  assert.equal(exited, 0);
  checks.push("second native process exited through single-instance guard");
  assert.equal(errors.length, 0, errors.join("; "));
  fs.writeFileSync(
    "artifacts/native-features-smoke.json",
    JSON.stringify(
      {
        passed: true,
        checks,
        installersExecuted: false,
        bundle: report.folder,
      },
      null,
      2,
    ),
  );
  console.log("PASS: " + checks.join("; "));
} finally {
  await browser.close();
}
