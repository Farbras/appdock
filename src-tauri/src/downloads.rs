use crate::{catalog, models::*, system};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
fn files_under(
    dir: &Path,
    root: &Path,
    depth: usize,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > 6 || out.len() > 2000 {
        return Err("Слишком много файлов или уровней в папке загрузки".into());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_symlink() {
            continue;
        }
        let path = entry.path();
        if !path
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(root)
        {
            continue;
        }
        if ty.is_dir() {
            files_under(&path, root, depth + 1, out)?
        } else if ty.is_file() && entry.file_name() != "appdock-origin.json" {
            out.push(path)
        }
    }
    Ok(())
}
fn modified(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}
fn task_dir(data: &Path, task: &Task) -> Result<PathBuf, String> {
    catalog::app(&task.app_id)?;
    uuid::Uuid::parse_str(&task.id).map_err(|_| "Неверный идентификатор загрузки")?;
    Ok(system::download_dir(data).join(&task.app_id).join(&task.id))
}
pub fn inventory(data: &Path) -> Result<Value, String> {
    let root = system::download_dir(data);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    let mut files = vec![];
    for app in catalog::apps() {
        let app_id = catalog::text(&app, "id");
        let app_dir = root.join(app_id);
        if !app_dir.is_dir() {
            continue;
        }
        let mut paths = vec![];
        files_under(&app_dir, &canonical, 0, &mut paths)?;
        for path in paths {
            let mut parent = path.parent();
            let mut origin = Value::Null;
            while let Some(dir) = parent {
                if !dir.starts_with(&app_dir) {
                    break;
                }
                if let Ok(raw) = std::fs::read_to_string(dir.join("appdock-origin.json")) {
                    origin = serde_json::from_str(&raw).unwrap_or(Value::Null);
                    if origin["appId"] == app_id {
                        break;
                    }
                }
                parent = dir.parent()
            }
            let meta = path.metadata().map_err(|e| e.to_string())?;
            let recorded = origin["files"].as_array().is_some_and(|list| {
                list.iter().any(|f| {
                    f["name"].as_str() == path.file_name().and_then(|n| n.to_str())
                        && f["size"].as_u64() == Some(meta.len())
                        && f["modified"].as_u64() == modified(&meta)
                })
            });
            files.push(json!({"id":path.strip_prefix(&root).map_err(|e|e.to_string())?.to_string_lossy(),"name":path.file_name().unwrap_or_default().to_string_lossy(),"size":meta.len(),"appId":app_id,"version":origin["version"],"source":origin["source"],"checkedAt":origin["checkedAt"],"verification":if recorded{"WinGet проверил хеши установщиков при загрузке; размер и время файла совпадают с записью. Текущий хеш повторно не проверен."}else{"Нет подтверждённой записи или файл изменён. Текущий хеш не проверен."}}));
        }
    }
    Ok(
        json!({"folder":root,"files":files,"limitations":"Поддерживаются разрешённые пакеты WinGet. Лицензии, зависимости и сетевые компоненты могут ограничивать перенос. Манифесты и вспомогательные файлы не являются проверенными установщиками. Полная офлайн-установка и повторная криптографическая проверка кэша не входят в эту версию."}),
    )
}
pub fn record(data: &Path, task: &Task) -> Result<(), String> {
    let dir = task_dir(data, task)?;
    let a = catalog::app(&task.app_id)?;
    let package = catalog::package_id(&a, &task.selection)?;
    let mut paths = vec![];
    files_under(
        &dir,
        &dir.canonicalize().map_err(|e| e.to_string())?,
        0,
        &mut paths,
    )?;
    let version = paths
        .iter()
        .filter(|p| p.extension().is_some_and(|e| e == "yaml" || e == "yml"))
        .filter_map(|p| {
            if p.metadata().ok()?.len() > 2_000_000 {
                return None;
            }
            let text = std::fs::read_to_string(p).ok()?;
            let field = |key: &str| {
                text.lines().find_map(|l| {
                    l.trim()
                        .strip_prefix(key)
                        .map(|s| s.trim().trim_matches(['\'', '"']).to_string())
                })
            };
            if field("PackageIdentifier:")?.eq_ignore_ascii_case(&package) {
                field("PackageVersion:")
            } else {
                None
            }
        })
        .next()
        .or_else(|| task.selection.version.clone());
    let files:Vec<_>=paths.iter().filter_map(|p|{let m=p.metadata().ok()?;Some(json!({"name":p.file_name()?.to_string_lossy(),"size":m.len(),"modified":modified(&m)}))}).collect();
    std::fs::write(dir.join("appdock-origin.json"),serde_json::to_vec_pretty(&json!({"schemaVersion":2,"appId":task.app_id,"version":version,"source":a["website"],"packageId":package,"checkedAt":now(),"files":files})).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
}
pub fn remove(data: &Path, id: &str) -> Result<(), String> {
    let list = inventory(data)?;
    if !list["files"]
        .as_array()
        .is_some_and(|files| files.iter().any(|f| f["id"] == id))
    {
        return Err("Файл не найден в управляемом кэше".into());
    }
    let root = system::download_dir(data)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = root.join(id).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("Путь вне папки загрузок".into());
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_isolated_per_task_and_rejects_unlisted_paths() {
        let data = std::env::temp_dir().join(format!("appdock-downloads-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&data).unwrap();
        let selection = Selection {
            app_id: "chrome".into(),
            action: "download".into(),
            options: Default::default(),
            extensions: vec![],
            version: None,
        };
        let task = crate::engine::build_tasks(&[selection]).unwrap().remove(0);
        let dir = task_dir(&data, &task).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fixture.bin"), b"adapter fixture").unwrap();
        record(&data, &task).unwrap();
        let list = inventory(&data).unwrap();
        assert_eq!(list["files"].as_array().unwrap().len(), 1);
        assert!(list["files"][0]["source"].is_string());
        assert!(remove(&data, "../../unlisted.txt").is_err());
        remove(&data, list["files"][0]["id"].as_str().unwrap()).unwrap();
        std::fs::remove_file(dir.join("appdock-origin.json")).unwrap();
        std::fs::remove_dir(dir).unwrap();
        std::fs::remove_dir(system::download_dir(&data).join("chrome")).unwrap();
        std::fs::remove_dir(system::download_dir(&data)).unwrap();
        std::fs::remove_dir(data).unwrap();
    }
}
