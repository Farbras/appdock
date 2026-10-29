import fs from "node:fs";
import { spawn } from "node:child_process";
const apps = JSON.parse(fs.readFileSync("catalog/apps.json", "utf8"));
const extensions = JSON.parse(
  fs.readFileSync("catalog/extensions.json", "utf8"),
);
const ids = [
  ...new Set(
    apps
      .flatMap((a) => [
        a.install.packageId,
        ...a.editions.map((e) => e.packageId),
      ])
      .filter(Boolean),
  ),
];
const report = {
  schemaVersion: 2,
  checkedAt: new Date().toISOString(),
  meaning:
    "Проверка доступности ID и официальных источников. Скачивание, проверка хеша файла и испытание установки этим запуском не выполнялись.",
  winget: {},
  extensions: {},
};
function check(id) {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const p = spawn(
      "winget",
      [
        "show",
        "--id",
        id,
        "--exact",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--disable-interactivity",
      ],
      { windowsHide: true },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, 30000);
    p.stdout.on("data", (d) => (output += d));
    p.stderr.on("data", (d) => (output += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code,
        timedOut,
        output: output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim(),
      });
    });
  });
}
let next = 0;
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      report.winget[id] = await check(id);
    }
  }),
);
await Promise.all(
  extensions.map(async (e) => {
    try {
      const r = await fetch(e.source, { signal: AbortSignal.timeout(15000) });
      const body = await r.text();
      report.extensions[e.id] = {
        ok:
          r.ok &&
          body.toLowerCase().includes(e.id.toLowerCase()) &&
          !body.includes("VS402395"),
        status: r.status,
        url: e.source,
      };
    } catch (err) {
      report.extensions[e.id] = {
        ok: false,
        url: e.source,
        error: String(err),
      };
    }
  }),
);
fs.mkdirSync("artifacts", { recursive: true });
const stamp = report.checkedAt.slice(0, 10);
fs.writeFileSync(
  `artifacts/SOURCES-${stamp}.json`,
  JSON.stringify(report, null, 2) + "\n",
);
const entries = [
  ...Object.entries(report.winget),
  ...Object.entries(report.extensions),
];
const failed = entries.filter(([, v]) => !v.ok);
fs.writeFileSync(
  `artifacts/SOURCES-${stamp}.md`,
  `${report.meaning}\n\nДата: ${report.checkedAt}\nУспешно: ${entries.length - failed.length}/${entries.length}\n\n${entries.map(([id, v]) => `- ${v.ok ? "OK" : "ОШИБКА"}: ${id}${v.error ? " — " + v.error : ""}`).join("\n")}\n`,
);
console.log(
  `Source freshness report: ${entries.length - failed.length}/${entries.length}; artifacts/SOURCES-${stamp}.md`,
);
if (failed.length) process.exitCode = 1;
