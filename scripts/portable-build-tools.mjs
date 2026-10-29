// Optional development-only extraction of official compiler/SDK archives into .tools.
// Does not install products, change the registry, or request elevation.
import fs from "node:fs";
import crypto from "node:crypto";
const catalog = JSON.parse(fs.readFileSync(".tools/vs-catalog.json", "utf8"));
fs.mkdirSync(".tools/build-archives", { recursive: true });
const ids = [
  "Microsoft.VC.14.51.Tools.HostX64.TargetX64.base",
  "Microsoft.VC.14.51.Tools.HostX64.TargetX64.Res.base",
  "Microsoft.VC.14.51.CRT.Headers.base",
  "Microsoft.VC.14.51.CRT.x64.Desktop.base",
  "Microsoft.VC.14.51.CRT.x64.OneCore.Desktop.base",
];
for (const id of ids) {
  const p = catalog.packages.find(
    (p) => p.id === id && (!p.language || p.language === "en-US"),
  )?.payloads?.[0];
  if (!p) throw new Error(`Compiler archive missing: ${id}`);
  const path = `.tools/build-archives/${p.fileName}`;
  const b = fs.existsSync(path)
    ? fs.readFileSync(path)
    : Buffer.from(await (await fetch(p.url)).arrayBuffer());
  if (crypto.createHash("sha256").update(b).digest("hex") !== p.sha256)
    throw new Error(`Compiler SHA-256 mismatch: ${id}`);
  fs.writeFileSync(path, b);
  console.log(`Verified ${id}: ${Math.round(b.length / 1024 / 1024)} MB`);
}
for (const id of [
  "microsoft.windows.sdk.cpp",
  "microsoft.windows.sdk.cpp.x64",
]) {
  const versions = await (
    await fetch(`https://api.nuget.org/v3-flatcontainer/${id}/index.json`)
  ).json();
  const version = versions.versions
    .filter((v) => v.startsWith("10.0.26100.") && !v.includes("-"))
    .at(-1);
  if (!version) throw new Error("Stable 26100 SDK not found");
  const base = `https://api.nuget.org/v3-flatcontainer/${id}/${version}/${id}.${version}.nupkg`;
  const path = `.tools/build-archives/${id}.zip`;
  const b = fs.existsSync(path)
    ? fs.readFileSync(path)
    : Buffer.from(await (await fetch(base)).arrayBuffer());
  const registration = await (
    await fetch(
      `https://api.nuget.org/v3/registration5-gz-semver2/${id}/${version}.json`,
    )
  ).json();
  const metadata = await (await fetch(registration.catalogEntry)).json();
  if (
    metadata.packageHashAlgorithm !== "SHA512" ||
    crypto.createHash("sha512").update(b).digest("base64") !==
      metadata.packageHash
  )
    throw new Error(`SDK SHA-512 mismatch: ${id}`);
  fs.writeFileSync(path, b);
  console.log(
    `Verified ${id} ${version}: ${Math.round(b.length / 1024 / 1024)} MB`,
  );
}
