//! Executable adapters are compiled into the core, never supplied by an import.
use crate::{catalog, models::*, system};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub state: String,
    pub reason: String,
    pub next_step: String,
    pub version: Option<String>,
    pub checked_at: u64,
    pub can_launch: bool,
}
fn result(state: &str, reason: String, version: Option<String>, launch: bool) -> Readiness {
    Readiness { state: state.into(), reason, next_step: match state {
        "ready" => "Можно открыть программу. Новые терминалы получат актуальный PATH.",
        "action" => "Откройте новый терминал или официальный мастер, исправьте указанный компонент и повторите проверку.",
        _ => "Проверьте программу вручную; повторная проверка доступна без переустановки.",
    }.into(), version, checked_at: now(), can_launch: launch }
}
fn fresh_path() -> Result<Vec<PathBuf>, String> {
    let v=system::powershell("([Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')) | ConvertTo-Json -Compress")?;
    Ok(v.as_str()
        .unwrap_or("")
        .split(';')
        .filter(|p| !p.is_empty() && !p.to_lowercase().contains("windowsapps"))
        .map(PathBuf::from)
        .collect())
}
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
pub fn executable(id: &str) -> Result<PathBuf, String> {
    catalog::app(id)?;
    let (exe, suffixes): (&str, &[&str]) = match id {
        "python" => (
            "python.exe",
            &[
                "Programs/Python/Python312/python.exe",
                "Python312/python.exe",
            ],
        ),
        "git" => ("git.exe", &["Programs/Git/cmd/git.exe", "Git/cmd/git.exe"]),
        "vscode" => (
            "Code.exe",
            &[
                "Programs/Microsoft VS Code/Code.exe",
                "Microsoft VS Code/Code.exe",
            ],
        ),
        "nodejs" | "node" => ("node.exe", &["nodejs/node.exe"]),
        "chrome" => ("chrome.exe", &["Google/Chrome/Application/chrome.exe"]),
        "firefox" => ("firefox.exe", &["Mozilla Firefox/firefox.exe"]),
        _ => {
            return Err(
                "Для этого продукта нет надёжного адаптера проверки исполняемого файла".into(),
            )
        }
    };
    let mut paths = Vec::new();
    for key in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(key) {
            paths.extend(suffixes.iter().map(|s| PathBuf::from(&root).join(s)));
        }
    }
    // Refresh PATH from registry: AppDock may predate the installation.
    if let Ok(dirs) = fresh_path() {
        paths.extend(dirs.into_iter().map(|d| d.join(exe)));
    }
    paths
        .into_iter()
        .find(|p| p.is_absolute() && p.is_file())
        .ok_or_else(|| "Исполняемый файл не найден в стандартных папках и актуальном PATH".into())
}
fn output(mut cmd: std::process::Command, args: &[&str]) -> Result<String, String> {
    cmd.args(args);
    let out = system::bounded_output(&mut cmd, 20)?;
    if !out.status.success() {
        return Err(format!(
            "CLI завершился с кодом {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(500)
                .collect::<String>()
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Err("CLI не сообщил версию / результат".into());
    }
    Ok(text.chars().take(4000).collect())
}
pub fn check(s: &Selection) -> Readiness {
    if let Err(e) = catalog::validate(s) {
        return result("unknown", e, None, false);
    }
    let path = match executable(&s.app_id) {
        Ok(p) => p,
        Err(e) => return result("unknown", e, None, false),
    };
    let version = if s.app_id == "vscode" {
        system::code_command().and_then(|c| output(c, &["--version"]))
    } else if ["python", "git", "node", "nodejs"].contains(&s.app_id.as_str()) {
        output(system::command(&path), &["--version"])
    } else {
        system::powershell(&format!(
            "(Get-Item -LiteralPath {}).VersionInfo.FileVersion | ConvertTo-Json -Compress",
            quote(&path.to_string_lossy())
        ))
        .and_then(|v| {
            v.as_str()
                .filter(|s| !s.is_empty())
                .map(String::from)
                .ok_or("Версия файла недоступна".into())
        })
    };
    let version = match version {
        Ok(v) => v,
        Err(e) => return result("unknown", e, None, false),
    };
    let version = version.lines().next().unwrap_or("").to_string();
    if s.app_id == "python" && !version.starts_with("Python ")
        || s.app_id == "git" && !version.starts_with("git version ")
    {
        return result(
            "unknown",
            "CLI вернул неожиданный формат версии".into(),
            Some(version),
            false,
        );
    }
    if s.app_id == "python" {
        match output(system::command(&path), &["-m", "pip", "--version"]) {
            Ok(pip) if pip.starts_with("pip ") => (),
            r => {
                return result(
                    "action",
                    format!(
                        "Python запускается; pip не подтверждён: {}",
                        r.err().unwrap_or_else(|| "неожиданный ответ CLI".into())
                    ),
                    Some(version),
                    false,
                )
            }
        }
    }
    if s.app_id == "vscode" && !s.extensions.is_empty() {
        match system::code_command().and_then(|c| output(c, &["--list-extensions"])) {
            Ok(list) => {
                let missing: Vec<_> = s
                    .extensions
                    .iter()
                    .filter(|id| !list.lines().any(|l| l.trim().eq_ignore_ascii_case(id)))
                    .collect();
                if !missing.is_empty() {
                    return result(
                        "action",
                        format!("CLI работает; отсутствуют расширения: {missing:?}"),
                        Some(version),
                        false,
                    );
                }
            }
            Err(e) => return result("unknown", e, Some(version), false),
        }
    }
    if ["python", "git"].contains(&s.app_id.as_str()) {
        match fresh_path(){
            Ok(dirs) if dirs.iter().any(|d|matches!((d.canonicalize().ok(),path.parent().and_then(|p|p.canonicalize().ok())),(Some(a),Some(b)) if a==b))=>(),
            Ok(_)=>return result("action","Исполняемый файл запускается напрямую, но его папка отсутствует в актуальном PATH Windows. Добавьте программу в PATH через официальный мастер; затем откройте новый терминал и повторите проверку.".into(),Some(version),false),
            Err(e)=>return result("unknown",format!("CLI работает; актуальный PATH не удалось проверить: {e}"),Some(version),false),
        }
    }
    let can_launch = s.app_id != "git"
        || path
            .parent()
            .and_then(Path::parent)
            .is_some_and(|p| p.join("git-bash.exe").is_file());
    result(
        "ready",
        format!(
            "Проверены {} и версия{}",
            path.display(),
            if s.app_id == "python" {
                "; pip доступен"
            } else {
                ""
            }
        ),
        Some(version),
        can_launch,
    )
}
pub fn launch(s: &Selection) -> Result<(), String> {
    let checked = check(s);
    if checked.state != "ready" || !checked.can_launch {
        return Err(checked.reason);
    }
    let path = executable(&s.app_id)?;
    // CLI tools open in a terminal, without interpolating any user command.
    if s.app_id == "git" {
        system::command(
            path.parent()
                .and_then(Path::parent)
                .ok_or("Git Bash не найден")?
                .join("git-bash.exe"),
        )
        .spawn()
        .map_err(|e| e.to_string())?;
    } else if ["python", "node", "nodejs"].contains(&s.app_id.as_str()) {
        let mut command = std::process::Command::new(path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x00000010);
        }
        command.spawn().map_err(|e| e.to_string())?;
    } else {
        system::command(path).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_or_injected_adapters_cannot_claim_readiness() {
        let mut s = Selection {
            app_id: "cmd.exe".into(),
            action: "install".into(),
            options: Default::default(),
            extensions: vec![],
            version: None,
        };
        assert_eq!(check(&s).state, "unknown");
        s.app_id = "word".into();
        s.action = "download".into();
        assert_eq!(check(&s).state, "unknown");
        assert!(!check(&s).can_launch);
    }
    #[test]
    #[ignore = "Read-only checks of locally installed CLI adapters; never installs software"]
    fn live_readonly_adapters() {
        for id in ["python", "git", "vscode"] {
            let s = Selection {
                app_id: id.into(),
                action: "install".into(),
                options: Default::default(),
                extensions: vec![],
                version: None,
            };
            let r = check(&s);
            println!("{id}: {} — {} — {:?}", r.state, r.reason, r.version);
            assert!(r.checked_at > 0);
            assert!(!r.can_launch || r.state == "ready");
        }
    }
}
