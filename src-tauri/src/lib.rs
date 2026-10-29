mod catalog;
mod downloads;
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
async fn prepare_retry(
    state: State<'_, Shared>,
    run_id: String,
    status: String,
    task_id: Option<String>,
    edits: Vec<Selection>,
    included_app_ids: Option<Vec<String>>,
) -> Result<Plan, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        engine::prepare_retry(
            &shared,
            &run_id,
            &status,
            task_id.as_deref(),
            edits,
            included_app_ids,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn verify_manual(
    state: State<'_, Shared>,
    task_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (task, data) = {
            let e = engine::lock(&shared);
            (
                e.queue
                    .tasks
                    .iter()
                    .find(|t| {
                        t.id == task_id
                            && ["action-required", "user-completed"].contains(&t.status.as_str())
                    })
                    .cloned()
                    .ok_or("Ручная задача не найдена")?,
                e.data_dir.clone(),
            )
        };
        let found = system::scan(&data)?
            .into_iter()
            .find(|i| {
                let a = catalog::app(&task.app_id).unwrap_or_default();
                i.package_id
                    .eq_ignore_ascii_case(&format!("appdock:{}", task.app_id))
                    || catalog::package_id(&a, &task.selection)
                        .is_ok_and(|p| p.eq_ignore_ascii_case(&i.package_id))
            })
            .ok_or("Программа не обнаружена. Выполните инструкцию или отметьте шаг вручную.")?;
        {
            let mut e = engine::lock(&shared);
            if let Some(t) = e.queue.tasks.iter_mut().find(|t| t.id == task_id) {
                t.actual_version = Some(found.version);
                t.evidence = Some("detected".into());
            }
        }
        engine::update(
            &shared,
            &app,
            &task_id,
            "installed",
            "Результат подтверждён обнаружением программы",
        );
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn downloads_inventory(state: State<'_, Shared>) -> Result<serde_json::Value, String> {
    downloads::inventory(&engine::lock(&state).data_dir)
}
#[tauri::command]
fn remove_download(state: State<'_, Shared>, id: String) -> Result<(), String> {
    let e = engine::lock(&state);
    if e.worker_active {
        return Err("Дождитесь завершения операций с файлами".into());
    }
    downloads::remove(&e.data_dir, &id)
}
#[tauri::command]
async fn choose_download_folder(state: State<'_, Shared>) -> Result<String, String> {
    let data = engine::lock(&state).data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let value=system::powershell("Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Папка загрузок AppDock'; if($d.ShowDialog() -eq 'OK'){$d.SelectedPath | ConvertTo-Json -Compress}else{'' | ConvertTo-Json}")?;
        let path=value.as_str().filter(|p| !p.is_empty()).ok_or("Выбор папки отменён")?;
        let folder=std::path::PathBuf::from(path); if !folder.is_absolute() || !folder.is_dir() { return Err("Выберите существующую абсолютную папку".into()); }
        std::fs::write(data.join("download-folder.json"),serde_json::to_vec(&folder).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?; Ok(path.into())
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn save_report(state: State<'_, Shared>, text: String, structured: bool) -> Result<String, String> {
    if text.len() > 10_000_000 {
        return Err("Отчёт слишком большой".into());
    }
    let root = engine::lock(&state).data_dir.join("reports");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let path = root.join(format!(
        "AppDock-{}.{}",
        now(),
        if structured { "json" } else { "txt" }
    ));
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into())
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
        .on_window_event(|window,event| {
            if let tauri::WindowEvent::CloseRequested { api, .. }=event {
                let state=window.state::<Shared>(); let mut e=engine::lock(&state);
                if e.worker_active && e.queue.tasks.iter().any(|t| !terminal(&t.status) && t.status != "queued") { e.queue.paused=true; e.queue.storage_error=Some("Закрытие отложено: дождитесь текущего установщика. Очередь приостановлена; ожидающие задачи можно отменить.".into()); api.prevent_close(); let _=tauri::Emitter::emit(window,"queue-changed",&e.queue); }
            }
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
            ,prepare_retry, verify_manual, downloads_inventory, remove_download, choose_download_folder, save_report
        ])
        .run(tauri::generate_context!())
        .expect("Не удалось запустить AppDock");
}
