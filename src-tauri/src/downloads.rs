use crate::{catalog, models::*, system};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub(crate) struct TransferMeter {
    sampled_at: Duration,
    downloaded: u64,
    progress: DownloadProgress,
}
impl TransferMeter {
    pub(crate) fn new() -> Self {
        Self {
            sampled_at: Duration::ZERO,
            downloaded: 0,
            progress: DownloadProgress::new(0, None, 0.0),
        }
    }
    pub(crate) fn with_offset(offset: u64) -> Self {
        let mut m = Self::new();
        m.downloaded = offset;
        m.progress = DownloadProgress::new(offset, None, 0.0);
        m
    }
    pub(crate) fn sample(
        &mut self,
        elapsed: Duration,
        downloaded: u64,
        total: Option<u64>,
    ) -> Option<DownloadProgress> {
        let interval = elapsed.saturating_sub(self.sampled_at);
        if interval < Duration::from_millis(500) {
            return None;
        }
        let speed = downloaded.saturating_sub(self.downloaded) as f64 / interval.as_secs_f64();
        self.sampled_at = elapsed;
        self.downloaded = downloaded;
        self.progress = DownloadProgress::new(downloaded, total, speed);
        Some(self.progress.clone())
    }
}
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
        } else if ty.is_file()
            && entry.file_name() != "appdock-origin.json"
            && entry.file_name() != "resume.json"
            && !entry.file_name().to_string_lossy().ends_with(".part")
        {
            out.push(path)
        }
    }
    Ok(())
}
pub fn discard_partial(data: &Path, task: &Task) -> Result<(), String> {
    let a = catalog::app(&task.app_id)?;
    if task.action != "download" || catalog::direct_download_url(&a).is_none() {
        return Ok(());
    }
    let dir = task_dir(data, task)?;
    if !dir.exists() {
        return Ok(());
    }
    for e in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let name = e.file_name().to_string_lossy().into_owned();
        if (name.ends_with(".part") || name == "resume.json")
            && e.file_type().map_err(|e| e.to_string())?.is_file()
        {
            std::fs::remove_file(e.path()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub fn clear_finished_with_parts(queue: &mut Queue, data: &Path) -> Result<(), String> {
    let mut next = queue.clone();
    crate::models::clear_finished(&mut next);
    let keep: std::collections::HashSet<_> = next
        .tasks
        .iter()
        .filter_map(|t| task_dir(data, t).ok())
        .collect();
    for task in queue
        .tasks
        .iter()
        .filter(|t| !next.tasks.iter().any(|n| n.id == t.id))
    {
        if !task_dir(data, task).is_ok_and(|dir| keep.contains(&dir)) {
            discard_partial(data, task)?;
        }
    }
    *queue = next;
    Ok(())
}
fn modified(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}
pub fn task_dir(data: &Path, task: &Task) -> Result<PathBuf, String> {
    catalog::app(&task.app_id)?;
    let id = task.resume_from.as_deref().unwrap_or(&task.id);
    uuid::Uuid::parse_str(id).map_err(|_| "Неверный идентификатор загрузки")?;
    Ok(system::download_dir(data).join(&task.app_id).join(id))
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
            let verification = if !recorded {
                "Нет подтверждённой записи или файл изменён. Текущий хеш не проверен."
            } else if origin["verification"] == "https" {
                "Скачано напрямую по HTTPS; размер и время файла совпадают с записью. Контрольная сумма в каталоге отсутствует; хеш не проверен."
            } else {
                "WinGet проверил хеши установщиков при загрузке; размер и время файла совпадают с записью. Текущий хеш повторно не проверен."
            };
            files.push(json!({"id":path.strip_prefix(&root).map_err(|e|e.to_string())?.to_string_lossy(),"name":path.file_name().unwrap_or_default().to_string_lossy(),"size":meta.len(),"appId":app_id,"version":origin["version"],"source":origin["source"],"checkedAt":origin["checkedAt"],"verification":verification}));
        }
    }
    Ok(
        json!({"folder":root,"files":files,"limitations":"Поддерживаются разрешённые пакеты WinGet и прямые ссылки из каталога. Лицензии, зависимости и сетевые компоненты могут ограничивать перенос. Манифесты и вспомогательные файлы не являются проверенными установщиками. Полная офлайн-установка и повторная криптографическая проверка кэша не входят в эту версию."}),
    )
}
pub fn record(data: &Path, task: &Task) -> Result<(), String> {
    let dir = task_dir(data, task)?;
    let a = catalog::app(&task.app_id)?;
    let direct_url = catalog::direct_download_url(&a);
    let package = if direct_url.is_some() {
        None
    } else {
        Some(catalog::package_id(&a, &task.selection)?)
    };
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
            if field("PackageIdentifier:")?.eq_ignore_ascii_case(package.as_deref()?) {
                field("PackageVersion:")
            } else {
                None
            }
        })
        .next()
        .or_else(|| task.selection.version.clone())
        .or_else(|| direct_url.map(|_| catalog::text(&a, "version").to_string()));
    let files:Vec<_>=paths.iter().filter_map(|p|{let m=p.metadata().ok()?;Some(json!({"name":p.file_name()?.to_string_lossy(),"size":m.len(),"modified":modified(&m)}))}).collect();
    std::fs::write(dir.join("appdock-origin.json"),serde_json::to_vec_pretty(&json!({"schemaVersion":2,"appId":task.app_id,"version":version,"source":direct_url.unwrap_or(catalog::text(&a,"website")),"packageId":package,"verification":if direct_url.is_some(){"https"}else{"winget"},"checkedAt":now(),"files":files})).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
}
pub fn require_live(mode: &str) -> Result<(), String> {
    if mode != "live" {
        return Err("Реальные файлы недоступны в деморежиме".into());
    }
    Ok(())
}
pub fn remove_confirmed(data: &Path, id: &str, mode: &str, confirmed: bool) -> Result<(), String> {
    require_live(mode)?;
    if !confirmed {
        return Err("Подтвердите удаление файла".into());
    }
    remove(data, id)
}
pub fn set_folder(data: &Path, folder: &Path, mode: &str) -> Result<(), String> {
    require_live(mode)?;
    if !folder.is_absolute() || !folder.is_dir() {
        return Err("Выберите существующую абсолютную папку".into());
    }
    use std::io::Write;
    let temp = data.join("download-folder.tmp");
    let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(folder).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(temp, data.join("download-folder.json")).map_err(|e| e.to_string())
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
    fn demo_and_unconfirmed_deletion_leave_real_files_and_folder_settings_untouched() {
        let data =
            std::env::temp_dir().join(format!("appdock-demo-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data).unwrap();
        let sentinel = data.join("keep.txt");
        std::fs::write(&sentinel, b"keep").unwrap();
        let setting = data.join("download-folder.json");
        std::fs::write(&setting, b"unchanged").unwrap();
        assert!(require_live("demo").is_err());
        assert!(require_live("unknown").is_err());
        assert!(remove_confirmed(&data, "keep.txt", "demo", true).is_err());
        assert!(remove_confirmed(&data, "keep.txt", "live", false).is_err());
        assert!(set_folder(&data, &data, "demo").is_err());
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"keep");
        assert_eq!(std::fs::read(&setting).unwrap(), b"unchanged");
        set_folder(&data, &data, "live").unwrap();
        assert_eq!(
            serde_json::from_slice::<std::path::PathBuf>(&std::fs::read(&setting).unwrap())
                .unwrap(),
            data
        );
        std::fs::remove_dir_all(data).unwrap();
    }
    fn office_task() -> Task {
        crate::engine::build_tasks(&[Selection {
            app_id: "word".into(),
            action: "download".into(),
            options: Default::default(),
            extensions: vec![],
            version: None,
        }])
        .unwrap()
        .remove(0)
    }
    #[test]
    fn direct_origins_and_resume_metadata_are_not_published_as_received_files() {
        let data = std::env::temp_dir().join(format!("appdock-origins-{}", uuid::Uuid::new_v4()));
        for (id, file) in [
            ("word", "ProPlus2024Retail.img"),
            ("office-2021", "ProPlus2021Retail.img"),
            ("office-2019", "ProPlus2019Retail.img"),
            ("office-2016", "ProPlusRetail.img"),
        ] {
            let mut task = office_task();
            task.app_id = id.into();
            task.selection.app_id = id.into();
            let dir = task_dir(&data, &task).unwrap();
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("resume.json"), b"{}").unwrap();
            std::fs::write(dir.join(format!("{file}.part")), b"incomplete").unwrap();
            let before = inventory(&data).unwrap()["files"].as_array().unwrap().len();
            std::fs::write(dir.join(file), b"completed fixture").unwrap();
            record(&data, &task).unwrap();
            let inv = inventory(&data).unwrap();
            assert_eq!(inv["files"].as_array().unwrap().len(), before + 1);
            let origin: Value =
                serde_json::from_slice(&std::fs::read(dir.join("appdock-origin.json")).unwrap())
                    .unwrap();
            assert_eq!(
                origin["source"],
                catalog::app(id).unwrap()["install"]["downloadUrl"]
            );
            assert_eq!(origin["verification"], "https");
            discard_partial(&data, &task).unwrap();
            assert!(dir.join(file).is_file());
            assert!(!dir.join("resume.json").exists());
        }
        std::fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn transfer_statistics_handle_throttling_stalls_retries_and_unknown_sizes() {
        let mut meter = TransferMeter::new();
        assert!(meter
            .sample(Duration::from_millis(200), 100, Some(1000))
            .is_none());
        let p = meter
            .sample(Duration::from_millis(500), 250, Some(1000))
            .unwrap();
        assert_eq!(p.percent(), Some(25.0));
        assert_eq!(p.bytes_per_second, 500.0);
        assert_eq!(p.remaining_bytes, Some(750));
        assert_eq!(p.remaining_seconds, Some(2));
        let p = meter
            .sample(Duration::from_secs(1), 250, Some(1000))
            .unwrap();
        assert_eq!(p.bytes_per_second, 0.0);
        assert_eq!(p.remaining_seconds, None);
        let p = meter.sample(Duration::from_millis(1500), 10, None).unwrap();
        assert_eq!(p.bytes_per_second, 0.0);
        assert_eq!(p.percent(), None);
        assert_eq!(p.remaining_bytes, None);
        let p = meter.sample(Duration::from_secs(2), 510, None).unwrap();
        assert_eq!(p.bytes_per_second, 1000.0);
        assert_eq!(p.remaining_seconds, None);
    }
    #[test]
    fn clearing_old_failure_keeps_parts_used_by_a_recovered_retry() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut old = office_task();
        old.status = "error".into();
        let dir = task_dir(&data, &old).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("test.part");
        std::fs::write(&part, b"keep").unwrap();
        let mut retry = old.clone();
        retry.id = uuid::Uuid::new_v4().to_string();
        retry.resume_from = Some(old.id.clone());
        retry.status = "queued".into();
        let mut q = Queue::default();
        q.tasks = vec![old, retry];
        clear_finished_with_parts(&mut q, &data).unwrap();
        assert_eq!(q.tasks.len(), 1);
        assert!(part.exists());
        q.tasks[0].status = "error".into();
        clear_finished_with_parts(&mut q, &data).unwrap();
        assert!(q.tasks.is_empty());
        assert!(!part.exists());
        std::fs::remove_dir_all(data).unwrap();
    }
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
        remove_confirmed(
            &data,
            list["files"][0]["id"].as_str().unwrap(),
            "live",
            true,
        )
        .unwrap();
        std::fs::remove_file(dir.join("appdock-origin.json")).unwrap();
        std::fs::remove_dir(dir).unwrap();
        std::fs::remove_dir(system::download_dir(&data).join("chrome")).unwrap();
        std::fs::remove_dir(system::download_dir(&data)).unwrap();
        std::fs::remove_dir(data).unwrap();
    }
}
