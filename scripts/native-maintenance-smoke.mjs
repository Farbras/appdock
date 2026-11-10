// Read-only Windows checks. Never start_plan or queue resume with a real plan.
import fs from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9231");
const page = browser.contexts().flatMap((c) => c.pages())[0];
const checks = [];
const invoke = (cmd, args = {}) =>
  page.evaluate(
    ({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    { cmd, args },
  );
const feature = (op, args = {}) =>
  invoke("feature", { op, args, mode: "live" });
const retry = async (fn) => {
  for (let n = 0; n < 80; n++) {
    try {
      return await fn();
    } catch (e) {
      if (!String(e).includes("Другая операция")) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("Native operation remained busy");
};
try {
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  await retry(() => invoke("set_runtime_mode", { mode: "live" }));
  const before = await invoke("queue_snapshot");
  assert.equal(before.running, false);
  assert.equal(before.tasks.length, 0);
  const result = await retry(() => feature("installed-instances"));
  assert(Array.isArray(result.instances));
  assert(result.instances.length > 0);
  assert(
    result.instances.every(
      (i) => i.key && i.productCode && ["user", "machine"].includes(i.scope),
    ),
  );
  const candidates = result.instances.filter(
    (i) =>
      i.version &&
      result.instances.filter(
        (r) =>
          r.productCode.toLowerCase() === i.productCode.toLowerCase() &&
          r.scope === i.scope,
      ).length === 1,
  );
  assert(candidates.length > 0);
  if (result.uninstallSupported) {
    const plan = await retry(() =>
      feature("uninstall-prepare", { keys: [candidates[0].key] }),
    );
    assert.equal(
      plan.items[0].tasks[0].operation.instance.key,
      candidates[0].key,
    );
    assert.equal(
      plan.items[0].tasks[0].operation.instance.version,
      candidates[0].version,
    );
    checks.push(
      "real registry instances and exact WinGet uninstall plan; plan was NOT executed",
    );
  } else
    checks.push(
      "real registry instances; missing WinGet exact-filter capability is explicit",
    );
  await assert.rejects(() =>
    retry(() =>
      feature("uninstall-prepare", { keys: ["not-an-installed-key"] }),
    ),
  );
  await assert.rejects(() =>
    retry(() =>
      feature("fix-prepare", { appId: "chrome", fix: "shell", extensions: [] }),
    ),
  );
  const diagnosis = await retry(() =>
    feature("troubleshoot", { appId: "python", extensions: [] }),
  );
  const msi = result.instances.find(
    (i) =>
      i.msi &&
      i.version &&
      result.instances.filter(
        (r) =>
          r.productCode.toLowerCase() === i.productCode.toLowerCase() &&
          r.scope === i.scope,
      ).length === 1,
  );
  if (msi) {
    const report = await retry(() =>
      feature("troubleshoot", {
        appId: "windows-instance",
        instanceKey: msi.key,
        extensions: [],
      }),
    );
    if (report.repairAvailable) {
      const p = await retry(() =>
        feature("fix-prepare", {
          appId: "windows-instance",
          instanceKey: msi.key,
          extensions: [],
          fix: "repair",
        }),
      );
      assert.equal(
        p.items[0].tasks[0].operation.instance.productCode,
        msi.productCode,
      );
      checks.push(
        "exact native MSI repair capability and inert repair plan; never executed",
      );
    }
  }
  assert(
    Array.isArray(diagnosis.checked) &&
      Array.isArray(diagnosis.unknown) &&
      Array.isArray(diagnosis.manual),
  );
  checks.push(
    "real compiled readiness adapters, explicit unknowns, unsupported fixes and foreign instance rejection",
  );
  await assert.rejects(() =>
    retry(() =>
      feature("custom-prepare", {
        ids: ["user:00000000-0000-0000-0000-000000000000"],
      }),
    ),
  );
  const refs = [{ name: "Example", sha256: "a".repeat(64) }];
  assert.deepEqual(
    await retry(() => feature("custom-import-validate", { programs: refs })),
    refs,
  );
  for (const key of ["path", "command", "arguments", "id"]) {
    await assert.rejects(() =>
      retry(() =>
        feature("custom-import-validate", {
          programs: [{ ...refs[0], [key]: "cmd.exe" }],
        }),
      ),
    );
  }
  checks.push(
    "Rust import validation rejects launch paths, commands, arguments and foreign local IDs",
  );
  await page
    .getByRole("button", { name: "Установленные", exact: true })
    .click();
  await page.locator(".workflow-list article").first().waitFor();
  await page
    .locator(".workflow-list article")
    .first()
    .getByRole("button", { name: "Программа не работает", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("heading", { name: "Что проверено", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("dialog").getByRole("alert").count(), 0);
  await page.screenshot({
    path: "artifacts/maintenance-native-diagnosis.png",
    animations: "disabled",
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .last()
    .click();
  checks.push(
    "native installed-instance UI opens a complete diagnostic wizard without colliding IPC calls",
  );
  await retry(() => invoke("set_runtime_mode", { mode: "demo" }));
  await assert.rejects(() => feature("installed-instances"));
  await assert.rejects(() =>
    invoke("queue_control", { action: "resume", taskId: null }),
  );
  assert.equal((await invoke("queue_snapshot")).tasks.length, 0);
  checks.push(
    "Rust demo guard blocks native operations and resume; real queue remains empty",
  );
  fs.writeFileSync(
    "artifacts/native-maintenance-smoke.json",
    JSON.stringify(
      {
        passed: true,
        instanceCount: result.instances.length,
        checks,
        scope:
          "Read-only system queries and inert plan creation in isolated AppDock data; no real plan executed",
      },
      null,
      2,
    ),
  );
  console.log("PASS: " + checks.join("; "));
} finally {
  await browser.close();
}
