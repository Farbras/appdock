use crate::{
    catalog,
    engine::{self, Shared},
    managed,
    models::*,
    readiness, system,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
pub static CLOSING: AtomicBool = AtomicBool::new(false);
pub static DEMO: AtomicBool = AtomicBool::new(false);
static DOWNLOAD_LIMIT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub fn download_limit() -> u64 {
    DOWNLOAD_LIMIT.load(Ordering::Relaxed)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub interval_hours: u32,
    pub autostart: bool,
    pub close_to_tray: bool,
    pub notifications: bool,
    pub prevent_sleep: bool,
    pub download_limit_kib: u64,
    pub demo: bool,
    pub exclusions: Vec<String>,
    pub pins: Vec<Selection>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            interval_hours: 0,
            autostart: false,
            close_to_tray: false,
            notifications: true,
            prevent_sleep: false,
            download_limit_kib: 0,
            demo: false,
            exclusions: vec![],
            pins: vec![],
        }
    }
}
pub fn load(data: &Path) -> Preferences {
    std::fs::read(data.join("background.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
pub fn save(data: &Path, p: Preferences) -> Result<Preferences, String> {
    if ![0, 1, 6, 12, 24, 48, 168].contains(&p.interval_hours)
        || p.download_limit_kib > 1_000_000
        || p.exclusions.len() > 100
        || p.pins.len() > 100
    {
        return Err("Некорректные параметры фонового режима".into());
    }
    for pin in &p.pins {
        let mut allowed = pin.clone();
        allowed.version = None;
        catalog::validate(&allowed)?;
    }
    let changing_autostart = p.autostart != load(data).autostart;
    let mut previous_autostart = None;
    if changing_autostart {
        let key = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        let prior=system::powershell("$v=Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name AppDock -ErrorAction SilentlyContinue; if($null -eq $v -or $null -eq $v.AppDock){'null'}else{$v.AppDock | ConvertTo-Json -Compress}")?;
        if !prior.is_null() && !prior.is_string() {
            return Err("Существующая запись автозапуска имеет неподдерживаемый тип; она сохранена без изменения".into());
        }
        previous_autostart = prior.as_str().map(String::from);
        if p.autostart {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let value = format!("\"{}\" --background", exe.display());
            system::powershell(&format!("New-Item -Path {} -Force | Out-Null; New-ItemProperty -Path {} -Name AppDock -Value {} -PropertyType String -Force | Out-Null; $true | ConvertTo-Json",readiness::quote(key),readiness::quote(key),readiness::quote(&value)))?;
        } else {
            system::powershell(&format!("Remove-ItemProperty -Path {} -Name AppDock -ErrorAction SilentlyContinue; $true | ConvertTo-Json",readiness::quote(key)))?;
        }
    }
    if let Err(e) = managed::json(&data.join("background.json"), &p) {
        if changing_autostart {
            let script=match previous_autostart{Some(value)=>format!("New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name AppDock -Value {} -PropertyType String -Force | Out-Null; $true | ConvertTo-Json",readiness::quote(&value)),None=>"Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name AppDock -ErrorAction SilentlyContinue; $true | ConvertTo-Json".into()};
            system::powershell(&script).map_err(|rollback|format!("Настройки не сохранены: {e}. Не удалось восстановить запись автозапуска: {rollback}"))?;
        }
        return Err(e);
    }
    DOWNLOAD_LIMIT.store(p.download_limit_kib * 1024, Ordering::Relaxed);
    Ok(p)
}
static NAVIGATION: Mutex<Option<String>> = Mutex::new(None);
pub fn navigate(app: &tauri::AppHandle, route: &str) {
    *NAVIGATION.lock().unwrap_or_else(|e| e.into_inner()) = Some(route.into());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit("appdock-navigate", route);
}
pub fn state(data: &Path) -> Value {
    let status = std::fs::read(data.join("background-status.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or(json!({}));
    json!({"preferences":load(data),"status":status,"route":NAVIGATION.lock().unwrap_or_else(|e|e.into_inner()).take()})
}
pub fn check(shared: &Shared, app: &tauri::AppHandle) -> Result<Value, String> {
    let _guard = managed::exclusive()?;
    let data = {
        let e = engine::lock(shared);
        if e.worker_active {
            return Err("Проверка отложена до завершения очереди".into());
        }
        e.data_dir.clone()
    };
    let p = load(&data);
    if DEMO.load(Ordering::Relaxed) {
        return Err("В деморежиме фоновая проверка системы отключена".into());
    }
    if let Ok(bytes) = managed::read(&data.join("background-status.json"), 2_000_000) {
        if let Ok(status) = serde_json::from_slice::<Value>(&bytes) {
            if status["checkedAt"]
                .as_u64()
                .is_some_and(|n| now().saturating_sub(n) < 15_000)
            {
                return Ok(status);
            }
        }
    }
    let result = system::scan_report(&data);
    match result {
        Ok(scan) => {
            let mut updates = vec![];
            for a in catalog::apps() {
                let id = catalog::text(&a, "id");
                if p.exclusions.iter().any(|e| e == id)
                    || p.pins.iter().any(|s| s.app_id == id && s.version.is_some())
                {
                    continue;
                }
                if let Some(i) = scan.installed.iter().find(|i| {
                    Some(i.package_id.as_str()) == a["install"]["packageId"].as_str()
                        && i.available_version.is_some()
                }) {
                    updates.push(format!(
                        "{}@{}",
                        id,
                        i.available_version.as_deref().unwrap_or("")
                    ));
                }
            }
            let status = json!({"checkedAt":now(),"scan":scan,"updates":updates});
            managed::json(&data.join("background-status.json"), &status)?;
            let _ = app.emit("appdock-updates", &status);
            if !updates.is_empty() {
                notify(
                    app,
                    &data,
                    &format!("updates:{}", updates.join(",")),
                    100,
                    "Есть обновления программ",
                    "Откройте центр обновлений, проверьте выбор и подтвердите план.",
                );
            }
            Ok(status)
        }
        Err(e) => {
            let status = json!({"checkedAt":now(),"error":e});
            managed::json(&data.join("background-status.json"), &status)?;
            let _ = app.emit("appdock-updates", &status);
            Err(e)
        }
    }
}
static NOTIFICATIONS: Mutex<()> = Mutex::new(());
pub fn notify(app: &tauri::AppHandle, data: &Path, key: &str, id: i32, title: &str, body: &str) {
    let _guard = NOTIFICATIONS.lock().unwrap_or_else(|e| e.into_inner());
    let p = load(data);
    if !p.notifications || DEMO.load(Ordering::Relaxed) {
        return;
    }
    let path = data.join("notifications.json");
    let mut sent = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or(json!({}));
    if sent[key]
        .as_u64()
        .is_some_and(|n| now().saturating_sub(n) < 86_400_000)
    {
        return;
    }
    if app
        .notification()
        .builder()
        .id(id)
        .title(title)
        .body(body)
        .show()
        .is_ok()
    {
        if let Some(o) = sent.as_object_mut() {
            o.retain(|_, v| {
                v.as_u64()
                    .is_some_and(|n| now().saturating_sub(n) < 7 * 86_400_000)
            });
        }
        sent[key] = json!(now());
        let _ = managed::json(&path, &sent);
    }
}
pub struct SleepGuard(bool);
impl SleepGuard {
    pub fn acquire(enabled: bool) -> Self {
        #[cfg(windows)]
        let acquired = enabled && unsafe { SetThreadExecutionState(0x80000001) != 0 };
        #[cfg(not(windows))]
        let acquired = {
            let _ = enabled;
            false
        };
        Self(acquired)
    }
}
impl Drop for SleepGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        if self.0 {
            unsafe {
                SetThreadExecutionState(0x80000000);
            }
        }
    }
}
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetThreadExecutionState(flags: u32) -> u32;
}
pub fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data = engine::lock(app.state::<Shared>().inner()).data_dir.clone();
    DOWNLOAD_LIMIT.store(load(&data).download_limit_kib * 1024, Ordering::Relaxed);
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };
    let open = MenuItem::with_id(app, "open", "Открыть AppDock", true, None::<&str>)?;
    let updates = MenuItem::with_id(
        app,
        "updates",
        "Проверить обновления программ",
        true,
        None::<&str>,
    )?;
    let queue = MenuItem::with_id(app, "queue", "Показать текущую очередь", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &updates, &queue, &exit])?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("AppDock")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => navigate(app, "catalog"),
            "queue" => navigate(app, "queue"),
            "updates" => {
                navigate(app, "updates");
                let app = app.clone();
                std::thread::spawn(move || {
                    let shared = app.state::<Shared>();
                    let _ = check(&shared, &app);
                });
            }
            "exit" => request_exit(app),
            _ => (),
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    let handle = app.clone();
    app.notification().on_action(move |action| {
        let value = serde_json::to_value(action).unwrap_or(Value::Null);
        if value["actionId"] == "dismiss" {
            return;
        }
        navigate(
            &handle,
            if value["notification"]["id"] == 100 {
                "updates"
            } else {
                "queue"
            },
        );
    })?;
    let handle = app.clone();
    std::thread::spawn(move || {
        // One coordinator per process; the single-instance plugin owns process uniqueness.
        loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            if CLOSING.load(Ordering::Relaxed) {
                break;
            }
            let shared = handle.state::<Shared>();
            let (data, busy) = {
                let e = engine::lock(&shared);
                (e.data_dir.clone(), e.worker_active)
            };
            let p = load(&data);
            if busy || DEMO.load(Ordering::Relaxed) || p.interval_hours == 0 {
                continue;
            }
            let previous = std::fs::read(data.join("background-status.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .and_then(|v| v["checkedAt"].as_u64())
                .unwrap_or(0);
            if now().saturating_sub(previous) >= p.interval_hours as u64 * 3_600_000 {
                let _ = check(&shared, &handle);
            }
        }
    });
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut inhibition: Option<SleepGuard> = None;
        loop {
            if CLOSING.load(Ordering::Relaxed) {
                break;
            }
            let shared = handle.state::<Shared>();
            let e = engine::lock(&shared);
            let p = load(&e.data_dir);
            let active = p.prevent_sleep
                && e.queue.running
                && !e.queue.paused
                && e.queue
                    .tasks
                    .iter()
                    .any(|t| !terminal(&t.status) && t.status != "queued" && !t.download_paused);
            drop(e);
            if active && inhibition.is_none() {
                let guard = SleepGuard::acquire(true);
                if !guard.0 {
                    let _ = handle.emit(
                        "appdock-background-warning",
                        "Windows не подтвердила блокировку сна. Очередь продолжится без неё.",
                    );
                }
                inhibition = Some(guard);
            } else if !active {
                inhibition = None;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        drop(inhibition);
    });
    Ok(())
}
pub fn request_exit(app: &tauri::AppHandle) {
    let shared = app.state::<Shared>();
    let mut e = engine::lock(&shared);
    let operation = managed::OPERATIONS.try_lock();
    if operation.is_err() {
        if crate::offline::PREPARING.load(Ordering::Relaxed) {
            CLOSING.store(true, Ordering::Relaxed);
            drop(e);
            let handle = app.clone();
            std::thread::spawn(move || {
                while crate::offline::PREPARING.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                handle.exit(0);
            });
            return;
        }
        e.queue.storage_error =
            Some("Выход отложен: завершите текущую проверку или перенос настроек.".into());
        let _ = app.emit("queue-changed", &e.queue);
        drop(e);
        navigate(app, "queue");
        return;
    }
    if e.worker_active
        && e.queue.tasks.iter().any(|t| {
            !terminal(&t.status)
                && t.status != "queued"
                && !(t.action == "download"
                    && catalog::app(&t.app_id)
                        .ok()
                        .is_some_and(|a| catalog::direct_download_url(&a).is_some()))
        })
    {
        e.queue.paused = true;
        e.queue.storage_error=Some("Выход отложен: текущий установщик или WinGet должен завершиться. Следующие задачи приостановлены.".into());
        let _ = e.save();
        let _ = app.emit("queue-changed", &e.queue);
        drop(e);
        navigate(app, "queue");
        return;
    }
    e.queue.paused = true;
    let _ = e.save();
    CLOSING.store(true, Ordering::Relaxed);
    drop(e);
    let app = app.clone();
    std::thread::spawn(move || {
        while engine::lock(app.state::<Shared>().inner()).worker_active {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        app.exit(0);
    });
}
