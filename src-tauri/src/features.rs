use crate::{
    background, catalog, catalog_update, downloads,
    engine::{self, Shared},
    managed,
    models::*,
    offline, preferences, readiness, system,
};
use serde_json::{json, Value};
use tauri::Emitter;
fn string<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v[k].as_str()
        .ok_or_else(|| format!("Не указан параметр {k}"))
}
fn list(v: &Value) -> Result<Vec<String>, String> {
    serde_json::from_value(v.clone()).map_err(|e| e.to_string())
}
pub fn execute(
    shared: &Shared,
    app: &tauri::AppHandle,
    op: &str,
    args: Value,
    mode: &str,
) -> Result<Value, String> {
    downloads::require_live(mode)?;
    let data = engine::lock(shared).data_dir.clone();
    match op {
        "catalog-snapshot" => return Ok(catalog_update::snapshot(&data)),
        "background-state" => return Ok(background::state(&data)),
        "offline-support" => {
            return Ok(offline::support(
                &serde_json::from_value::<Vec<Selection>>(args["items"].clone())
                    .map_err(|e| e.to_string())?,
            ))
        }
        "backups" => return preferences::backups(&data),
        "background-check" => return background::check(shared, app),
        "offline-cancel" => {
            offline::ABORT.store(true, std::sync::atomic::Ordering::Relaxed);
            return Ok(Value::Null);
        }
        _ => (),
    }
    let _guard = managed::exclusive()?;
    if background::CLOSING.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("AppDock завершает работу".into());
    }
    if background::DEMO.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("Системные операции отключены в деморежиме".into());
    }
    if engine::lock(shared).worker_active && op != "sync-update-rules" {
        return Err("Дождитесь завершения очереди перед этой операцией".into());
    }
    match op {
        "choose-folder" => {
            let v=system::powershell("Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Выберите папку AppDock'; if($d.ShowDialog() -eq 'OK'){$d.SelectedPath | ConvertTo-Json -Compress}else{'' | ConvertTo-Json}")?;
            if v.as_str().is_none_or(|s| s.is_empty()) {
                return Err("Выбор папки отменён".into());
            }
            Ok(v)
        }
        "readiness" | "launch" => {
            let id = string(&args, "taskId")?;
            let task = engine::lock(shared)
                .queue
                .tasks
                .iter()
                .find(|t| {
                    t.id == id
                        && ["install", "extension"].contains(&t.action.as_str())
                        && [
                            "installed",
                            "current",
                            "action-required",
                            "reboot-required",
                            "user-completed",
                        ]
                        .contains(&t.status.as_str())
                })
                .cloned()
                .ok_or("Нет завершённой установки для проверки")?;
            if op == "launch" {
                readiness::launch(&task.selection)?;
                return Ok(Value::Null);
            }
            let checked = readiness::check(&task.selection);
            let mut e = engine::lock(shared);
            if let Some(t) = e.queue.tasks.iter_mut().find(|t| t.id == id) {
                t.readiness = Some(checked.clone());
            }
            e.save()?;
            app.emit("queue-changed", &e.queue)
                .map_err(|e| e.to_string())?;
            Ok(json!(checked))
        }
        "save-background" => {
            let mut p: background::Preferences =
                serde_json::from_value(args).map_err(|e| e.to_string())?;
            let current = background::load(&data);
            p.pins = current.pins;
            p.exclusions = current.exclusions;
            Ok(json!(background::save(&data, p)?))
        }
        "sync-update-rules" => {
            let mut p = background::load(&data);
            p.exclusions = list(&args["exclusions"])?;
            p.pins = serde_json::from_value(args["pins"].clone()).map_err(|e| e.to_string())?;
            p.demo = args["demo"].as_bool().unwrap_or(false);
            Ok(json!(background::save(&data, p)?))
        }
        "offline-create" => {
            let _preparing = offline::Preparation::begin();
            let items: Vec<Selection> =
                serde_json::from_value(args["items"].clone()).map_err(|e| e.to_string())?;
            offline::create(
                std::path::Path::new(string(&args, "folder")?),
                &items,
                |v| {
                    let _ = app.emit("appdock-feature-progress", v);
                },
                background::download_limit,
            )
        }
        "offline-inspect" => offline::inspect(std::path::Path::new(string(&args, "folder")?)),
        "offline-prepare" => Ok(json!(offline::plan_inner(
            shared,
            std::path::Path::new(string(&args, "folder")?),
            args.get("includedAppIds").map(list).transpose()?,
            args.get("items")
                .map(|v| serde_json::from_value::<Vec<Selection>>(v.clone())
                    .map_err(|e| e.to_string()))
                .transpose()?
                .unwrap_or_default()
        )?)),
        "settings-export" => Ok(json!(preferences::export(&list(&args["components"])?)?)),
        "settings-preview" => preferences::preview(&data, string(&args, "text")?),
        "settings-apply" => {
            preferences::apply(&data, string(&args, "token")?, &list(&args["components"])?)
        }
        "settings-restore" => preferences::restore(&data, string(&args, "backupId")?),
        "catalog-check" => catalog_update::check(&data),
        "catalog-apply" => {
            if engine::lock(shared)
                .queue
                .tasks
                .iter()
                .any(|t| !terminal(&t.status))
            {
                return Err(
                    "Завершите или отмените незавершённые задачи перед обновлением каталога".into(),
                );
            }
            let r = catalog_update::apply(&data)?;
            engine::lock(shared).pending = None;
            Ok(r)
        }
        "restart-download" => {
            let id = string(&args, "taskId")?;
            let e = engine::lock(shared);
            let t = e
                .queue
                .tasks
                .iter()
                .find(|t| t.id == id)
                .ok_or("Загрузка не найдена")?;
            if t.action != "download"
                || catalog::app(&t.app_id)
                    .ok()
                    .and_then(|a| catalog::direct_download_url(&a).map(str::to_string))
                    .is_none()
            {
                return Err("Поддерживаются только прямые загрузки AppDock".into());
            }
            downloads::discard_partial(&data, t)?;
            Ok(
                json!({"message":"Незавершённые части удалены. Повторите задачу через существующий просмотр плана."}),
            )
        }
        _ => Err("Неизвестная операция AppDock".into()),
    }
}
