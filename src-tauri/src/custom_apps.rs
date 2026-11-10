//! User installers are local, separate from the trusted catalog. No imported launch recipes.
use crate::{readiness::quote, system};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomApp {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub file_name: String,
    pub source: String,
    pub size: u64,
    pub sha256: String,
    pub kind: String,
    pub version: Option<String>,
    pub publisher: Option<String>,
    pub signature: String,
    pub signature_detail: String,
}
pub fn valid_id(id: &str) -> bool {
    id.strip_prefix("user:")
        .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok())
}
pub fn load(data: &Path) -> Result<Vec<CustomApp>, String> {
    match fs::read(data.join("custom-apps.json")) {
        Ok(b) => serde_json::from_slice(&b)
            .map_err(|e| format!("Не удалось прочитать мои программы: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}
fn save(data: &Path, apps: &[CustomApp]) -> Result<(), String> {
    let tmp = data.join("custom-apps.tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(apps).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    OpenOptions::new()
        .write(true)
        .open(&tmp)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(tmp, data.join("custom-apps.json")).map_err(|e| e.to_string())
}
pub fn path(data: &Path, entry: &CustomApp) -> Result<PathBuf, String> {
    if !valid_id(&entry.id) || !["exe", "msi"].contains(&entry.kind.as_str()) {
        return Err("Некорректная запись установщика".into());
    }
    Ok(data
        .join("custom-installers")
        .join(format!("{}.{}", &entry.id[5..], entry.kind)))
}
pub fn hash(file: &mut File) -> Result<String, String> {
    let mut h = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
pub fn locked(path: &Path, expected: &str) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut f = options.open(path).map_err(|e| {
        format!("Управляемая копия недоступна: {e}. Выберите локальный файл заново.")
    })?;
    if hash(&mut f)? != expected {
        return Err("SHA-256 изменился после просмотра. Запуск запрещён; выберите файл и проверьте новый план.".into());
    }
    Ok(f) // Keep this handle alive until the installer exits (deny write/delete on Windows).
}
fn metadata(path: &Path) -> Value {
    system::powershell(&format!(r#"$p={}; $i=(Get-Item -LiteralPath $p).VersionInfo; $version=$i.ProductVersion; $publisher=$i.CompanyName;
    if([IO.Path]::GetExtension($p) -ieq '.msi'){{try{{$wi=New-Object -ComObject WindowsInstaller.Installer; $db=$wi.OpenDatabase($p,0); $q=$db.OpenView('SELECT `Value` FROM `Property` WHERE `Property`=''ProductVersion''');$q.Execute();$version=$q.Fetch().StringData(1);$q.Close();$q=$db.OpenView('SELECT `Value` FROM `Property` WHERE `Property`=''Manufacturer''');$q.Execute();$publisher=$q.Fetch().StringData(1);$q.Close()}}catch{{}}}}
    try{{$s=Get-AuthenticodeSignature -LiteralPath $p; $status=$s.Status.ToString();$detail=$s.StatusMessage}}catch{{$status='UnknownError';$detail=$_.Exception.Message}}
    [pscustomobject]@{{version=$version;publisher=$publisher;status=$status;detail=$detail}} | ConvertTo-Json -Compress"#,quote(&path.to_string_lossy())))
        .unwrap_or_else(|e|json!({"status":"UnknownError","detail":e}))
}
pub fn signature_state(s: &str) -> &'static str {
    match s {
        "Valid" => "valid",
        "NotSigned" => "unsigned",
        "HashMismatch" | "NotTrusted" | "NotSupportedFileFormat" => "invalid",
        _ => "unknown",
    }
}
pub fn signature_label(s: &str) -> &'static str {
    match s {
        "valid" => "подпись подтверждена",
        "unsigned" => "подпись отсутствует",
        "invalid" => "подпись недействительна",
        _ => "проверку подписи выполнить не удалось",
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reference {
    name: String,
    sha256: String,
}
pub fn validate_references(v: Value) -> Result<Value, String> {
    let refs: Vec<Reference> = serde_json::from_value(v)
        .map_err(|_| "Импорт содержит неизвестные поля. Пути, аргументы и команды запрещены")?;
    if refs.len() > 100
        || refs.iter().any(|r| {
            r.name.trim().is_empty()
                || r.name.len() > 160
                || r.sha256.len() != 64
                || !r.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        })
    {
        return Err("Некорректные ссылки на собственные программы".into());
    }
    Ok(json!(refs))
}
pub fn add(data: &Path) -> Result<CustomApp, String> {
    let v=system::powershell("Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='Выберите собственный установщик'; $d.Filter='Установщики (*.exe;*.msi)|*.exe;*.msi'; if($d.ShowDialog() -eq 'OK'){$d.FileName | ConvertTo-Json -Compress}else{'' | ConvertTo-Json}")?;
    let source = PathBuf::from(
        v.as_str()
            .filter(|v| !v.is_empty())
            .ok_or("Выбор файла отменён")?,
    );
    add_file(data, &source)
}
pub fn add_file(data: &Path, source: &Path) -> Result<CustomApp, String> {
    let kind = source
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !source.is_absolute() || !["exe", "msi"].contains(&kind.as_str()) {
        return Err("Выберите локальный EXE или MSI".into());
    }
    if source.to_string_lossy().starts_with("\\\\") {
        return Err("Скопируйте установщик с сетевого диска на локальный диск".into());
    }
    let root = data.join("custom-installers");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let id = format!("user:{}", uuid::Uuid::new_v4());
    let dest = root.join(format!("{}.{}", &id[5..], kind));
    // One open source handle prevents a replace during copying. Inspect the resulting copy.
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.share_mode(1);
    }
    let mut input = opts.open(source).map_err(|e| e.to_string())?;
    if !input.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Нужен обычный файл".into());
    }
    let result = (|| {
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&dest)
            .map_err(|e| e.to_string())?;
        let size = std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        let sha256 = hash(&mut File::open(&dest).map_err(|e| e.to_string())?)?;
        let mut apps = load(data)?;
        if let Some(existing) = apps.iter().find(|a| a.sha256 == sha256) {
            // A lost managed copy can be repaired by explicitly selecting identical bytes.
            let existing_path = path(data, existing)?;
            if locked(&existing_path, &existing.sha256).is_err() {
                fs::copy(&dest, existing_path).map_err(|e| e.to_string())?;
            }
            return Ok(existing.clone());
        }
        let m = metadata(&dest);
        let file_name = source
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let entry = CustomApp {
            id,
            name: file_name.clone(),
            description: String::new(),
            icon: "Package".into(),
            file_name,
            source: source.to_string_lossy().into(),
            size,
            sha256,
            kind,
            version: m["version"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(String::from),
            publisher: m["publisher"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(String::from),
            signature: signature_state(m["status"].as_str().unwrap_or("")).into(),
            signature_detail: m["detail"]
                .as_str()
                .unwrap_or("Проверку выполнить не удалось")
                .into(),
        };
        apps.push(entry.clone());
        save(data, &apps)?;
        Ok(entry)
    })();
    if result.as_ref().is_err()
        || result
            .as_ref()
            .is_ok_and(|a| path(data, a).ok().as_ref() != Some(&dest))
    {
        let _ = fs::remove_file(dest);
    }
    result
}
pub fn edit(
    data: &Path,
    id: &str,
    name: &str,
    description: &str,
    icon: &str,
) -> Result<(), String> {
    if name.trim().is_empty()
        || name.len() > 160
        || description.len() > 1000
        || ![
            "Package", "Code2", "Globe", "Database", "Coffee", "FileText",
        ]
        .contains(&icon)
    {
        return Err("Неверное название, описание или значок".into());
    }
    let mut apps = load(data)?;
    let a = apps
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or("Запись не найдена")?;
    a.name = name.trim().into();
    a.description = description.into();
    a.icon = icon.into();
    save(data, &apps)
}
pub fn remove(data: &Path, id: &str) -> Result<(), String> {
    let mut apps = load(data)?;
    let a = apps
        .iter()
        .find(|a| a.id == id)
        .ok_or("Запись не найдена")?;
    let p = path(data, a)?;
    // Keep the record if cleanup fails, so the owned copy remains discoverable.
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    apps.retain(|a| a.id != id);
    save(data, &apps)
}
pub fn get(data: &Path, id: &str) -> Result<CustomApp, String> {
    load(data)?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or("Собственный установщик не найден; выберите локальный файл".into())
}
pub fn list(data: &Path) -> Result<Vec<CustomApp>, String> {
    let apps = load(data)?;
    let root = data.join("custom-installers");
    if root.exists() {
        let resolved = root.canonicalize().map_err(|e| e.to_string())?;
        if resolved
            != data
                .canonicalize()
                .map_err(|e| e.to_string())?
                .join("custom-installers")
        {
            return Err("Папка управляемых копий перенаправлена; очистка запрещена".into());
        }
        let owned: Vec<_> = apps
            .iter()
            .map(|a| path(data, a))
            .collect::<Result<_, _>>()?;
        for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let p = entry.path();
            let file = entry.file_type().map_err(|e| e.to_string())?;
            if file.is_file()
                && !file.is_symlink()
                && p.file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
                && p.extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| ["exe", "msi"].contains(&s))
                && !owned.contains(&p)
            {
                fs::remove_file(p).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(apps)
}

#[cfg(windows)]
pub fn run_interactive(file: &Path) -> Result<i32, String> {
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }
    let hr = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
    let _com = ComGuard(hr >= 0);
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE},
        UI::{
            Shell::{
                ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
            },
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    };
    let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let target = wide(file.as_os_str());
    let verb = wide(std::ffi::OsStr::new("open"));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpFile = target.as_ptr();
    info.lpVerb = verb.as_ptr();
    info.nShow = SW_SHOWNORMAL;
    unsafe {
        if ShellExecuteExW(&mut info) == 0 {
            return Err(format!(
                "Windows не запустила установщик: {}",
                std::io::Error::last_os_error()
            ));
        }
        if info.hProcess.is_null() {
            return Err(
                "Установщик передал запуск другому процессу; завершение не подтверждено".into(),
            );
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 0;
        let ok = GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        if ok == 0 {
            return Err("Не удалось получить код установщика".into());
        }
        Ok(code as i32)
    }
}
#[cfg(not(windows))]
pub fn run_interactive(_: &Path) -> Result<i32, String> {
    Err("Только Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn substituted_copy_is_rejected() {
        let root = std::env::temp_dir().join(format!("appdock-custom-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let p = root.join("a.exe");
        fs::write(&p, b"first").unwrap();
        let expected = hash(&mut File::open(&p).unwrap()).unwrap();
        fs::write(&p, b"second").unwrap();
        assert!(locked(&p, &expected).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn signature_outcomes_are_distinct() {
        assert_eq!(signature_state("Valid"), "valid");
        assert_eq!(signature_state("NotSigned"), "unsigned");
        assert_eq!(signature_state("HashMismatch"), "invalid");
        assert_eq!(signature_state("UnknownError"), "unknown");
        assert!(!valid_id("user:../../cmd.exe"));
    }
    #[test]
    fn imports_never_authorize_paths_commands_or_ids() {
        let safe = json!([{"name":"Example","sha256":"a".repeat(64)}]);
        assert!(validate_references(safe.clone()).is_ok());
        for key in ["path", "command", "arguments", "id", "source", "kind"] {
            let mut v = safe.clone();
            v[0][key] = json!("cmd.exe");
            assert!(validate_references(v).is_err(), "{key}");
        }
        assert!(validate_references(json!([{"name":"X","sha256":"bad"}])).is_err());
    }
    #[test]
    fn locked_plan_copy_survives_source_replacement_and_denies_copy_replacement() {
        let root = std::env::temp_dir().join(format!("appdock-copy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.exe");
        let managed = root.join("managed.exe");
        fs::write(&source, b"approved").unwrap();
        fs::copy(&source, &managed).unwrap();
        let expected = hash(&mut File::open(&managed).unwrap()).unwrap();
        fs::write(&source, b"replaced source").unwrap();
        let guard = locked(&managed, &expected).unwrap();
        #[cfg(windows)]
        {
            assert!(fs::write(&managed, b"replace").is_err());
            assert!(fs::remove_file(&managed).is_err());
        }
        drop(guard);
        assert!(locked(&managed, &expected).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn repeated_files_missing_source_and_record_cleanup_are_isolated() {
        let root = std::env::temp_dir().join(format!("appdock-lifecycle-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("custom-installers")).unwrap();
        let id = format!("user:{}", uuid::Uuid::new_v4());
        let source = root.join("original.exe");
        fs::write(&source, b"same installer").unwrap();
        let mut a = CustomApp {
            id,
            name: "Example".into(),
            description: String::new(),
            icon: "Package".into(),
            file_name: "original.exe".into(),
            source: source.to_string_lossy().into(),
            size: 14,
            sha256: hash(&mut File::open(&source).unwrap()).unwrap(),
            kind: "exe".into(),
            version: None,
            publisher: None,
            signature: "unknown".into(),
            signature_detail: "fixture".into(),
        };
        let managed = path(&root, &a).unwrap();
        fs::copy(&source, &managed).unwrap();
        save(&root, &[a.clone()]).unwrap();
        assert_eq!(add_file(&root, &source).unwrap().id, a.id);
        assert_eq!(list(&root).unwrap().len(), 1);
        fs::write(&managed, b"tampered").unwrap();
        assert!(locked(&managed, &a.sha256).is_err());
        assert_eq!(add_file(&root, &source).unwrap().id, a.id);
        assert!(locked(&managed, &a.sha256).is_ok());
        fs::remove_file(&source).unwrap();
        assert!(locked(&managed, &a.sha256).is_ok());
        let installed_marker = root.join("installed-program.exe");
        fs::write(&installed_marker, b"not an installer copy").unwrap();
        let orphan = root
            .join("custom-installers")
            .join(format!("{}.exe", uuid::Uuid::new_v4()));
        fs::write(&orphan, b"orphan").unwrap();
        assert_eq!(list(&root).unwrap().len(), 1);
        assert!(!orphan.exists());
        remove(&root, &a.id).unwrap();
        assert!(!managed.exists());
        assert!(installed_marker.is_file());
        assert!(load(&root).unwrap().is_empty());
        a.id = "user:../outside".into();
        assert!(path(&root, &a).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(windows)]
    fn msi_properties_and_signature_are_read_without_installing() {
        let root = std::env::temp_dir().join(format!("appdock-msi-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("metadata-only.msi");
        system::powershell(&format!(r#"$wi=New-Object -ComObject WindowsInstaller.Installer; $db=$wi.OpenDatabase({},3); $q=$db.OpenView('CREATE TABLE `Property` (`Property` CHAR(72) NOT NULL, `Value` CHAR(0) LOCALIZABLE PRIMARY KEY `Property`)');$q.Execute();$q.Close(); foreach($sql in @('INSERT INTO `Property` (`Property`,`Value`) VALUES (''ProductVersion'',''1.2.3'')','INSERT INTO `Property` (`Property`,`Value`) VALUES (''Manufacturer'',''Fixture Publisher'')')){{$q=$db.OpenView($sql);$q.Execute();$q.Close()}};$db.Commit();$true | ConvertTo-Json"#,quote(&path.to_string_lossy()))).unwrap();
        let m = metadata(&path);
        assert_eq!(m["version"], "1.2.3");
        assert_eq!(m["publisher"], "Fixture Publisher");
        assert_ne!(signature_state(m["status"].as_str().unwrap_or("")), "valid");
        fs::remove_dir_all(root).unwrap();
    }
}
