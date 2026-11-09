use crate::{catalog, models::*, system};
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

// Only use the final, complete successful response, never redirect/error lengths.
fn content_length(headers: &str) -> Option<u64> {
    let normalized = headers.replace("\r\n", "\n");
    let last = normalized.trim_end_matches('\n').rsplit("\n\n").next()?;
    if !normalized.ends_with("\n\n") {
        return None;
    }
    let mut lines = last.lines();
    let status = lines
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse::<u16>()
        .ok()?;
    if !(200..300).contains(&status) {
        return None;
    }
    let mut length = None;
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("transfer-encoding") {
                return None;
            }
            if key.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().ok();
            }
        }
    }
    length
}
struct TransferMeter {
    sampled_at: Duration,
    downloaded: u64,
    progress: DownloadProgress,
}
impl TransferMeter {
    fn new() -> Self {
        Self {
            sampled_at: Duration::ZERO,
            downloaded: 0,
            progress: DownloadProgress::new(0, None, 0.0),
        }
    }
    fn sample(
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
            && !entry.file_name().to_string_lossy().ends_with(".part")
        {
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
pub fn download_direct(
    data: &Path,
    task: &Task,
    run: impl FnOnce(std::process::Command, &mut dyn FnMut()) -> Result<i32, String>,
    mut progress: impl FnMut(DownloadProgress),
) -> Result<(), String> {
    let a = catalog::validate(&task.selection)?;
    if task.action != "download" || task.selection.action != "download" {
        return Err("Прямая ссылка доступна только для скачивания".into());
    }
    let url = catalog::direct_download_url(&a).ok_or("Прямая ссылка отсутствует в каталоге")?;
    let name = url.rsplit('/').next().unwrap_or("");
    if !url.starts_with("https://")
        || name.is_empty()
        || name == "."
        || name == ".."
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err("Недопустимая ссылка скачивания в каталоге".into());
    }
    let dir = task_dir(data, task)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let partial = dir.join(format!("{name}.part"));
    let headers = dir.join(format!("{name}.headers.part"));
    let destination = dir.join(name);
    let mut command = system::command("curl.exe");
    command
        .args([
            "--disable",
            "--fail",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "30",
            "--retry",
            "2",
            "--silent",
            "--show-error",
        ])
        .arg("--dump-header")
        .arg(&headers)
        .arg("--output")
        .arg(&partial)
        .arg(url);
    let total_bytes = || {
        let mut bytes = Vec::new();
        std::fs::File::open(&headers)
            .ok()?
            .take(65_536)
            .read_to_end(&mut bytes)
            .ok()?;
        content_length(&String::from_utf8_lossy(&bytes))
    };
    let began = Instant::now();
    let mut meter = TransferMeter::new();
    progress(meter.progress.clone());
    let result = (|| {
        let code = run(command, &mut || {
            let downloaded = std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
            if let Some(sample) = meter.sample(began.elapsed(), downloaded, total_bytes()) {
                progress(sample);
            }
        })?;
        if code != 0 {
            return Err(format!(
                "Ошибка скачивания (curl: {code}). Проверьте сеть и повторите загрузку."
            ));
        }
        let downloaded = std::fs::metadata(&partial)
            .map_err(|e| e.to_string())?
            .len();
        if downloaded == 0 {
            return Err("Сервер вернул пустой файл".into());
        }
        if total_bytes().is_some_and(|total| total != downloaded) {
            return Err("Файл скачан не полностью. Повторите загрузку.".into());
        }
        std::fs::rename(&partial, &destination).map_err(|e| e.to_string())?;
        record(data, task)?;
        progress(DownloadProgress::new(
            downloaded,
            Some(downloaded),
            meter.progress.bytes_per_second,
        ));
        Ok(())
    })();
    let _ = std::fs::remove_file(&headers);
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
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
    fn direct_download_uses_catalog_url_and_records_its_actual_source() {
        let data = std::env::temp_dir().join(format!("appdock-direct-{}", uuid::Uuid::new_v4()));
        let task = office_task();
        let dir = task_dir(&data, &task).unwrap();
        download_direct(&data, &task, |command, monitor| {
            assert_eq!(command.get_program(), "curl.exe");
            let args: Vec<_> = command.get_args().collect();
            assert_eq!(args.last().unwrap().to_str().unwrap(),
                "https://officecdn.microsoft.com/db/492350f6-3a01-4f97-b9c0-c7c6ddf67d60/media/ru-ru/ProPlus2024Retail.img");
            assert!(args.windows(2).any(|pair| pair == ["--proto-redir", "=https"]));
            assert!(!args.contains(&std::ffi::OsStr::new("--insecure")));
            let output = args[args.iter().position(|a| *a == "--output").unwrap() + 1];
            std::fs::write(output, b"office image fixture").unwrap();
            monitor();
            assert_eq!(inventory(&data).unwrap()["files"].as_array().unwrap().len(), 0);
            Ok(0)
        }, |_| {}).unwrap();
        assert!(dir.join("ProPlus2024Retail.img").is_file());
        assert!(!dir.join("ProPlus2024Retail.img.part").exists());
        let list = inventory(&data).unwrap();
        let file = &list["files"][0];
        assert_eq!(file["name"], "ProPlus2024Retail.img");
        assert_eq!(file["version"], "2024");
        assert_eq!(
            file["source"],
            catalog::app("word").unwrap()["install"]["downloadUrl"]
        );
        assert!(file["verification"].as_str().unwrap().contains("HTTPS"));
        assert!(!file["verification"].as_str().unwrap().contains("WinGet"));
        std::fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn failed_or_empty_direct_downloads_never_publish_an_image() {
        let data =
            std::env::temp_dir().join(format!("appdock-direct-errors-{}", uuid::Uuid::new_v4()));
        let task = office_task();
        let dir = task_dir(&data, &task).unwrap();
        for outcome in [Ok(22), Err("network error".to_string()), Ok(0)] {
            let result = download_direct(
                &data,
                &task,
                |_, _| {
                    std::fs::write(dir.join("ProPlus2024Retail.img.part"), b"").unwrap();
                    outcome
                },
                |_| {},
            );
            assert!(result.is_err());
            assert!(!dir.join("ProPlus2024Retail.img").exists());
            assert!(!dir.join("ProPlus2024Retail.img.part").exists());
            assert_eq!(
                inventory(&data).unwrap()["files"].as_array().unwrap().len(),
                0
            );
        }
        std::fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn every_office_version_downloads_its_own_image_with_complete_progress() {
        let data = std::env::temp_dir().join(format!("appdock-office-{}", uuid::Uuid::new_v4()));
        for (id, version, file) in [
            ("word", "2024", "ProPlus2024Retail.img"),
            ("office-2021", "2021", "ProPlus2021Retail.img"),
            ("office-2019", "2019", "ProPlus2019Retail.img"),
            ("office-2016", "2016", "ProPlusRetail.img"),
        ] {
            let mut selection = office_task().selection;
            selection.app_id = id.into();
            let task = crate::engine::build_tasks(&[selection]).unwrap().remove(0);
            let mut samples = vec![];
            download_direct(
                &data,
                &task,
                |command, monitor| {
                    let args: Vec<_> = command.get_args().collect();
                    let url = args.last().unwrap().to_str().unwrap();
                    assert_eq!(
                        url,
                        catalog::app(id).unwrap()["install"]["downloadUrl"]
                            .as_str()
                            .unwrap()
                    );
                    assert!(url.ends_with(file));
                    assert_eq!(url.contains("/pr/"), id == "office-2016");
                    let output = args[args.iter().position(|a| *a == "--output").unwrap() + 1];
                    let headers =
                        args[args.iter().position(|a| *a == "--dump-header").unwrap() + 1];
                    std::fs::write(headers, b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n")
                        .unwrap();
                    std::fs::write(output, b"image").unwrap();
                    monitor();
                    Ok(0)
                },
                |p| samples.push(p),
            )
            .unwrap();
            let final_sample = samples.last().unwrap();
            assert_eq!(final_sample.percent(), Some(100.0));
            assert_eq!(final_sample.downloaded_bytes, 5);
            assert_eq!(final_sample.remaining_bytes, Some(0));
            assert_eq!(final_sample.remaining_seconds, Some(0));
            let dir = task_dir(&data, &task).unwrap();
            assert!(dir.join(file).is_file());
            assert!(!dir.join(format!("{file}.headers.part")).exists());
            let origin: Value =
                serde_json::from_slice(&std::fs::read(dir.join("appdock-origin.json")).unwrap())
                    .unwrap();
            assert_eq!(origin["version"], version);
        }
        assert_eq!(
            inventory(&data).unwrap()["files"].as_array().unwrap().len(),
            4
        );
        std::fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn partial_images_and_header_files_are_cleaned_up_on_size_mismatch() {
        let data = std::env::temp_dir().join(format!("appdock-partial-{}", uuid::Uuid::new_v4()));
        let task = office_task();
        let dir = task_dir(&data, &task).unwrap();
        let result = download_direct(
            &data,
            &task,
            |command, _| {
                let args: Vec<_> = command.get_args().collect();
                let output = args[args.iter().position(|a| *a == "--output").unwrap() + 1];
                let headers = args[args.iter().position(|a| *a == "--dump-header").unwrap() + 1];
                std::fs::write(headers, b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n").unwrap();
                std::fs::write(output, b"short").unwrap();
                Ok(0)
            },
            |_| {},
        );
        assert!(result.unwrap_err().contains("не полностью"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn size_comes_only_from_the_final_complete_successful_response() {
        assert_eq!(content_length("HTTP/1.1 302 Found\r\nContent-Length: 8\r\n\r\nHTTP/2 200\r\ncOnTeNt-LeNgTh: 4000000000\r\n\r\n"), Some(4_000_000_000));
        assert_eq!(content_length("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nHTTP/1.1 503 Busy\r\nContent-Length: 3\r\n\r\n"), None);
        assert_eq!(
            content_length("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nHTTP/2 200\r\nContent-Len"),
            None
        );
        assert_eq!(
            content_length(
                "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nTransfer-Encoding: chunked\r\n\r\n"
            ),
            None
        );
        assert_eq!(content_length("HTTP/2 200\r\n\r\n"), None);
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
