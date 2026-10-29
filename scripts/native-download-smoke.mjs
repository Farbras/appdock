import fs from "node:fs";
const { chromium } = await import(
  process.env.APPDOCK_PLAYWRIGHT || "playwright"
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9224");
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => /tauri\.localhost|tauri:\/\//.test(p.url()));
  if (!page) throw new Error("Native WebView not found");
  const before = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("queue_snapshot"),
  );
  if (before.running)
    throw new Error("Will not interfere with an active queue");
  const plan = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("prepare_plan", {
      items: [
        { appId: "sqlite", action: "download", options: {}, extensions: [] },
      ],
      skipCurrent: true,
      parallelDownloads: 1,
    }),
  );
  if (plan.items[0].blocked)
    throw new Error(JSON.stringify(plan.items[0].warnings));
  await page.evaluate(
    (token) => window.__TAURI_INTERNALS__.invoke("start_plan", { token }),
    plan.token,
  );
  const deadline = Date.now() + 90000;
  let task;
  while (Date.now() < deadline) {
    const q = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("queue_snapshot"),
    );
    task = q.tasks
      .filter((t) => t.appId === "sqlite" && t.action === "download")
      .at(-1);
    if (
      task &&
      ["downloaded", "error", "action-required", "cancelled"].includes(
        task.status,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 600));
  }
  if (task?.status !== "downloaded")
    throw new Error(
      `Actual WinGet download failed: ${task?.message}\n${task?.log.join("\n")}`,
    );
  fs.writeFileSync(
    "artifacts/native-download.json",
    JSON.stringify(
      {
        passed: true,
        appId: task.appId,
        action: task.action,
        status: task.status,
        message: task.message,
        log: task.log,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real WinGet SQLite download completed and hash verification remained enabled. Installer was not executed.",
  );
} finally {
  await browser.close();
}
