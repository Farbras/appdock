use crate::models::Selection;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;
fn bundled_apps() -> &'static Vec<Value> {
    static APPS: OnceLock<Vec<Value>> = OnceLock::new();
    APPS.get_or_init(|| {
        serde_json::from_str(include_str!("../../catalog/apps.json"))
            .expect("Invalid bundled catalog")
    })
}
pub fn apps() -> Vec<Value> {
    active().read().unwrap_or_else(|e| e.into_inner()).clone()
}
pub fn bundled() -> Vec<Value> {
    bundled_apps().clone()
}
fn active() -> &'static std::sync::RwLock<Vec<Value>> {
    static ACTIVE: OnceLock<std::sync::RwLock<Vec<Value>>> = OnceLock::new();
    ACTIVE.get_or_init(|| std::sync::RwLock::new(bundled()))
}
pub fn activate(apps: Vec<Value>) {
    *active().write().unwrap_or_else(|e| e.into_inner()) = apps;
}
pub fn extensions() -> Vec<Value> {
    serde_json::from_str(include_str!("../../catalog/extensions.json"))
        .expect("Invalid extension catalog")
}
pub fn app(id: &str) -> Result<Value, String> {
    apps()
        .iter()
        .find(|a| a["id"] == id)
        .cloned()
        .ok_or_else(|| "Программа отсутствует в доверенном каталоге".into())
}
pub fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn direct_download_url(a: &Value) -> Option<&str> {
    (a["install"]["download"] == true)
        .then(|| a["install"]["downloadUrl"].as_str())
        .flatten()
}
pub fn allowed_actions(a: &Value) -> Vec<&'static str> {
    if ["web", "cloud"].contains(&text(a, "type")) {
        return vec!["open", "shortcut"];
    }
    if !a["platforms"]
        .as_array()
        .is_some_and(|p| p.iter().any(|v| v == "windows"))
    {
        return vec!["guide"];
    }
    let mut actions = Vec::new();
    if a["install"]["method"] == "winget" && a["install"]["verification"] == "verified" {
        actions.push("install");
    }
    if a["install"]["download"] == true {
        actions.push("download");
    }
    actions.push("guide");
    actions
}
pub fn validate(s: &Selection) -> Result<Value, String> {
    let a = app(&s.app_id)?;
    if !["install", "download", "open", "shortcut", "guide"].contains(&s.action.as_str()) {
        return Err("Недопустимое действие".into());
    }
    if !allowed_actions(&a).contains(&s.action.as_str()) {
        return Err("Действие не поддерживается этим продуктом. Измените параметры.".into());
    }
    if s.extensions.len() > 8 {
        return Err("Слишком много расширений".into());
    }
    if s.version
        .as_deref()
        .is_some_and(|v| v != text(&a, "version"))
    {
        return Err("Запрошенная версия не проверена в каталоге".into());
    }
    for (key, val) in &s.options {
        let extra = (key == "edition"
            && a["editions"]
                .as_array()
                .is_some_and(|e| e.iter().any(|e| e["id"] == *val)))
            || (key == "fullProfile" && s.app_id == "visual-studio" && val.is_boolean());
        let opt = a["options"]
            .as_array()
            .and_then(|opts| opts.iter().find(|o| o["id"] == *key));
        if extra {
            continue;
        }
        let Some(o) = opt else {
            return Err(format!("Неподдерживаемый параметр: {key}"));
        };
        let valid = match text(o, "type") {
            "boolean" => val.is_boolean(),
            "number" => val.as_u64().is_some_and(|n| n > 0 && n <= 65535),
            _ => val
                .as_str()
                .is_some_and(|v| v.len() <= 500 && !v.contains(['\n', '\r', '\0'])),
        };
        if !valid {
            return Err(format!("Неверное значение параметра: {key}"));
        }
        if let Some(values) = o["values"].as_array() {
            if !values.contains(val) {
                return Err("Значение отсутствует в разрешённом списке".into());
            }
        }
    }
    let all = extensions();
    let ids: HashSet<_> = s.extensions.iter().map(String::as_str).collect();
    for id in &s.extensions {
        if s.app_id != "vscode" {
            return Err("Расширения доступны только для VS Code".into());
        }
        let Some(e) = all.iter().find(|e| e["id"] == *id) else {
            return Err("Неизвестное расширение".into());
        };
        if e["verifiedAt"].is_null() {
            return Err("Расширение не проверено".into());
        }
        if let Some(deps) = e["dependencies"].as_array() {
            for dep in deps {
                if !ids.contains(dep.as_str().unwrap_or("")) {
                    return Err("Не выбрана зависимость расширения".into());
                }
            }
        }
    }
    if ["open", "shortcut"].contains(&s.action.as_str())
        && !["web", "cloud"].contains(&text(&a, "type"))
    {
        return Err("Веб-действие не поддерживается этим продуктом".into());
    }
    if s.action == "download" && a["install"]["download"] != true {
        return Err("Отдельная загрузка не подтверждена".into());
    }
    Ok(a)
}
pub fn package_id(a: &Value, s: &Selection) -> Result<String, String> {
    if a["install"]["method"] != "winget" || a["install"]["verification"] != "verified" {
        return Err("Автоматическая установка не проверена. Откройте официальный источник.".into());
    }
    if let Some(ed) = s.options.get("edition").and_then(Value::as_str) {
        if let Some(e) = a["editions"]
            .as_array()
            .and_then(|eds| eds.iter().find(|e| e["id"] == ed))
        {
            if let Some(id) = e["packageId"].as_str() {
                if e["verified"] != true {
                    return Err("Пакет редакции не проверен".into());
                }
                return Ok(id.into());
            }
        }
    }
    Ok(a["install"]["packageId"]
        .as_str()
        .ok_or("Отсутствует ID пакета")?
        .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn selection(id: &str) -> Selection {
        Selection {
            app_id: id.into(),
            action: "install".into(),
            options: Default::default(),
            extensions: vec![],
            version: None,
        }
    }
    #[test]
    fn catalog_actions_are_validated_without_silent_substitution() {
        assert_eq!(
            allowed_actions(&app("word").unwrap()),
            vec!["download", "guide"]
        );
        assert_eq!(
            allowed_actions(&app("google-docs").unwrap()),
            vec!["open", "shortcut"]
        );
        for a in apps() {
            for action in ["install", "download", "open", "shortcut", "guide"] {
                let mut s = selection(text(&a, "id"));
                s.action = action.into();
                assert_eq!(
                    validate(&s).is_ok(),
                    allowed_actions(&a).contains(&action),
                    "{} {action}",
                    s.app_id
                );
            }
        }
    }
    #[test]
    fn catalog_has_83_distinct_products() {
        let a = apps();
        assert_eq!(a.len(), 83);
        assert_eq!(
            a.iter()
                .map(|a| text(a, "id"))
                .collect::<HashSet<_>>()
                .len(),
            a.len()
        )
    }
    #[test]
    fn rejects_unknown_ids_and_parameters() {
        assert!(validate(&selection("../../../cmd.exe")).is_err());
        let mut s = selection("python");
        s.options
            .insert("override".into(), Value::String("/malicious".into()));
        assert!(validate(&s).is_err())
    }
    #[test]
    fn rejects_missing_dependencies() {
        let mut s = selection("vscode");
        s.extensions.push("ms-python.vscode-pylance".into());
        assert!(validate(&s).is_err());
        s.extensions.push("ms-python.python".into());
        assert!(validate(&s).is_ok())
    }
    #[test]
    fn safari_cannot_be_winget_installed() {
        let s = selection("safari");
        assert!(package_id(&app("safari").unwrap(), &s).is_err())
    }
}
