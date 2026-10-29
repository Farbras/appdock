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
  checkedAt: new Date().toISOString(),
  winget: {},
  extensions: {},
};
async function run(id) {
  return await new Promise((resolve) => {
    let out = "";
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
    const t = setTimeout(() => p.kill(), 60000);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (out += d.toString()));
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ ok: false, error: e.message });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({
        ok: code === 0,
        exitCode: code,
        output: out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim(),
      });
    });
  });
}
let next = 0;
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      report.winget[id] = await run(id);
      console.log(`${report.winget[id].ok ? "OK" : "NO"} ${id}`);
    }
  }),
);
for (const a of apps) {
  if (a.install.packageId) {
    const r = report.winget[a.install.packageId];
    a.install.verification = r?.ok ? "verified" : "unverified";
    a.install.verifiedAt = r?.ok ? report.checkedAt : null;
    a.install.download = !!(
      r?.ok && /Offline Distribution Supported: true/i.test(r.output)
    );
    if (r?.ok) {
      a.version =
        a.id === "python"
          ? "3.12.10"
          : r.output.match(/Version:\s*(.+)/)?.[1]?.trim() || a.version;
      a.sources.push(
        `https://github.com/microsoft/winget-pkgs/tree/master/manifests/${a.install.packageId[0].toLowerCase()}/${a.install.packageId.replaceAll(".", "/")}`,
      );
    }
    for (const e of a.editions) {
      if (e.packageId) e.verified = !!report.winget[e.packageId]?.ok;
    }
  }
}
await Promise.all(
  extensions.map(async (e) => {
    try {
      const r = await fetch(e.source);
      const body = await r.text();
      const valid =
        r.ok &&
        body.toLowerCase().includes(e.id.toLowerCase()) &&
        !body.includes("VS402395");
      report.extensions[e.id] = { ok: valid, url: e.source };
      e.verifiedAt = valid ? report.checkedAt : null;
      console.log(`${valid ? "OK" : "NO"} ${e.id}`);
    } catch (err) {
      report.extensions[e.id] = { ok: false, error: String(err) };
    }
  }),
);
fs.writeFileSync("catalog/apps.json", JSON.stringify(apps, null, 2) + "\n");
fs.writeFileSync(
  "catalog/extensions.json",
  JSON.stringify(extensions, null, 2) + "\n",
);
fs.writeFileSync(
  "docs/integration-checks.json",
  JSON.stringify(report, null, 2) + "\n",
);
