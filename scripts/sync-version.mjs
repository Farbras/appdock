import fs from "node:fs";
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const p = "src-tauri/tauri.conf.json";
const config = JSON.parse(fs.readFileSync(p, "utf8"));
config.version = version;
fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n");
for (const file of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
  let text = fs.readFileSync(file, "utf8");
  text = file.endsWith(".toml")
    ? text.replace(/^(version = ")[^"]+/m, "$1" + version)
    : text.replace(/(name = "appdock"\r?\nversion = ")[^"]+/, "$1" + version);
  fs.writeFileSync(file, text);
}
console.log(`AppDock ${version}: metadata synchronized from package.json`);
