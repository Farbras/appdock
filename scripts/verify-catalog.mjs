import fs from "node:fs";
import assert from "node:assert/strict";
const apps = JSON.parse(fs.readFileSync("catalog/apps.json"));
const report = JSON.parse(fs.readFileSync("docs/integration-checks.json"));
assert.equal(apps.length, 80);
assert.equal(new Set(apps.map((a) => a.id)).size, 80);
for (const a of apps) {
  for (const key of [
    "id",
    "name",
    "publisher",
    "website",
    "category",
    "type",
    "platforms",
    "architectures",
    "editions",
    "version",
    "install",
    "detection",
    "options",
    "dependencies",
    "sources",
    "checkedAt",
  ])
    assert.ok(Object.hasOwn(a, key), `${a.id}: ${key}`);
  for (const url of a.sources) assert.equal(new URL(url).protocol, "https:");
  if (a.install.verification === "verified") {
    assert.ok(report.winget[a.install.packageId]?.ok);
    assert.equal(a.install.source, "winget");
  }
  for (const e of a.editions.filter((e) => e.packageId))
    assert.ok(report.winget[e.packageId]?.ok);
}
const ext = JSON.parse(fs.readFileSync("catalog/extensions.json"));
assert.equal(ext.length, 8);
for (const e of ext) assert.ok(report.extensions[e.id]?.ok);
console.log(
  `Catalog valid: ${apps.length} products, ${apps.filter((a) => a.install.verification === "verified").length} verified WinGet integrations, ${ext.length} verified extensions.`,
);
