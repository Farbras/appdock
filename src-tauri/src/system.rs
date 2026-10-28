use crate::{
    catalog,
    models::{Installed, SystemInfo},
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
    time::Duration,
};

pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c
}
pub fn output(program: &str, args: &[&str]) -> Result<Output, String> {
    command(program)
        .args(args)
        .output()
        .map_err(|e| format!("Не удалось запустить {program}: {e}"))
}
pub fn powershell(script: &str) -> Result<Value, String> {
    let text=format!("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; {script}");
    let r = output(
        "powershell.exe",
        &[
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &text,
        ],
    )?;
    if !r.status.success() {
        return Err(String::from_utf8_lossy(&r.stderr).trim().into());
    }
    serde_json::from_slice(&r.stdout).map_err(|_| "Не удалось прочитать сведения Windows".into())
}
pub fn info() -> SystemInfo {
    let winget = output("winget", &["--version"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let v=powershell(r#"$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1; $os=Get-CimInstance Win32_OperatingSystem; $disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'"; $wsl=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue; $hv=Get-Service vmms -ErrorAction SilentlyContinue; [pscustomobject]@{os=$os.Caption;virtualization=($cpu.VirtualizationFirmwareEnabled -or $cpu.VMMonitorModeExtensions -and (Get-CimInstance Win32_ComputerSystem).HypervisorPresent);freeDiskMb=[math]::Floor($disk.FreeSpace/1MB);wsl=if($wsl){'Обнаружена конфигурация WSL; версию проверьте командой wsl --status'}else{'Конфигурация WSL не обнаружена'};hyperV=if($hv){$hv.Status.ToString()}else{'Служба Hyper-V не обнаружена'};admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json -Compress"#).unwrap_or(Value::Null);
    SystemInfo {
        windows: cfg!(windows),
        arch: match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            v => v,
        }
        .into(),
        winget,
        free_disk_mb: v["freeDiskMb"].as_u64().or_else(|| {
            v["freeDiskMb"]
                .as_f64()
                .filter(|n| *n >= 0.0)
                .map(|n| n as u64)
        }),
        virtualization: v["virtualization"].as_bool(),
        wsl: v["wsl"].as_str().unwrap_or("Не удалось проверить").into(),
        hyper_v: v["hyperV"]
            .as_str()
            .unwrap_or("Не удалось проверить")
            .into(),
        admin: v["admin"].as_bool().unwrap_or(false),
        os: v["os"].as_str().unwrap_or(std::env::consts::OS).into(),
    }
}
pub fn scan(data_dir: &Path) -> Result<Vec<Installed>, String> {
    let path = data_dir.join(format!("scan-{}.json", uuid::Uuid::new_v4()));
    let r = command("winget")
        .args(["export", "--output"])
        .arg(&path)
        .args([
            "--include-versions",
            "--source",
            "winget",
            "--accept-source-agreements",
            "--disable-interactivity",
        ])
        .output()
        .ok();
    let parsed = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok());
    let _ = std::fs::remove_file(&path);
    let winget_ok = r.is_some_and(|r| r.status.success()) && parsed.is_some();
    let catalog = catalog::apps();
    let mut installed = Vec::new();
    if let Some(sources) = parsed.as_ref().and_then(|p| p["Sources"].as_array()) {
        for source in sources {
            if let Some(packages) = source["Packages"].as_array() {
                for p in packages {
                    if let (Some(id), Some(version)) =
                        (p["PackageIdentifier"].as_str(), p["Version"].as_str())
                    {
                        installed.push(Installed {
                            package_id: canonical_package_id(id, &catalog).into(),
                            version: version.into(),
                            available_version: None,
                        });
                    }
                }
            }
        }
    }
    // Registry fallback detects apps that WinGet export cannot correlate with its source.
    let registry=powershell(r#"@(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName} | Select-Object DisplayName,DisplayVersion) | ConvertTo-Json -Compress"#).ok();
    if !winget_ok && registry.is_none() {
        return Err("Не удалось считать ни WinGet, ни реестр установленных программ".into());
    }
    for a in &catalog {
        let package = a["install"]["packageId"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| format!("appdock:{}", catalog::text(a, "id")));
        if installed
            .iter()
            .any(|i| i.package_id.eq_ignore_ascii_case(&package))
        {
            continue;
        }
        let detected = registry
            .as_ref()
            .and_then(Value::as_array)
            .and_then(|records| {
                records.iter().find(|r| {
                    let name = r["DisplayName"].as_str().unwrap_or("");
                    a["detection"]["displayNames"]
                        .as_array()
                        .is_some_and(|names| {
                            names.iter().any(|n| {
                                n.as_str()
                                    .is_some_and(|target| matches_display_name(name, target))
                            })
                        })
                })
            });
        if let Some(record) = detected {
            installed.push(Installed {
                package_id: package,
                version: record["DisplayVersion"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .unwrap_or("Версия не указана в реестре")
                    .into(),
                available_version: None,
            })
        }
    }
    // Use WinGet's live upgrade result, never a cached catalog version, for update badges.
    if let Ok(upgrades) = output(
        "winget",
        &[
            "list",
            "--upgrade-available",
            "--source",
            "winget",
            "--accept-source-agreements",
            "--disable-interactivity",
        ],
    ) {
        if upgrades.status.success() {
            let text = String::from_utf8_lossy(&upgrades.stdout);
            for app in &mut installed {
                for line in text.lines() {
                    let parts: Vec<_> = line.split_whitespace().collect();
                    if parts.iter().any(|p| {
                        canonical_package_id(p, &catalog).eq_ignore_ascii_case(&app.package_id)
                    }) {
                        let available = if parts
                            .last()
                            .is_some_and(|p| p.eq_ignore_ascii_case("winget"))
                        {
                            parts.get(parts.len().saturating_sub(2))
                        } else {
                            parts.last()
                        };
                        if let Some(v) = available {
                            if v.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                                app.available_version = Some((*v).into())
                            }
                        }
                    }
                }
            }
        }
    }
    // Server detection uses Windows services, separate from desktop clients and libraries.
    let services=powershell("@(Get-CimInstance Win32_Service | Select-Object Name,DisplayName) | ConvertTo-Json -Compress").unwrap_or(Value::Null);
    for (id, prefix) in [
        ("postgres", "postgresql"),
        ("mysql", "mysql"),
        ("mariadb", "mariadb"),
        ("mongodb", "mongodb"),
        ("sqlserver", "mssql"),
        ("oracle", "oracleservice"),
        ("neo4j", "neo4j"),
    ] {
        if services.as_array().is_some_and(|ss| {
            ss.iter().any(|s| {
                s["Name"]
                    .as_str()
                    .is_some_and(|n| n.to_lowercase().starts_with(prefix))
            })
        }) {
            installed.push(Installed {
                package_id: format!("appdock:{id}"),
                version: "Обнаружена служба; версию проверьте в мастере".into(),
                available_version: None,
            })
        }
    }
    Ok(installed)
}
// A product can change its preferred installer while retaining detection of
// the previous WinGet package (for example Chrome MSI -> versioned EXE).
fn canonical_package_id<'a>(id: &'a str, catalog: &'a [Value]) -> &'a str {
    catalog
        .iter()
        .find(|a| {
            a["detection"]["packageId"]
                .as_str()
                .is_some_and(|p| p.eq_ignore_ascii_case(id))
        })
        .and_then(|a| a["install"]["packageId"].as_str())
        .unwrap_or(id)
}
fn matches_display_name(name: &str, target: &str) -> bool {
    let name = name.to_lowercase();
    let target = target.to_lowercase();
    if name == target {
        return true;
    }
    if let Some(suffix) = name.strip_prefix(&target) {
        let tail = suffix.trim_start();
        return suffix.starts_with(' ')
            && tail
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit() || c == '(');
    }
    false
}
pub fn version_less(current: &str, target: &str) -> bool {
    let parse = |s: &str| -> Option<Vec<u64>> { s.split('.').map(|n| n.parse().ok()).collect() };
    match (parse(current), parse(target)) {
        (Some(a), Some(b)) => a < b,
        _ => false,
    }
}
pub fn port_available(port: u16) -> Result<bool, String> {
    if port == 0 {
        return Err("Порт должен быть от 1 до 65535".into());
    }
    match std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port)) {
        Ok(listener) => {
            drop(listener);
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}
pub fn desktop_dir() -> Result<PathBuf, String> {
    let d = powershell("[Environment]::GetFolderPath('Desktop') | ConvertTo-Json -Compress")?;
    d.as_str()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .ok_or_else(|| "Папка рабочего стола не определена".into())
}
pub fn code_command() -> Result<Command, String> {
    let mut paths = Vec::new();
    for env in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(p) = std::env::var_os(env) {
            let base = PathBuf::from(p);
            paths.push(base.join(if env == "LOCALAPPDATA" {
                "Programs/Microsoft VS Code"
            } else {
                "Microsoft VS Code"
            }));
        }
    }
    let root=paths.into_iter().find(|p|p.join("Code.exe").is_file()&&p.join("resources/app/out/cli.js").is_file()).ok_or("CLI VS Code не найден. Установите редактор для текущего пользователя и повторите расширение.")?;
    // Equivalent to the official code.cmd launcher, without a command shell.
    let mut cli = command(root.join("Code.exe"));
    cli.env("ELECTRON_RUN_AS_NODE", "1")
        .env_remove("VSCODE_DEV")
        .arg(root.join("resources/app/out/cli.js"));
    Ok(cli)
}
pub fn download_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("downloads")
}
pub fn vswhere() -> Result<PathBuf, String> {
    ["ProgramFiles(x86)", "ProgramFiles"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|p| PathBuf::from(p).join("Microsoft Visual Studio/Installer/vswhere.exe"))
        .find(|p| p.is_file())
        .ok_or_else(|| "vswhere не найден. Завершите установку Visual Studio Installer.".into())
}
pub fn vs_instance(edition: &str, components: &[String]) -> Result<Option<PathBuf>, String> {
    let product = match edition {
        "professional" => "Microsoft.VisualStudio.Product.Professional",
        "enterprise" => "Microsoft.VisualStudio.Product.Enterprise",
        _ => "Microsoft.VisualStudio.Product.Community",
    };
    let mut cmd = command(vswhere()?);
    cmd.args([
        "-latest",
        "-products",
        product,
        "-version",
        "[18.0,19.0)",
        "-property",
        "installationPath",
        "-utf8",
    ]);
    if !components.is_empty() {
        cmd.arg("-requires").args(components);
    }
    let result = cmd.output().map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err("Не удалось проверить компоненты через vswhere".into());
    }
    let path = String::from_utf8_lossy(&result.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.is_dir() || path.to_string_lossy().contains(['\r', '\n', '"']) {
        return Err("Путь Visual Studio не прошёл проверку".into());
    }
    Ok(Some(path))
}
pub fn pause_briefly() {
    std::thread::sleep(Duration::from_millis(150))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chrome_msi_detection_maps_to_preferred_exe_without_matching_other_channels() {
        let catalog = catalog::apps();
        assert_eq!(
            canonical_package_id("Google.Chrome", &catalog),
            "Google.Chrome.EXE"
        );
        assert_eq!(
            canonical_package_id("google.chrome", &catalog),
            "Google.Chrome.EXE"
        );
        assert_eq!(
            canonical_package_id("Google.Chrome.EXE", &catalog),
            "Google.Chrome.EXE"
        );
        assert_eq!(
            canonical_package_id("Google.Chrome.Beta", &catalog),
            "Google.Chrome.Beta"
        );
        assert_eq!(
            canonical_package_id("Microsoft.VisualStudioCode", &catalog),
            "Microsoft.VisualStudioCode"
        );
    }
    #[test]
    fn versions_do_not_guess_unknown_or_downgrade() {
        assert!(version_less("1.2.9", "1.2.10"));
        assert!(!version_less("2.0", "1.9"));
        assert!(!version_less("Unknown", "1.2"));
    }
    #[test]
    fn occupied_port_is_detected() {
        let listener = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
        assert!(!port_available(listener.local_addr().unwrap().port()).unwrap());
        assert!(port_available(0).is_err())
    }
    #[test]
    fn registry_does_not_confuse_helpers_with_apps() {
        assert!(matches_display_name("Google Chrome", "Google Chrome"));
        assert!(matches_display_name(
            "Mozilla Firefox (x64 ru)",
            "Mozilla Firefox"
        ));
        assert!(matches_display_name("PyCharm 2026.2", "PyCharm"));
        assert!(!matches_display_name(
            "Microsoft Edge Update",
            "Microsoft Edge"
        ));
        assert!(!matches_display_name(
            "Visual Studio Code Insiders",
            "Visual Studio Code"
        ));
    }
    #[test]
    #[ignore = "Read-only integration check requiring a real Windows session and WinGet"]
    fn live_readonly_windows_discovery() {
        let data = std::env::temp_dir().join(format!("appdock-discovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&data).unwrap();
        let system = info();
        assert!(system.windows);
        assert!(system.winget.is_some());
        assert!(system.free_disk_mb.is_some());
        let installed = scan(&data).unwrap();
        assert!(!installed.is_empty());
        println!(
            "Read-only discovery: {} records; WinGet {}; disk check available",
            installed.len(),
            system.winget.unwrap()
        );
        std::fs::remove_dir(&data).unwrap();
    }
}
