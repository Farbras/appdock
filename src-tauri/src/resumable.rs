use crate::{catalog, downloads, managed, models::*, transfer_control::Request};
use reqwest::header::{CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::Path,
    time::{Duration, Instant},
};
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    schema_version: u32,
    url: String,
    etag: Option<String>,
    modified: Option<String>,
    total: Option<u64>,
    updated_at: u64,
}
fn validator(m: &Metadata) -> Option<&str> {
    m.etag
        .as_deref()
        .filter(|e| !e.starts_with("W/"))
        .or(m.modified.as_deref())
}
fn range_total(value: &str, offset: u64) -> Option<u64> {
    let (span, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = span.split_once('-')?;
    let total = total.parse::<u64>().ok()?;
    (start.parse::<u64>().ok()? == offset
        && end.parse::<u64>().ok()? == total.checked_sub(1)?
        && offset < total)
        .then_some(total)
}
pub fn fetch(
    url: &str,
    part: &Path,
    control: impl Fn() -> Request,
    closing: impl Fn() -> bool,
    limit: impl Fn() -> u64,
    mut progress: impl FnMut(DownloadProgress),
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let meta = part.with_extension("resume.json");
    transfer(
        &client,
        url,
        part,
        &meta,
        0,
        None,
        control,
        closing,
        limit,
        &mut progress,
    )?;
    let _ = std::fs::remove_file(meta);
    Ok(())
}
pub fn direct(
    data: &Path,
    task: &Task,
    control: impl Fn() -> Request,
    closing: impl Fn() -> bool,
    limit: impl Fn() -> u64,
    mut progress: impl FnMut(DownloadProgress),
) -> Result<(), String> {
    let a = catalog::validate(&task.selection)?;
    let url = catalog::direct_download_url(&a).ok_or("Прямая загрузка не поддерживается")?;
    let name = url
        .rsplit('/')
        .next()
        .filter(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
        .ok_or("Неверное имя файла каталога")?;
    let dir = downloads::task_dir(data, task)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let part = dir.join(format!("{name}.part"));
    let meta_path = dir.join("resume.json");
    let offset = part.metadata().map(|m| m.len()).unwrap_or(0);
    let saved: Option<Metadata> = managed::read(&meta_path, 16384)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    transfer(
        &client,
        url,
        &part,
        &meta_path,
        offset,
        saved,
        control,
        closing,
        limit,
        &mut progress,
    )?;
    std::fs::rename(&part, dir.join(name)).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(meta_path);
    downloads::record(data, task)
}
#[allow(clippy::too_many_arguments)]
fn transfer(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    meta_path: &Path,
    offset: u64,
    saved: Option<Metadata>,
    control: impl Fn() -> Request,
    closing: impl Fn() -> bool,
    limit: impl Fn() -> u64,
    progress: &mut impl FnMut(DownloadProgress),
) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let result=runtime.block_on(async {
    let mut request=client.get(url).header("Accept-Encoding","identity");
    if offset > 0 {
        let m=saved.as_ref().filter(|m| m.schema_version == 1 && m.url==url).ok_or("Нет подходящих метаданных дозагрузки. Начните загрузку заново.")?;
        let v=validator(m).ok_or("Сервер не сообщил ETag или Last-Modified. Требуется загрузка заново.")?;
        request=request.header(RANGE,format!("bytes={offset}-")).header(IF_RANGE,v);
    }
    let mut paused=Duration::ZERO;
    let mut response=network(request.send(),&control,&closing,&mut paused).await?;
    let h=response.headers();
    let etag=h.get(ETAG).and_then(|v|v.to_str().ok()).map(String::from);
    let modified=h.get(LAST_MODIFIED).and_then(|v|v.to_str().ok()).map(String::from);
    if h.get("Content-Encoding").is_some_and(|v|v!="identity"){return Err("Сервер использует неподдерживаемое кодирование; части не объединены".into());}
    if offset>0&&response.status().as_u16()==416{
        let old=saved.as_ref().unwrap();
        let identity=if old.etag.as_deref().is_some_and(|e|!e.starts_with("W/")){old.etag==etag}else{old.modified.is_some()&&old.modified==modified};
        if old.total==Some(offset)&&h.get(CONTENT_RANGE).and_then(|v|v.to_str().ok())==Some(format!("bytes */{offset}").as_str())&&identity{progress(DownloadProgress::new(offset,Some(offset),0.0));return Ok(());}
    }
    let total=if offset>0 {
        let old=saved.as_ref().unwrap();
        let total=h.get(CONTENT_RANGE).and_then(|v|v.to_str().ok()).and_then(|v| range_total(v,offset));
        let identity=if old.etag.as_deref().is_some_and(|e| !e.starts_with("W/")) { old.etag==etag } else { old.modified.is_some() && old.modified==modified };
        if response.status().as_u16()!=206 || total.is_none() || !identity || old.total.is_some_and(|n|Some(n)!=total) {
            return Err("Сервер изменил файл или не подтвердил HTTP Range / Content-Range. Части не объединены. Начните загрузку заново.".into());
        }
        total
    } else {
        if response.status().as_u16()!=200 { return Err(format!("Источник вернул HTTP {}",response.status())); }
        response.content_length()
    };
    let mut meta=Metadata{schema_version:1,url:url.into(),etag,modified,total,updated_at:now()};
    managed::json(meta_path,&meta)?;
    let mut f=std::fs::OpenOptions::new().create(true).append(true).open(part).map_err(|e|e.to_string())?;
    let mut bytes=offset;let began=Instant::now();let initial_paused=paused;let mut meter=downloads::TransferMeter::with_offset(offset);
    progress(DownloadProgress::new(bytes,total,0.0));
    loop {
        if closing() { f.sync_all().map_err(|e|e.to_string())?; return Err("APPDOCK_DOWNLOAD_CLOSED".into()); }
        match control() {
            Request::Cancel => { drop(f); let _=std::fs::remove_file(part); let _=std::fs::remove_file(meta_path); return Err(crate::transfer_control::CANCELLED.into()); }
            Request::Pause => { progress(DownloadProgress::new(bytes,total,0.0)); let pause_began=Instant::now();std::thread::sleep(Duration::from_millis(150));paused+=pause_began.elapsed(); continue; }
            Request::Run => (),
        }
        if began.elapsed().saturating_sub(paused.saturating_sub(initial_paused))>Duration::from_secs(86400) { return Err("Превышено время загрузки; частичный файл сохранён".into()); }
        let chunk=Instant::now();
        let buffer=match network(response.chunk(),&control,&closing,&mut paused).await{Ok(b)=>b,Err(e)=>{f.sync_all().map_err(|e|e.to_string())?;return Err(e);}};
        let Some(buffer)=buffer else {break;};let n=buffer.len();
        if total.is_some_and(|t| bytes+n as u64>t) { return Err("Сервер передал больше заявленного размера; требуется загрузка заново".into()); }
        f.write_all(&buffer[..n]).map_err(|e|format!("Ошибка записи загрузки: {e}"))?; bytes+=n as u64;
        let rate=limit();
        if rate>0 { let until=Duration::from_secs_f64(n as f64/rate as f64); while chunk.elapsed()<until { if closing() || control()!=Request::Run { break; } std::thread::sleep(Duration::from_millis(20).min(until.saturating_sub(chunk.elapsed()))); } }
        if let Some(sample)=meter.sample(began.elapsed().saturating_sub(paused.saturating_sub(initial_paused)),bytes,total) {
            progress(sample);
            f.sync_data().map_err(|e|e.to_string())?; meta.updated_at=now(); managed::json(meta_path,&meta)?;
        }
    }
    f.sync_all().map_err(|e|e.to_string())?;
    if bytes==0 || total.is_some_and(|n|n!=bytes) { return Err("Файл неполный; сохранён для дозагрузки".into()); }
    progress(DownloadProgress::new(bytes,Some(bytes),0.0)); Ok(())
    });
    if result
        .as_ref()
        .err()
        .is_some_and(|e| e == crate::transfer_control::CANCELLED)
    {
        let _ = std::fs::remove_file(part);
        let _ = std::fs::remove_file(meta_path);
    }
    result
}
async fn network<T>(
    future: impl std::future::Future<Output = Result<T, reqwest::Error>>,
    control: &impl Fn() -> Request,
    closing: &impl Fn() -> bool,
    paused: &mut Duration,
) -> Result<T, String> {
    tokio::pin!(future);
    let mut idle = Duration::ZERO;
    loop {
        if closing() {
            return Err("APPDOCK_DOWNLOAD_CLOSED".into());
        }
        match control() {
            Request::Cancel => return Err(crate::transfer_control::CANCELLED.into()),
            Request::Pause => {
                let start = Instant::now();
                tokio::time::sleep(Duration::from_millis(100)).await;
                *paused += start.elapsed();
                continue;
            }
            Request::Run => (),
        }
        tokio::select! {r=&mut future=>return r.map_err(|e|format!("Сетевой сбой; частичный файл сохранён: {e}")),_=tokio::time::sleep(Duration::from_millis(100))=>{idle+=Duration::from_millis(100);if idle>=Duration::from_secs(30){return Err("Сетевой сбой: сервер не передаёт данные 30 секунд; частичный файл сохранён".into());}}}
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    #[test]
    fn ranges_reject_wrong_offsets_and_incomplete_responses() {
        assert_eq!(range_total("bytes 5-9/10", 5), Some(10));
        for bad in [
            "bytes 0-9/10",
            "bytes 5-8/10",
            "bytes 5-10/10",
            "bytes */10",
            "bytes 5-9/*",
        ] {
            assert_eq!(range_total(bad, 5), None);
        }
    }
    #[test]
    fn weak_etags_require_last_modified() {
        let mut m = Metadata {
            schema_version: 1,
            url: "a".into(),
            etag: Some("W/\"x\"".into()),
            modified: None,
            total: None,
            updated_at: 0,
        };
        assert!(validator(&m).is_none());
        m.modified = Some("date".into());
        assert_eq!(validator(&m), Some("date"));
    }
    #[test]
    fn saved_partial_survives_closing_and_a_new_client_resumes_from_disk() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for response in ["HTTP/1.1 200 OK\r\nETag: \"stable\"\r\nContent-Length: 10\r\nConnection: close\r\n\r\n12345","HTTP/1.1 206 Partial Content\r\nETag: \"stable\"\r\nContent-Range: bytes 5-9/10\r\nContent-Length: 5\r\nConnection: close\r\n\r\n67890"]{
                let(mut socket,_)=listener.accept().unwrap();let mut req=[0;4096];socket.read(&mut req).unwrap();socket.write_all(response.as_bytes()).unwrap();
            }
        });
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).unwrap();
        let part = root.join("file.part");
        let meta = root.join("resume.json");
        let first = transfer(
            &reqwest::Client::new(),
            &url,
            &part,
            &meta,
            0,
            None,
            || Request::Run,
            || part.metadata().is_ok_and(|m| m.len() >= 5),
            || 0,
            &mut |_| {},
        );
        assert_eq!(first.unwrap_err(), "APPDOCK_DOWNLOAD_CLOSED");
        assert_eq!(std::fs::read(&part).unwrap(), b"12345");
        let saved: Metadata = serde_json::from_slice(&std::fs::read(&meta).unwrap()).unwrap();
        let mut samples = vec![];
        transfer(
            &reqwest::Client::new(),
            &url,
            &part,
            &meta,
            5,
            Some(saved),
            || Request::Run,
            || false,
            || 0,
            &mut |p| samples.push(p),
        )
        .unwrap();
        assert_eq!(samples[0].bytes_per_second, 0.0);
        assert_eq!(samples[0].downloaded_bytes, 5);
        assert_eq!(std::fs::read(&part).unwrap(), b"1234567890");
        server.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn explicit_cancel_deletes_partial_and_metadata() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).unwrap();
        let part = root.join("a.part");
        let meta = root.join("resume.json");
        std::fs::write(&part, b"part").unwrap();
        let saved = Metadata {
            schema_version: 1,
            url: "http://127.0.0.1:1".into(),
            etag: Some("\"stable\"".into()),
            modified: None,
            total: Some(10),
            updated_at: 0,
        };
        managed::json(&meta, &saved).unwrap();
        let r = transfer(
            &reqwest::Client::new(),
            &saved.url.clone(),
            &part,
            &meta,
            4,
            Some(saved),
            || Request::Cancel,
            || false,
            || 0,
            &mut |_| {},
        );
        assert_eq!(r.unwrap_err(), crate::transfer_control::CANCELLED);
        assert!(!part.exists());
        assert!(!meta.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn real_http_resume_and_changed_file_never_mix_bytes() {
        use std::net::TcpListener;
        for (status, etag, range, success) in [
            ("206 Partial Content", "\"one\"", "bytes 5-9/10", true),
            ("200 OK", "\"two\"", "bytes 0-4/5", false),
            ("206 Partial Content", "\"two\"", "bytes 5-9/10", false),
            ("206 Partial Content", "\"one\"", "bytes 0-4/10", false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut s, _) = listener.accept().unwrap();
                let mut b = [0; 4096];
                let n = s.read(&mut b).unwrap();
                let req = String::from_utf8_lossy(&b[..n]).to_lowercase();
                assert!(req.contains("range: bytes=5-"));
                assert!(req.contains("if-range: \"one\""));
                write!(s,"HTTP/1.1 {status}\r\nETag: {etag}\r\nContent-Range: {range}\r\nContent-Length: 5\r\nConnection: close\r\n\r\n67890").unwrap();
            });
            let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir(&root).unwrap();
            let part = root.join("a.part");
            std::fs::write(&part, b"12345").unwrap();
            let meta = Metadata {
                schema_version: 1,
                url: url.clone(),
                etag: Some("\"one\"".into()),
                modified: None,
                total: Some(10),
                updated_at: 0,
            };
            let r = transfer(
                &reqwest::Client::new(),
                &url,
                &part,
                &root.join("meta"),
                5,
                Some(meta),
                || Request::Run,
                || false,
                || 0,
                &mut |_| {},
            );
            assert_eq!(r.is_ok(), success);
            assert_eq!(
                std::fs::read(&part).unwrap(),
                if success {
                    b"1234567890".as_slice()
                } else {
                    b"12345".as_slice()
                }
            );
            server.join().unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
