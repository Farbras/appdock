//! Immutable offline recipes. Imported hashes and arguments never establish trust.
use crate::{catalog, managed, models::*, system};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
pub static PREPARING: AtomicBool = AtomicBool::new(false);
pub static ABORT: AtomicBool = AtomicBool::new(false);
pub struct Preparation;
impl Preparation {
    pub fn begin() -> Self {
        ABORT.store(false, Ordering::Relaxed);
        PREPARING.store(true, Ordering::Relaxed);
        Self
    }
}
impl Drop for Preparation {
    fn drop(&mut self) {
        PREPARING.store(false, Ordering::Relaxed);
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Package {
    pub app_id: String,
    pub version: String,
    pub architecture: String,
    pub file: String,
    pub sha256: String,
    pub selection: Selection,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    schema_version: u32,
    packages: Vec<Package>,
    created_at: u64,
}
struct Recipe {
    id: &'static str,
    version: &'static str,
    file: &'static str,
    url: &'static str,
    hash: &'static str,
}
const RECIPES: &[Recipe] = &[
    Recipe{id:"python",version:"3.12.10",file:"python-3.12.10-amd64.exe",url:"https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe",hash:"67b5635e80ea51072b87941312d00ec8927c4db9ba18938f7ad2d27b328b95fb"},
    Recipe{id:"git",version:"2.49.0",file:"Git-2.49.0-64-bit.exe",url:"https://github.com/git-for-windows/git/releases/download/v2.49.0.windows.1/Git-2.49.0-64-bit.exe",hash:"726056328967f242fe6e9afbfe7823903a928aff577dcf6f517f2fb6da6ce83c"},
    Recipe{id:"vscode",version:"1.99.3",file:"VSCodeUserSetup-x64-1.99.3.exe",url:"https://vscode.download.prss.microsoft.com/dbazure/download/stable/17baf841131aa23349f217ca7c570c76ee87b957/VSCodeUserSetup-x64-1.99.3.exe",hash:"8811efc173b919e3c7fdda431382d7d50ca2fc145eadae870ec97b172ea9b47c"},
];
fn recipe(s: &Selection) -> Result<&'static Recipe, String> {
    let a = catalog::validate(s)?;
    if s.action != "install" || !s.extensions.is_empty() {
        return Err("Автономно поддерживается установка основного пакета; расширения Marketplace требуют отдельной загрузки и не входят в набор".into());
    }
    let r=RECIPES.iter().find(|r|r.id==s.app_id).ok_or("Полный автономный установщик и его зависимости для этого продукта не подтверждены. Веб-установщики / образы Office в полностью автономный набор не входят.")?;
    if s.version.as_deref().is_some_and(|v| v != r.version) {
        return Err("Закреплённая версия не совпадает с проверенным автономным снимком".into());
    }
    if a["dependencies"].as_array().is_some_and(|d| !d.is_empty()) {
        return Err("Зависимости автономного пакета не подтверждены".into());
    }
    Ok(r)
}
fn existing_transition(r: &Recipe, version: &str) -> Result<(), String> {
    if r.id == "git" {
        system::check_pinned_transition(
            &version.replace(".windows.", "."),
            &format!("{}.1", r.version),
        )
    } else {
        system::check_pinned_transition(version, r.version)
    }
}
pub fn support(items: &[Selection]) -> Value {
    json!(items.iter().map(|s| match recipe(s) {
        Ok(r)=>json!({"appId":s.app_id,"supported":true,"version":r.version,"reason":"Полный EXE x64, внешние зависимости не требуются для базовой установки. Версия снимка может быть старше онлайн-каталога; проверьте её перед использованием."}),
        Err(e)=>json!({"appId":s.app_id,"supported":false,"reason":e}),
    }).collect::<Vec<_>>())
}
pub fn create(
    root: &Path,
    items: &[Selection],
    progress: impl Fn(Value),
    limit: impl Fn() -> u64,
) -> Result<Value, String> {
    if !root.is_absolute() || !root.is_dir() || items.is_empty() || items.len() > 100 {
        return Err("Выберите папку и от 1 до 100 программ".into());
    }
    let mut packages = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for s in items {
        let r = recipe(s)?;
        if !seen.insert(r.id) {
            return Err("Повтор программы".into());
        }
        packages.push((s, r));
    }
    let dir = root.join(format!("AppDock-offline-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    // The manifest is published last: an interrupted directory is never a valid bundle.
    let mut manifest = Bundle {
        schema_version: 1,
        packages: vec![],
        created_at: now(),
    };
    for (index, (s, r)) in packages.iter().enumerate() {
        let path = dir.join(r.file);
        let part = path.with_extension("part");
        crate::resumable::fetch(r.url,&part,||if ABORT.load(Ordering::Relaxed){crate::transfer_control::Request::Cancel}else{crate::transfer_control::Request::Run},||crate::background::CLOSING.load(Ordering::Relaxed),&limit,|p|progress(json!({"stage":"download","appId":s.app_id,"bytes":p.downloaded_bytes,"index":index,"count":packages.len()}))).map_err(|e|if e==crate::transfer_control::CANCELLED{"Подготовка набора отменена. Незавершённая папка без manifest.json не является готовым набором.".into()}else{e})?;
        if managed::hash(&part)? != r.hash {
            return Err(
                "Хеш установщика не совпал с доверенным снимком AppDock. Набор не опубликован."
                    .into(),
            );
        }
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
        manifest.packages.push(Package {
            app_id: s.app_id.clone(),
            version: r.version.into(),
            architecture: "x64".into(),
            file: r.file.into(),
            sha256: r.hash.into(),
            selection: (*s).clone(),
        });
    }
    let checksums = manifest
        .packages
        .iter()
        .map(|p| format!("{}  {}\n", p.sha256, p.file))
        .collect::<String>();
    managed::atomic(&dir.join("SHA256SUMS.txt"), checksums.as_bytes())?;
    managed::atomic(&dir.join("README.txt"),"Откройте папку через AppDock → Офлайн-набор → Открыть и проверить набор. Проверьте версии и план. Нужны Windows x64 и права установщика. Базовые полные EXE не требуют внешних зависимостей. Расширения, синхронизация, обновления и онлайн-функции приложений не входят. Снимок версий ограничен; обновите рецепты AppDock для новых версий. Импортированные суммы не являются источником доверия: AppDock сверяет встроенные SHA-256. Установки запускаются только после подтверждения. Лицензии поставщиков сохраняют силу. Папки без manifest.json — незавершённые; их можно удалить вручную.\n".as_bytes())?;
    managed::json(&dir.join("manifest.json"), &manifest)?;
    inspect(&dir)
}
fn read(root: &Path) -> Result<Bundle, String> {
    let raw = managed::read(&managed::child(root, "manifest.json")?, 200_000)?;
    let bundle: Bundle =
        serde_json::from_slice(&raw).map_err(|e| format!("Повреждённый манифест: {e}"))?;
    if bundle.schema_version != 1 || bundle.packages.is_empty() || bundle.packages.len() > 100 {
        return Err("Неподдерживаемая схема или пустой набор".into());
    }
    let mut ids = std::collections::HashSet::new();
    for p in &bundle.packages {
        let r = recipe(&p.selection)?;
        if !ids.insert(&p.app_id)
            || p.app_id != r.id
            || p.version != r.version
            || p.architecture != "x64"
            || p.file != r.file
            || p.sha256 != r.hash
        {
            return Err("Набор не соответствует доверенным рецептам AppDock".into());
        }
        if managed::hash(&managed::child(root, &p.file)?)? != r.hash {
            return Err(format!("Повреждён файл {}: SHA-256 не совпал", p.file));
        }
    }
    Ok(bundle)
}
pub fn inspect(root: &Path) -> Result<Value, String> {
    let b = read(root)?;
    Ok(
        json!({"folder":root,"packages":b.packages,"verified":true,"requirements":"Windows x64; базовые полные установщики. Драйверы, расширения и сетевые службы не включены.","compatible":cfg!(all(windows,target_arch="x86_64"))}),
    )
}
pub fn selections(root: &Path) -> Result<Vec<Selection>, String> {
    Ok(read(root)?
        .packages
        .into_iter()
        .map(|p| p.selection)
        .collect())
}
pub fn plan(
    shared: &crate::engine::Shared,
    root: &Path,
    only: Option<Vec<String>>,
    edits: Vec<Selection>,
) -> Result<Plan, String> {
    let _guard = managed::exclusive()?;
    plan_inner(shared, root, only, edits)
}
pub fn plan_inner(
    shared: &crate::engine::Shared,
    root: &Path,
    only: Option<Vec<String>>,
    edits: Vec<Selection>,
) -> Result<Plan, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if inspect(&root)?["compatible"] != true {
        return Err("Требуется Windows x64".into());
    }
    let mut items: Vec<_> = selections(&root)?
        .into_iter()
        .filter(|s| only.as_ref().is_none_or(|ids| ids.contains(&s.app_id)))
        .collect();
    if items.is_empty() {
        return Err("В наборе нет выбранных программ".into());
    }
    for edit in edits {
        recipe(&edit)?;
        let item = items
            .iter_mut()
            .find(|s| s.app_id == edit.app_id)
            .ok_or("Изменённая программа отсутствует в выбранном локальном наборе")?;
        *item = edit;
    }
    {
        let e = crate::engine::lock(shared);
        if e.worker_active || e.queue.tasks.iter().any(|t| !terminal(&t.status)) {
            return Err("Завершите или отмените сохранённую очередь".into());
        }
    }
    let mut tasks = crate::engine::build_tasks(&items)?;
    for t in &mut tasks {
        t.offline_root = Some(root.to_string_lossy().into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    let info = requirements();
    let mut rows = vec![];
    let bundle = read(&root)?;
    for s in &items {
        let p = bundle
            .packages
            .iter()
            .find(|p| p.app_id == s.app_id)
            .ok_or("Нет пакета")?;
        rows.push(PlanItem{selection:s.clone(),tasks:tasks.iter().filter(|t|t.app_id==s.app_id).cloned().collect(),excluded:false,expected:format!("Локальная версия {}, {}. Установка проверенного EXE без скачивания; изменение системы и возможный UAC",p.version,p.architecture),app_id:s.app_id.clone(),name:catalog::app(&s.app_id).map(|a|catalog::text(&a,"name").to_string()).unwrap_or_default(),action:"install".into(),warnings:vec!["Версия автономного снимка может быть старше онлайн-каталога. Понижение установленной версии блокируется.".into()],blocked:false,installed_version:None});
    }
    let plan=Plan{token:token.clone(),items:rows,warnings:vec![format!("Локальный набор: {}. Установка начнётся после подтверждения; интернет для базовых установщиков не нужен.",root.display())],system:info,mode:"live".into()};
    crate::engine::lock(shared).pending = Some(PendingPlan {
        token,
        items,
        created_at: now(),
        skip_current: true,
        parallel_downloads: 1,
        tasks,
    });
    Ok(plan)
}
pub fn command(root: &Path, data: &Path, task: &Task) -> Result<std::process::Command, String> {
    let bundle = read(root)?;
    let p = bundle
        .packages
        .iter()
        .find(|p| p.app_id == task.app_id)
        .ok_or("Пакет отсутствует в наборе")?;
    let r = recipe(&task.selection)?;
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("Набор рассчитан на Windows x64".into());
    }
    // Never downgrade an existing installation based on an old offline snapshot.
    if let Ok(exe) = crate::readiness::executable(&task.app_id) {
        let found = crate::readiness::check(&task.selection);
        let _ = exe;
        if let Some(v) = found.version {
            let numeric = v
                .split_whitespace()
                .find(|s| s.chars().next().is_some_and(|c| c.is_ascii_digit()))
                .unwrap_or(&v)
                .lines()
                .next()
                .unwrap_or("");
            existing_transition(r, numeric)?;
        } else {
            return Err(
                "Установленная версия неизвестна; автоматическая замена офлайн-пакетом остановлена"
                    .into(),
            );
        }
    }
    let stage = data
        .join("offline-stage")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let destination = stage.join(r.file);
    std::fs::copy(managed::child(root, &p.file)?, &destination).map_err(|e| e.to_string())?;
    if managed::hash(&destination)? != r.hash {
        return Err("Хеш локальной копии изменился".into());
    }
    let mut c = system::command(destination);
    match r.id {
        "python" => {
            c.args([
                "/passive",
                "/norestart",
                "Include_launcher=0",
                "Include_test=0",
            ]);
            for (key, param, default) in
                [("pip", "Include_pip", true), ("path", "PrependPath", true)]
            {
                c.arg(format!(
                    "{param}={}",
                    u8::from(
                        task.selection
                            .options
                            .get(key)
                            .and_then(Value::as_bool)
                            .unwrap_or(default)
                    )
                ));
            }
            c.arg(format!(
                "InstallAllUsers={}",
                u8::from(
                    task.selection.options.get("scope").and_then(Value::as_str) == Some("machine")
                )
            ));
        }
        "git" => {
            c.args([
                "/SP-",
                "/SILENT",
                "/SUPPRESSMSGBOXES",
                "/NORESTART",
                "/CURRENTUSER",
            ]);
        }
        "vscode" => {
            c.args([
                "/SP-",
                "/SILENT",
                "/SUPPRESSMSGBOXES",
                "/NORESTART",
                "/mergetasks=!runcode",
            ]);
        }
        _ => return Err("Нет адаптера".into()),
    }
    Ok(c)
}
fn requirements() -> SystemInfo {
    let v=system::powershell("$d=New-Object System.IO.DriveInfo($env:SystemDrive); [pscustomobject]@{os=[Environment]::OSVersion.VersionString;freeDiskMb=[math]::Floor($d.AvailableFreeSpace/1MB);admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json -Compress").unwrap_or(Value::Null);
    SystemInfo {
        windows: cfg!(windows),
        arch: match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            v => v,
        }
        .into(),
        winget: None,
        free_disk_mb: v["freeDiskMb"].as_u64(),
        virtualization: None,
        wsl: "Не требуется для этих локальных EXE".into(),
        hyper_v: "Не требуется для этих локальных EXE".into(),
        admin: v["admin"].as_bool().unwrap_or(false),
        os: v["os"].as_str().unwrap_or(std::env::consts::OS).into(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn git_windows_builds_never_downgrade() {
        let r = &RECIPES[1];
        assert!(existing_transition(r, "2.49.0.windows.2").is_err());
        assert!(existing_transition(r, "2.49.0.windows.1").is_ok());
        assert!(existing_transition(r, "2.48.0.windows.1").is_ok());
        assert!(existing_transition(r, "unknown").is_err());
    }
    #[test]
    fn foreign_hash_cannot_authorize_an_installer() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).unwrap();
        let s = Selection {
            app_id: "python".into(),
            action: "install".into(),
            options: Default::default(),
            extensions: vec![],
            version: None,
        };
        let p = Package {
            app_id: "python".into(),
            version: "3.12.10".into(),
            architecture: "x64".into(),
            file: RECIPES[0].file.into(),
            sha256: "attacker".into(),
            selection: s,
        };
        managed::json(
            &root.join("manifest.json"),
            &Bundle {
                schema_version: 1,
                packages: vec![p],
                created_at: 0,
            },
        )
        .unwrap();
        assert!(inspect(&root).is_err());
        std::fs::write(root.join("manifest.json"), b"{broken").unwrap();
        assert!(inspect(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn path_traversal_is_rejected() {
        assert!(managed::child(Path::new("."), "../Cargo.toml").is_err());
        assert!(managed::child(Path::new("."), "C:\\evil.exe").is_err());
    }
}
