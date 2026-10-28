mod catalog;
mod engine;
mod models;
mod system;
mod winget;
use engine::Shared;
use models::*;
use tauri::{Manager, State};

#[tauri::command]
async fn system_info() -> Result<SystemInfo, String> {
    tauri::async_runtime::spawn_blocking(system::info)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn scan_installed(state: State<'_, Shared>) -> Result<Vec<Installed>, String> {
    let data = engine::lock(&state).data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || system::scan(&data))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn queue_snapshot(state: State<'_, Shared>) -> Queue {
    engine::lock(&state).queue.clone()
}
#[tauri::command]
async fn prepare_plan(
    state: State<'_, Shared>,
    items: Vec<Selection>,
    skip_current: bool,
    parallel_downloads: usize,
) -> Result<Plan, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        engine::prepare(&shared, items, skip_current, parallel_downloads)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn start_plan(
    state: State<'_, Shared>,
    token: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    engine::start(&state, &token, app)
}
#[tauri::command]
fn queue_control(
    state: State<'_, Shared>,
    action: String,
    task_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    engine::control(&state, app, &action, task_id.as_deref())
}
#[tauri::command]
fn open_source(app_id: String, index: usize) -> Result<(), String> {
    let app = catalog::app(&app_id)?;
    let url = app["sources"]
        .as_array()
        .and_then(|s| s.get(index))
        .and_then(serde_json::Value::as_str)
        .ok_or("Источник не найден")?;
    if !url.starts_with("https://") {
        return Err("Разрешены только HTTPS-источники каталога".into());
    }
    open::that(url).map_err(|e| e.to_string())
}
#[tauri::command]
fn open_downloads(state: State<'_, Shared>) -> Result<(), String> {
    let path = system::download_dir(&engine::lock(&state).data_dir);
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    open::that(path).map_err(|e| e.to_string())
}
#[tauri::command]
fn check_port(port: u16) -> Result<bool, String> {
    system::port_available(port)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let path = app.path().app_local_data_dir()?;
            app.manage(std::sync::Arc::new(std::sync::Mutex::new(
                engine::Engine::load(path),
            )));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            system_info,
            scan_installed,
            queue_snapshot,
            prepare_plan,
            start_plan,
            queue_control,
            open_source,
            open_downloads,
            check_port
        ])
        .run(tauri::generate_context!())
        .expect("Не удалось запустить AppDock");
}
