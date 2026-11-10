use crate::{catalog, managed, models::now, readiness, system};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
const COMPONENTS: &[&str] = &[
    "vscode-settings",
    "vscode-keys",
    "vscode-extensions",
    "git",
    "terminal",
];
const CODE_KEYS: &[&str] = &[
    "editor.fontSize",
    "editor.fontFamily",
    "editor.tabSize",
    "editor.insertSpaces",
    "editor.wordWrap",
    "editor.renderWhitespace",
    "editor.minimap.enabled",
    "files.autoSave",
    "files.trimTrailingWhitespace",
    "workbench.colorTheme",
    "workbench.iconTheme",
    "window.zoomLevel",
];
const COMMANDS: &[&str] = &[
    "editor.action.formatDocument",
    "editor.action.commentLine",
    "editor.action.copyLinesDownAction",
    "workbench.action.files.save",
    "workbench.action.showCommands",
    "undo",
    "redo",
    "editor.action.clipboardCopyAction",
    "editor.action.clipboardPasteAction",
];
const GIT: &[&str] = &[
    "core.autocrlf",
    "core.safecrlf",
    "init.defaultbranch",
    "pull.rebase",
    "fetch.prune",
    "color.ui",
    "merge.ff",
];
#[cfg(test)]
thread_local! {static TEST_PROFILE:std::cell::RefCell<Option<PathBuf>>=const{std::cell::RefCell::new(None)};}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transfer {
    schema_version: u32,
    components: std::collections::BTreeMap<String, Value>,
    exclusions: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    created_at: u64,
    transfer: Transfer,
    hashes: std::collections::BTreeMap<String, String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Backup {
    id: String,
    files: Vec<BackupFile>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFile {
    component: String,
    existed: bool,
    after_hash: String,
}
fn path(component: &str) -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(root) = TEST_PROFILE.with(|p| p.borrow().clone()) {
        if COMPONENTS.contains(&component) {
            return Ok(root.join(component));
        }
    }
    let roaming = std::env::var_os("APPDATA").ok_or("APPDATA недоступен")?;
    let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA недоступен")?;
    Ok(match component {
        "vscode-settings" => PathBuf::from(&roaming).join("Code/User/settings.json"),
        "vscode-keys" => PathBuf::from(&roaming).join("Code/User/keybindings.json"),
        "git" => {
            let profile =
                PathBuf::from(std::env::var_os("USERPROFILE").ok_or("USERPROFILE недоступен")?);
            if std::env::var_os("GIT_CONFIG_GLOBAL").is_some()
                || std::env::var_os("HOME").is_some_and(|h| {
                    PathBuf::from(h).canonicalize().ok() != profile.canonicalize().ok()
                })
            {
                return Err("Git использует переназначенный HOME / GIT_CONFIG_GLOBAL. Этот профиль требует ручного переноса; стандартный .gitconfig изменяться не будет.".into());
            }
            profile.join(".gitconfig")
        }
        "terminal" => {
            let candidates = [
                PathBuf::from(&local).join(
                    "Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json",
                ),
                PathBuf::from(&local).join("Microsoft/Windows Terminal/settings.json"),
            ];
            candidates
                .into_iter()
                .find(|p| p.is_file())
                .ok_or("Настройки Windows Terminal не найдены; сначала запустите Terminal")?
        }
        _ => return Err("Неизвестный компонент".into()),
    })
}
fn app_available(c: &str) -> bool {
    #[cfg(test)]
    if TEST_PROFILE.with(|p| p.borrow().is_some()) {
        return path(c).is_ok_and(|p| p.exists());
    }
    match c {
        "git" => path(c).is_ok() && readiness::executable("git").is_ok(),
        c if c.starts_with("vscode") => system::code_command().is_ok(),
        "terminal" => path(c).is_ok(),
        _ => false,
    }
}
fn text_json(p: &Path) -> Result<Value, String> {
    if !p.exists() {
        return Ok(json!({}));
    }
    let raw = managed::read(p, 2_000_000)?;
    json5::from_str(
        std::str::from_utf8(&raw)
            .map_err(|e| e.to_string())?
            .trim_start_matches('\u{feff}'),
    )
    .map_err(|e| format!("Некорректный JSONC: {e}"))
}
fn safe_scalar(v: &Value) -> bool {
    match v {
        Value::Bool(_) => true,
        Value::Number(n) => n
            .as_f64()
            .is_some_and(|n| n.is_finite() && n.abs() <= 10000.0),
        Value::String(s) => {
            s.len() <= 200
                && !s.contains(['\n', '\r', '\0', ':', '\\', '/'])
                && !s.to_lowercase().contains("token")
        }
        _ => false,
    }
}
fn code_value(k: &str, v: &Value) -> bool {
    match k {
        "editor.fontSize" => v.as_f64().is_some_and(|n| (6.0..=100.0).contains(&n)),
        "editor.tabSize" => v.as_u64().is_some_and(|n| (1..=16).contains(&n)),
        "window.zoomLevel" => v.as_f64().is_some_and(|n| (-8.0..=9.0).contains(&n)),
        "editor.insertSpaces" | "editor.minimap.enabled" | "files.trimTrailingWhitespace" => {
            v.is_boolean()
        }
        "editor.wordWrap" => v
            .as_str()
            .is_some_and(|s| ["off", "on", "wordWrapColumn", "bounded"].contains(&s)),
        "editor.renderWhitespace" => v
            .as_str()
            .is_some_and(|s| ["none", "boundary", "selection", "trailing", "all"].contains(&s)),
        "files.autoSave" => v
            .as_str()
            .is_some_and(|s| ["off", "afterDelay", "onFocusChange", "onWindowChange"].contains(&s)),
        "editor.fontFamily" | "workbench.colorTheme" | "workbench.iconTheme" => {
            v.is_string() && safe_scalar(v)
        }
        _ => false,
    }
}
fn keybinding(v: &Value) -> bool {
    let Some(key) = v["key"].as_str() else {
        return false;
    };
    let key = key.to_lowercase();
    if key.is_empty()
        || key.len() > 100
        || !key.split_whitespace().all(|chord| {
            chord.split('+').all(|k| {
                k.len() == 1 && k.bytes().all(|b| b.is_ascii_alphanumeric())
                    || [
                        "ctrl",
                        "alt",
                        "shift",
                        "win",
                        "enter",
                        "escape",
                        "tab",
                        "space",
                        "backspace",
                        "delete",
                        "up",
                        "down",
                        "left",
                        "right",
                        "home",
                        "end",
                        "pageup",
                        "pagedown",
                    ]
                    .contains(&k)
                    || k.strip_prefix('f')
                        .and_then(|n| n.parse::<u8>().ok())
                        .is_some_and(|n| (1..=24).contains(&n))
            })
        })
    {
        return false;
    }
    v.get("when").is_none_or(|w| {
        w.as_str().is_some_and(|s| {
            s.split("&&").all(|t| {
                [
                    "editorTextFocus",
                    "editorHasSelection",
                    "textInputFocus",
                    "!editorReadonly",
                    "editorFocus",
                ]
                .contains(&t.trim())
            })
        })
    })
}
fn git_value(k: &str, v: &Value) -> bool {
    let Some(s) = v.as_str() else {
        return false;
    };
    match k {
        "core.autocrlf" => ["true", "false", "input"].contains(&s),
        "core.safecrlf" => ["true", "false", "warn"].contains(&s),
        "pull.rebase" => ["true", "false", "merges", "interactive"].contains(&s),
        "fetch.prune" => ["true", "false"].contains(&s),
        "color.ui" => ["true", "false", "auto", "always", "never"].contains(&s),
        "merge.ff" => ["true", "false", "only"].contains(&s),
        "init.defaultbranch" => {
            !s.is_empty()
                && s.len() <= 80
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        }
        _ => false,
    }
}
fn terminal_value(k: &str, v: &Value) -> bool {
    match k {
        "theme" => v
            .as_str()
            .is_some_and(|s| ["system", "dark", "light"].contains(&s)),
        "copyOnSelect" | "alwaysShowTabs" => v.is_boolean(),
        "name" | "colorScheme" | "face" => v.is_string() && safe_scalar(v),
        "historySize" => v.as_u64().is_some_and(|n| n <= 32767),
        "size" => v.as_f64().is_some_and(|n| (6.0..=100.0).contains(&n)),
        "weight" => {
            v.as_u64().is_some_and(|n| (100..=1000).contains(&n))
                || v.as_str().is_some_and(|s| {
                    [
                        "normal",
                        "bold",
                        "semi-bold",
                        "light",
                        "extra-light",
                        "medium",
                        "black",
                        "thin",
                        "extra-bold",
                    ]
                    .contains(&s)
                })
        }
        _ => false,
    }
}
fn filter(c: &str, v: &Value, excluded: &mut Vec<String>) -> Value {
    match c {
        "vscode-settings"=>{
            let mut out=json!({}); if let Some(obj)=v.as_object(){for(k,v)in obj{if CODE_KEYS.contains(&k.as_str())&&code_value(k,v){out[k]=v.clone();}else{excluded.push(format!("VS Code: исключён параметр {} (вне безопасного списка или неверный тип)",k.chars().take(100).collect::<String>()));}}}out
        }
        "vscode-keys"=>Value::Array(v.as_array().into_iter().flatten().filter_map(|b| {
            let valid=b.as_object().is_some_and(|o|o.keys().all(|k|["key","command","when"].contains(&k.as_str())))&&b["command"].as_str().is_some_and(|s|COMMANDS.contains(&s))&&keybinding(b);
            if valid {Some(b.clone())}else{excluded.push("VS Code: сочетание с аргументами / неподдерживаемой командой исключено".into());None}
        }).collect()),
        "vscode-extensions"=>Value::Array(v.as_array().into_iter().flatten().filter_map(|v| {if catalog::extensions().iter().any(|e|e["id"]==*v){Some(v.clone())}else{excluded.push("Расширение вне доверенного каталога исключено".into());None}}).collect()),
        "git"=>{let mut out=json!({});if let Some(o)=v.as_object(){for(k,v)in o{if GIT.contains(&k.as_str())&&git_value(k,v){out[k]=v.clone();}else{excluded.push(format!("Git: {k} исключён (небезопасный или неподдерживаемый параметр)"));}}}out},
        "terminal"=>{
            let mut out=json!({});for k in ["theme","copyOnSelect","alwaysShowTabs"]{if v.get(k).is_some_and(|v|terminal_value(k,v)){out[k]=v[k].clone();}}
            let mut profiles=vec![];
            for p in v["profiles"]["list"].as_array().into_iter().flatten(){
                let Some(guid)=p["guid"].as_str().filter(|s|uuid::Uuid::parse_str(s.trim_matches(['{','}'])).is_ok())else{continue;};
                let mut clean=json!({"guid":guid}); for k in ["name","colorScheme","historySize","font"]{
                    if k=="font"{for f in ["face","size","weight"]{if p[k].get(f).is_some_and(|v|terminal_value(f,v)){if clean[k].is_null(){clean[k]=json!({});}clean[k][f]=p[k][f].clone();}}}
                    else if p.get(k).is_some_and(|v|terminal_value(k,v)){clean[k]=p[k].clone();}
                }profiles.push(clean);
            }
            out["profiles"]=json!({"list":profiles});excluded.push("Terminal: commandline, startingDirectory, source, actions, env, схемы цветов и пути исключены; переносятся только параметры внешнего вида профилей".into());out
        }
        _=>Value::Null,
    }
}
fn current(c: &str) -> Result<Value, String> {
    if c == "git" {
        path(c)?;
        let exe = readiness::executable("git")?;
        let mut out = json!({});
        for k in GIT {
            let r = system::bounded_output(
                system::command(&exe).args(["config", "--global", "--get", k]),
                15,
            )?;
            if r.status.success() {
                out[*k] = Value::String(String::from_utf8_lossy(&r.stdout).trim().into());
            }
        }
        return Ok(out);
    }
    if c == "vscode-extensions" {
        let r = system::bounded_output(system::code_command()?.arg("--list-extensions"), 20)?;
        if !r.status.success() {
            return Err("CLI не прочитал расширения".into());
        }
        return Ok(json!(String::from_utf8_lossy(&r.stdout)
            .lines()
            .map(str::trim)
            .collect::<Vec<_>>()));
    }
    text_json(&path(c)?)
}
pub fn export(components: &[String]) -> Result<Transfer, String> {
    if components.iter().any(|c| !COMPONENTS.contains(&c.as_str())) {
        return Err("Неизвестный компонент".into());
    }
    let mut transfer=Transfer{schema_version:1,components:Default::default(),exclusions:vec!["Пароли, токены, SSH, учётные данные, Git user/include/alias/helpers/hooks и настройки расширений вне безопасного списка не переносятся".into()]};
    for c in components {
        match current(c) {
            Ok(v) => {
                transfer
                    .components
                    .insert(c.clone(), filter(c, &v, &mut transfer.exclusions));
            }
            Err(e) => transfer.exclusions.push(format!("{c}: {e}")),
        }
    }
    Ok(transfer)
}
fn parse(raw: &str) -> Result<Transfer, String> {
    if raw.len() > 2_000_000 {
        return Err("Файл переноса больше 2 МБ".into());
    }
    let mut t: Transfer = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if t.schema_version != 1
        || t.components
            .keys()
            .any(|c| !COMPONENTS.contains(&c.as_str()))
    {
        return Err("Неподдерживаемый формат переноса".into());
    }
    t.exclusions.clear();
    for (c, v) in &mut t.components {
        *v = filter(c, v, &mut t.exclusions);
    }
    Ok(t)
}
fn fingerprint(c: &str) -> Result<String, String> {
    let p = path(c)?;
    if p.exists() {
        managed::hash(&p)
    } else {
        Ok("absent".into())
    }
}
pub fn preview(data: &Path, raw: &str) -> Result<Value, String> {
    let transfer = parse(raw)?;
    let mut rows = vec![];
    let mut hashes = std::collections::BTreeMap::new();
    for (c, v) in &transfer.components {
        let available = app_available(c);
        let existing = if available {
            current(c).map(|v| filter(c, &v, &mut vec![]))?
        } else {
            Value::Null
        };
        if available && c != "vscode-extensions" {
            hashes.insert(c.clone(), fingerprint(c)?);
        }
        rows.push(json!({"component":c,"available":available,"before":existing,"after":v,"conflict":!existing.is_null()&&existing!=*v,"reason":if available{String::new()}else{path(c).err().unwrap_or_else(||"Приложение или его профиль не найдены; компонент будет пропущен".into())}}));
    }
    let token = uuid::Uuid::new_v4().to_string();
    std::fs::create_dir_all(data.join("transfer-previews")).map_err(|e| e.to_string())?;
    managed::json(
        &data.join("transfer-previews").join(format!("{token}.json")),
        &Pending {
            created_at: now(),
            transfer: transfer.clone(),
            hashes,
        },
    )?;
    Ok(json!({"token":token,"rows":rows,"exclusions":transfer.exclusions}))
}
fn merge(c: &str, mut old: Value, new: &Value) -> Value {
    if c == "vscode-keys" {
        let mut bindings = old.as_array().cloned().unwrap_or_default();
        for b in new.as_array().into_iter().flatten() {
            bindings.retain(|o| o["key"] != b["key"] || o.get("when") != b.get("when"));
            bindings.push(b.clone());
        }
        return Value::Array(bindings);
    }
    if !old.is_object() {
        old = json!({});
    }
    if c == "terminal" {
        for k in ["theme", "copyOnSelect", "alwaysShowTabs"] {
            if let Some(v) = new.get(k) {
                old[k] = v.clone();
            }
        }
        if !old["profiles"].is_object() {
            old["profiles"] = json!({});
        }
        if !old["profiles"]["list"].is_array() {
            old["profiles"]["list"] = json!([]);
        }
        for p in new["profiles"]["list"].as_array().into_iter().flatten() {
            let list = old["profiles"]["list"].as_array_mut().unwrap();
            if let Some(found) = list.iter_mut().find(|o| o["guid"] == p["guid"]) {
                for (k, v) in p.as_object().unwrap() {
                    if k == "font" {
                        if !found[k].is_object() {
                            found[k] = json!({});
                        }
                        for (f, value) in v.as_object().into_iter().flatten() {
                            found[k][f] = value.clone();
                        }
                    } else {
                        found[k] = v.clone();
                    }
                }
            } else {
                list.push(p.clone());
            }
        }
        return old;
    }
    for (k, v) in new.as_object().into_iter().flatten() {
        old[k] = v.clone();
    }
    old
}
pub fn apply(data: &Path, token: &str, chosen: &[String]) -> Result<Value, String> {
    uuid::Uuid::parse_str(token).map_err(|_| "Неверный токен переноса")?;
    let pending_path = data.join("transfer-previews").join(format!("{token}.json"));
    let pending: Pending = serde_json::from_slice(&managed::read(&pending_path, 3_000_000)?)
        .map_err(|e| e.to_string())?;
    if now().saturating_sub(pending.created_at) > 600_000 {
        return Err("Предпросмотр устарел; откройте его заново".into());
    }
    // Validate every target before writing any file.
    for c in chosen {
        if c == "vscode-extensions" {
            continue;
        }
        if !pending.transfer.components.contains_key(c)
            || pending.hashes.get(c) != Some(&fingerprint(c)?)
        {
            return Err(format!(
                "{c}: файл изменился после предпросмотра; обновите сравнение"
            ));
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let root = data.join("settings-backups").join(&id);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut backup = Backup {
        id: id.clone(),
        files: vec![],
    };
    for c in chosen.iter().filter(|c| c.as_str() != "vscode-extensions") {
        let target = path(c)?;
        let existed = target.is_file();
        if existed {
            managed::atomic(&root.join(c), &managed::read(&target, 2_000_000)?)?;
        }
        backup.files.push(BackupFile {
            component: c.clone(),
            existed,
            after_hash: pending.hashes[c].clone(),
        });
    }
    managed::json(&root.join("backup.json"), &backup)?;
    let operation = (|| -> Result<(), String> {
        for c in chosen.iter().filter(|c| c.as_str() != "vscode-extensions") {
            let target = path(c)?;
            std::fs::create_dir_all(target.parent().ok_or("Нет папки профиля")?)
                .map_err(|e| e.to_string())?;
            if c == "git" {
                let temp = root.join("git-next");
                if target.exists() {
                    std::fs::copy(&target, &temp).map_err(|e| e.to_string())?;
                } else {
                    std::fs::write(&temp, b"").map_err(|e| e.to_string())?;
                }
                for (k, v) in pending.transfer.components[c]
                    .as_object()
                    .into_iter()
                    .flatten()
                {
                    let out = system::bounded_output(
                        system::command(readiness::executable("git")?)
                            .arg("config")
                            .arg("--file")
                            .arg(&temp)
                            .arg("--")
                            .arg(k)
                            .arg(v.as_str().ok_or("Неверное значение Git")?),
                        15,
                    )?;
                    if !out.status.success() {
                        return Err("Git не смог изменить безопасный параметр".into());
                    }
                }
                managed::atomic(&target, &managed::read(&temp, 2_000_000)?)?;
            } else {
                let value = merge(c, text_json(&target)?, &pending.transfer.components[c]);
                managed::json(&target, &value)?;
            }
            if let Some(f) = backup.files.iter_mut().find(|f| f.component == *c) {
                f.after_hash = managed::hash(&target)?;
            }
            managed::json(&root.join("backup.json"), &backup)?;
        }
        Ok(())
    })();
    if let Err(e) = operation {
        for f in &backup.files {
            let p = path(&f.component)?;
            if f.existed {
                managed::atomic(&p, &managed::read(&root.join(&f.component), 2_000_000)?)?;
            } else if p.exists() {
                std::fs::remove_file(&p).map_err(|e| e.to_string())?;
            }
        }
        return Err(format!(
            "Перенос отменён, исходные файлы восстановлены: {e}"
        ));
    }
    let _ = std::fs::remove_file(pending_path);
    Ok(
        json!({"backupId":id,"extensions":if chosen.iter().any(|c|c=="vscode-extensions"){pending.transfer.components.get("vscode-extensions").cloned().unwrap_or(json!([]))}else{json!([])},"message":"Файлы сохранены с резервной копией. Расширения устанавливаются отдельно через просмотр плана очереди."}),
    )
}
pub fn backups(data: &Path) -> Result<Value, String> {
    let root = data.join("settings-backups");
    let mut ids = vec![];
    if root.exists() {
        for e in std::fs::read_dir(root)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            if e.path().join("backup.json").is_file() {
                ids.push(e.file_name().to_string_lossy().to_string());
            }
        }
    }
    Ok(json!(ids))
}
pub fn restore(data: &Path, id: &str) -> Result<Value, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Неверный ID копии")?;
    let root = data.join("settings-backups").join(id);
    let b: Backup = serde_json::from_slice(&managed::read(&root.join("backup.json"), 100_000)?)
        .map_err(|e| e.to_string())?;
    for f in &b.files {
        if fingerprint(&f.component)? != f.after_hash {
            return Err("Файл изменился после переноса. Восстановление остановлено, чтобы сохранить новые изменения; используйте резервную копию вручную.".into());
        }
    }
    for f in b.files {
        let p = path(&f.component)?;
        if f.existed {
            managed::atomic(&p, &managed::read(&root.join(&f.component), 2_000_000)?)?;
        } else if p.exists() {
            std::fs::remove_file(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(
        json!({"message":"Исходные файлы восстановлены; повторное восстановление этой копии недоступно после изменения файлов"}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secrets_and_executable_preferences_are_excluded() {
        let mut e = vec![];
        let v = filter(
            "git",
            &json!({"credential.helper":"!steal","core.sshCommand":"evil","core.autocrlf":"true","init.defaultbranch":"main"}),
            &mut e,
        );
        assert_eq!(
            v,
            json!({"core.autocrlf":"true","init.defaultbranch":"main"})
        );
        assert_eq!(e.len(), 2);
        assert_eq!(
            filter(
                "vscode-keys",
                &json!([{"key":"ctrl+x","command":"workbench.action.terminal.sendSequence","args":{"text":"evil"}}]),
                &mut e
            ),
            json!([])
        );
        let terminal = filter(
            "terminal",
            &json!({"profiles":{"list":[{"guid":"{11111111-1111-1111-1111-111111111111}","name":"Shell","commandline":"evil","startingDirectory":"secret","font":{"size":14}}]}}),
            &mut e,
        );
        assert!(terminal["profiles"]["list"][0].get("commandline").is_none());
    }
    #[test]
    fn merge_keeps_local_secrets_and_resolves_keys() {
        let old = json!({"token":"local","editor.fontSize":12});
        let new = json!({"editor.fontSize":16});
        assert_eq!(
            merge("vscode-settings", old, &new),
            json!({"token":"local","editor.fontSize":16})
        );
        let old = json!([{"key":"ctrl+s","command":"old"},{"key":"ctrl+k","command":"keep"}]);
        assert_eq!(
            merge(
                "vscode-keys",
                old,
                &json!([{"key":"ctrl+s","command":"new"}])
            )
            .as_array()
            .unwrap()
            .len(),
            2
        );
    }
    #[test]
    fn real_files_preview_conflict_backup_and_restore() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let data = root.join("data");
        std::fs::create_dir(&data).unwrap();
        TEST_PROFILE.with(|p| *p.borrow_mut() = Some(root.clone()));
        let target = root.join("vscode-settings");
        let original =
            b"{ // local comment\n\"editor.fontSize\":12,\"private.token\":\"local-only\",}\n";
        std::fs::write(&target, original).unwrap();
        let raw=json!({"schemaVersion":1,"components":{"vscode-settings":{"editor.fontSize":18,"private.token":"foreign-secret"}},"exclusions":[]}).to_string();
        let p = preview(&data, &raw).unwrap();
        assert_eq!(p["rows"][0]["conflict"], true);
        assert_eq!(std::fs::read(&target).unwrap(), original);
        let r = apply(
            &data,
            p["token"].as_str().unwrap(),
            &["vscode-settings".into()],
        )
        .unwrap();
        let changed = text_json(&target).unwrap();
        assert_eq!(changed["editor.fontSize"], 18);
        assert_eq!(changed["private.token"], "local-only");
        restore(&data, r["backupId"].as_str().unwrap()).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), original);
        let p = preview(&data, &raw).unwrap();
        std::fs::write(&target, b"{\"editor.fontSize\":22}").unwrap();
        assert!(apply(
            &data,
            p["token"].as_str().unwrap(),
            &["vscode-settings".into()]
        )
        .unwrap_err()
        .contains("изменился"));
        let p = preview(&data, &raw).unwrap();
        let r = apply(
            &data,
            p["token"].as_str().unwrap(),
            &["vscode-settings".into()],
        )
        .unwrap();
        std::fs::write(&target, b"{\"editor.fontSize\":24}").unwrap();
        assert!(restore(&data, r["backupId"].as_str().unwrap()).is_err());
        assert_eq!(text_json(&target).unwrap()["editor.fontSize"], 24);
        TEST_PROFILE.with(|p| *p.borrow_mut() = None);
        std::fs::remove_dir_all(root).unwrap();
    }
}
