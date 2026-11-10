use crate::{
    catalog, custom_apps,
    engine::{self, Shared},
    models::*,
    readiness, system, troubleshooting,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::Emitter;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Instance {
    pub key: String,
    pub product_code: String,
    pub scope: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub msi: bool,
    pub app_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Operation {
    Uninstall {
        instance: Instance,
    },
    Repair {
        instance: Instance,
    },
    Recheck,
    Path {
        directory: String,
        before: Option<String>,
    },
    PathRestore {
        backup: String,
    },
    Custom {
        id: String,
        sha256: String,
    },
}
pub fn instances() -> Result<Vec<Instance>, String> {
    let v = system::powershell(
        r#"$roots=@(@('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall','machine'),@('HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','machine'),@('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall','user'),@('HKCU:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','user')); $rows=@(foreach($r in $roots){if(Test-Path -LiteralPath $r[0]){foreach($k in Get-ChildItem -LiteralPath $r[0]){$p=Get-ItemProperty -LiteralPath $k.PSPath; if($p.DisplayName -and !$p.SystemComponent){[pscustomobject]@{key=$k.Name;productCode=$k.PSChildName;scope=$r[1];name=[string]$p.DisplayName;version=[string]$p.DisplayVersion;publisher=[string]$p.Publisher;msi=($p.WindowsInstaller -eq 1);appId=$null}}}}}); ConvertTo-Json -InputObject $rows -Compress"#,
    )?;
    let mut rows: Vec<Instance> = serde_json::from_value(v)
        .map_err(|e| format!("Не удалось прочитать экземпляры Windows: {e}"))?;
    // This hint is for navigation and dependency warnings ONLY; commands always use the ARP identity.
    for row in &mut rows {
        row.app_id = catalog::apps()
            .iter()
            .find(|a| {
                a["detection"]["displayNames"]
                    .as_array()
                    .is_some_and(|names| names.iter().any(|n| n.as_str() == Some(&row.name)))
            })
            .map(|a| catalog::text(a, "id").to_string());
        if row.name == "Node.js" {
            row.app_id = Some("nodejs".into());
        }
    }
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(rows)
}
pub fn target<'a>(rows: &'a [Instance], selected: &Instance) -> Result<&'a Instance, String> {
    let matches: Vec<_> = rows
        .iter()
        .filter(|r| {
            r.product_code.eq_ignore_ascii_case(&selected.product_code) && r.scope == selected.scope
        })
        .collect();
    if matches.len() != 1 {
        return Err("Неоднозначный код продукта в одной области. Удалите нужный экземпляр через Параметры Windows → Приложения.".into());
    }
    let r = matches[0];
    if r != selected
        || r.product_code.is_empty()
        || r.product_code.starts_with('-')
        || r.product_code.contains(['\r', '\n', '\0'])
        || r.version.is_empty()
        || r.version.starts_with('-')
        || r.version.contains(['\r', '\n', '\0'])
        || !["user", "machine"].contains(&r.scope.as_str())
    {
        return Err("Экземпляр изменился или не имеет точной версии и кода продукта. Повторите обнаружение.".into());
    }
    Ok(r)
}
pub fn args(verb: &str, i: &Instance) -> Result<Vec<String>, String> {
    if !["uninstall", "repair"].contains(&verb) {
        return Err("Операция запрещена".into());
    }
    Ok(vec![
        verb.into(),
        "--product-code".into(),
        i.product_code.clone(),
        "--exact".into(),
        "--version".into(),
        i.version.clone(),
        "--scope".into(),
        i.scope.clone(),
        "--source".into(),
        "winget".into(),
        "--interactive".into(),
        "--accept-source-agreements".into(),
        "--disable-interactivity".into(),
    ])
}
pub fn supports(verb: &str) -> bool {
    system::output("winget", &[verb, "--help"])
        .ok()
        .filter(|o| o.status.success())
        .is_some_and(|o| {
            let text = String::from_utf8_lossy(&o.stdout);
            [
                "--product-code",
                "--scope",
                "--version",
                "--exact",
                "--interactive",
            ]
            .iter()
            .all(|a| text.contains(a))
        })
}
pub fn repairable(i: &Instance) -> bool {
    i.msi && uuid::Uuid::parse_str(i.product_code.trim_matches(['{', '}'])).is_ok()
}
pub fn task(selection: Selection, name: String, action: &str, op: Operation) -> Task {
    Task {
        operation: Some(op),
        readiness: None,
        installation_outcome: None,
        offline_root: None,
        failure_stage: None,
        resume_from: None,
        run_id: String::new(),
        dependencies: vec![],
        last_activity_at: now(),
        actual_version: None,
        evidence: None,
        id: uuid::Uuid::new_v4().to_string(),
        app_id: selection.app_id.clone(),
        name,
        action: action.into(),
        status: "queued".into(),
        message: "Ожидает подтверждённого действия".into(),
        log: vec![],
        percent: None,
        download_progress: None,
        download_paused: false,
        cancel_requested: false,
        parent_id: None,
        selection,
        started_at: None,
        finished_at: None,
    }
}
pub fn selection(id: &str) -> Selection {
    Selection {
        app_id: id.into(),
        action: "guide".into(),
        options: Default::default(),
        extensions: vec![],
        version: None,
    }
}
pub fn plan(shared: &Shared, tasks: Vec<Task>, warnings: Vec<String>) -> Result<Plan, String> {
    let mut e = engine::lock(shared);
    if e.worker_active || e.queue.tasks.iter().any(|t| !terminal(&t.status)) {
        return Err("Сначала завершите или отмените сохранённую очередь".into());
    }
    if tasks.is_empty() || tasks.len() > 100 {
        return Err("Выберите от 1 до 100 действий".into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    let items = tasks
        .iter()
        .map(|t| PlanItem {
            selection: t.selection.clone(),
            tasks: vec![t.clone()],
            excluded: false,
            expected: t.message.clone(),
            app_id: t.app_id.clone(),
            name: t.name.clone(),
            action: t.action.clone(),
            warnings: t.log.clone(),
            blocked: false,
            installed_version: t.actual_version.clone(),
        })
        .collect();
    e.pending = Some(PendingPlan {
        token: token.clone(),
        items: tasks.iter().map(|t| t.selection.clone()).collect(),
        created_at: now(),
        skip_current: true,
        parallel_downloads: 1,
        tasks,
    });
    drop(e);
    Ok(Plan {
        token,
        items,
        warnings,
        system: system::info(),
        mode: "live".into(),
    })
}
pub fn uninstall_plan(shared: &Shared, keys: Vec<String>) -> Result<Plan, String> {
    if !supports("uninstall") {
        return Err(
            "Эта версия WinGet не поддерживает точные фильтры удаления. Обновите App Installer."
                .into(),
        );
    }
    let rows = instances()?;
    let mut seen = HashSet::new();
    let mut tasks = vec![];
    for key in keys {
        if !seen.insert(key.clone()) {
            return Err("Повтор экземпляра".into());
        }
        let i = rows
            .iter()
            .find(|i| i.key == key)
            .ok_or("Экземпляр исчез; повторите обнаружение")?;
        target(&rows, i)?;
        let mut t = task(
            selection(i.app_id.as_deref().unwrap_or("windows-instance")),
            i.name.clone(),
            "uninstall",
            Operation::Uninstall {
                instance: i.clone(),
            },
        );
        t.actual_version = Some(i.version.clone());
        t.message = format!("Удалить {} · {} · {}", i.name, i.version, i.scope);
        t.log=vec![format!("Код продукта: {}. Экземпляр: {}",i.product_code,i.key),"Штатный интерактивный деинсталлятор; подтвердите его окно и UAC при запросе. Пользовательские данные и оставшиеся папки AppDock не очищает.".into()];
        if let Some(id) = &i.app_id {
            for a in catalog::apps() {
                if a["dependencies"]
                    .as_array()
                    .is_some_and(|ds| ds.iter().any(|d| d == id))
                    && rows.iter().any(|r| r.app_id.as_deref() == a["id"].as_str())
                {
                    t.log.push(format!("Известная зависимость каталога: {} использует {}. Проверьте её работу после удаления.",catalog::text(&a,"name"),i.name));
                }
            }
        }
        tasks.push(t);
    }
    plan(shared,tasks,vec!["Удаления идут последовательно. Остановка отменит ожидающие действия; уже запущенный деинсталлятор завершится штатно. Неизвестные зависимости не определяются.".into()])
}
pub fn custom_plan(shared: &Shared, ids: Vec<String>) -> Result<Plan, String> {
    let data = engine::lock(shared).data_dir.clone();
    let mut tasks = vec![];
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id.clone()) {
            return Err("Повтор установщика".into());
        }
        let a = custom_apps::get(&data, &id)?;
        let _file = custom_apps::locked(&custom_apps::path(&data, &a)?, &a.sha256)?;
        let mut t = task(
            selection(&id),
            a.name.clone(),
            "custom-install",
            Operation::Custom {
                id,
                sha256: a.sha256.clone(),
            },
        );
        t.message = if a.kind == "msi" {
            "Windows Installer · обычный интерактивный мастер"
        } else {
            "Оригинальный EXE · интерактивный мастер без тихих ключей"
        }
        .into();
        t.log=vec!["Добавлено пользователем".into(),format!("Файл: {} · {} байт · исходное расположение: {}",a.file_name,a.size,a.source),format!("Версия: {} · издатель (метаданные): {}",a.version.as_deref().unwrap_or("неизвестна"),a.publisher.as_deref().unwrap_or("неизвестен")),format!("SHA-256: {}",a.sha256),format!("Подпись: {} · {}",custom_apps::signature_label(&a.signature),a.signature_detail),"Хеш подтверждает неизменность файла, а не доверие к издателю. Завершение EXE не доказывает успешную установку.".into()];
        tasks.push(t);
    }
    plan(shared,tasks,vec!["Будут запущены управляемые копии после повторной проверки SHA-256. Подтвердите мастера и штатный UAC.".into()])
}
fn record(
    shared: &Shared,
    app: &tauri::AppHandle,
    id: &str,
    outcome: &str,
    evidence: Option<&str>,
    checked: Option<readiness::Readiness>,
) {
    let mut e = engine::lock(shared);
    if let Some(t) = e.queue.tasks.iter_mut().find(|t| t.id == id) {
        t.installation_outcome = Some(outcome.into());
        t.evidence = evidence.map(String::from);
        t.readiness = checked;
    }
    let _ = e.save();
    let _ = app.emit("queue-changed", &e.queue);
}
pub fn execute(shared: &Shared, app: &tauri::AppHandle, t: &Task) -> Result<(), String> {
    let data = engine::lock(shared).data_dir.clone();
    engine::update(
        shared,
        app,
        &t.id,
        "checking",
        "Повторная проверка согласованного действия",
    );
    match t.operation.as_ref().ok_or("Нет операции")? {
        Operation::Uninstall { instance } | Operation::Repair { instance } => {
            let removal = matches!(t.operation, Some(Operation::Uninstall { .. }));
            let verb = if removal { "uninstall" } else { "repair" };
            let rows = instances()?;
            // Never replay an uncertain uninstall automatically after a restart.
            target(&rows, instance)?;
            if !supports(verb) {
                return Err("Точные фильтры WinGet больше не поддерживаются".into());
            }
            if !removal && !repairable(instance) {
                return Err("Пакет не имеет подтверждённого MSI-восстановления".into());
            }
            let args = args(verb, instance)?;
            engine::append(shared, app, &t.id, &format!("WinGet {args:?}"));
            engine::update(
                shared,
                app,
                &t.id,
                "installing",
                if removal {
                    "Выполняется штатное удаление. Проверьте окно и UAC."
                } else {
                    "Выполняется штатное восстановление MSI через WinGet."
                },
            );
            let code = engine::run_command(shared, app, t, {
                let mut c = system::command("winget");
                c.args(&args);
                c
            })?;
            engine::append(
                shared,
                app,
                &t.id,
                &format!("Код WinGet: 0x{:08X}", code as u32),
            );
            let ok = [0, 3010, 1641].contains(&code);
            if removal {
                let detection = instances();
                let absent = detection.as_ref().is_ok_and(|rs| {
                    !rs.iter().any(|r| {
                        r.product_code.eq_ignore_ascii_case(&instance.product_code)
                            && r.scope == instance.scope
                    })
                });
                record(
                    shared,
                    app,
                    &t.id,
                    if ok {
                        "uninstaller-completed"
                    } else {
                        "uninstaller-failed"
                    },
                    if absent { Some("absent") } else { None },
                    None,
                );
                engine::update(
                    shared,
                    app,
                    &t.id,
                    if !ok {
                        "error"
                    } else if absent {
                        "removed"
                    } else {
                        "action-required"
                    },
                    &format!(
                        "Деинсталлятор: {}. Отсутствие программы: {}.",
                        if ok {
                            "завершился успешно"
                        } else {
                            "ошибка"
                        },
                        if absent {
                            "подтверждено повторным обнаружением"
                        } else if detection.is_err() {
                            "проверить не удалось"
                        } else {
                            "не подтверждено; экземпляр ещё обнаружен"
                        }
                    ),
                );
            } else {
                let checked = readiness::check(&t.selection);
                let fixed = checked.state == "ready";
                record(
                    shared,
                    app,
                    &t.id,
                    if ok {
                        "repair-completed"
                    } else {
                        "repair-failed"
                    },
                    None,
                    Some(checked),
                );
                engine::update(
                    shared,
                    app,
                    &t.id,
                    if !ok {
                        "error"
                    } else if fixed {
                        "repaired"
                    } else {
                        "action-required"
                    },
                    if fixed && ok {
                        "Повторная диагностика подтвердила готовность"
                    } else {
                        "Восстановление завершено; исправление не подтверждено. Откройте мастер и ручные шаги."
                    },
                );
            }
        }
        Operation::Custom { id, sha256 } => {
            let entry = custom_apps::get(&data, id)?;
            if &entry.sha256 != sha256 {
                return Err("Запись установщика изменилась. Нужен новый план.".into());
            }
            let path = custom_apps::path(&data, &entry)?;
            let _locked = custom_apps::locked(&path, sha256)?;
            engine::update(
                shared,
                app,
                &t.id,
                "installing",
                "Открыт оригинальный интерактивный установщик. Проверьте его окно и UAC.",
            );
            let code = if entry.kind == "msi" {
                engine::run_command(shared, app, t, {
                    let mut c = system::command(
                        std::env::var_os("SystemRoot")
                            .map(std::path::PathBuf::from)
                            .ok_or("Не найден Windows")?
                            .join("System32/msiexec.exe"),
                    );
                    c.arg("/i").arg(&path).arg("/norestart");
                    c
                })?
            } else {
                custom_apps::run_interactive(&path)?
            };
            engine::append(
                shared,
                app,
                &t.id,
                &format!("Установщик завершился: {code}"),
            );
            let ok = [0, 3010, 1641].contains(&code);
            record(
                shared,
                app,
                &t.id,
                if ok {
                    "process-completed"
                } else {
                    "process-failed"
                },
                None,
                None,
            );
            engine::update(
                shared,
                app,
                &t.id,
                if !ok {
                    "error"
                } else if code != 0 {
                    "reboot-required"
                } else {
                    "action-required"
                },
                if ok {
                    "Процесс установщика завершён. Установка и готовность неизвестной программы не подтверждены; проверьте приложение вручную."
                } else {
                    "Установщик сообщил ошибку или отмену. Проверьте журнал и окно производителя."
                },
            );
            let _ = system::scan_report(&data);
        }
        Operation::Recheck | Operation::Path { .. } | Operation::PathRestore { .. } => {
            let result = match t.operation.as_ref().unwrap() {
                Operation::Path { directory, before } => {
                    troubleshooting::apply_path(&data, &t.selection, directory, before)
                }
                Operation::PathRestore { backup } => troubleshooting::restore_path(&data, backup),
                _ => Ok("Изменения не выполнялись".into()),
            };
            let checked = readiness::check(&t.selection);
            let fixed = checked.state == "ready";
            record(
                shared,
                app,
                &t.id,
                if result.is_ok() {
                    "check-completed"
                } else {
                    "fix-failed"
                },
                None,
                Some(checked),
            );
            engine::update(
                shared,
                app,
                &t.id,
                if result.is_err() {
                    "error"
                } else if fixed {
                    if matches!(t.operation, Some(Operation::Recheck)) {
                        "checked"
                    } else {
                        "repaired"
                    }
                } else {
                    "action-required"
                },
                &format!(
                    "{}. Повторная диагностика: {}",
                    result.unwrap_or_else(|e| e),
                    if fixed {
                        "готовность подтверждена"
                    } else {
                        "готовность не подтверждена; см. результат и ручные шаги"
                    }
                ),
            );
        }
    }
    Ok(())
}
pub fn valid_task(t: &Task) -> bool {
    match &t.operation {
        Some(Operation::Custom { id, .. }) => {
            custom_apps::valid_id(id) && t.app_id == *id && t.action == "custom-install"
        }
        Some(Operation::Uninstall { .. }) => t.action == "uninstall",
        Some(Operation::Repair { .. }) => {
            t.action == "repair"
                && (troubleshooting::valid_readiness_selection(&t.selection)
                    || t.app_id == "windows-instance")
        }
        Some(Operation::Recheck) => {
            t.action == "fix"
                && (troubleshooting::valid_readiness_selection(&t.selection)
                    || t.app_id == "windows-instance")
        }
        Some(_) => t.action == "fix" && troubleshooting::valid_readiness_selection(&t.selection),
        None => false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn i() -> Instance {
        Instance {
            key: "HKCU/key".into(),
            product_code: "{exact-code}".into(),
            scope: "user".into(),
            name: "Example".into(),
            version: "1.2".into(),
            publisher: "Example".into(),
            msi: true,
            app_id: None,
        }
    }
    #[test]
    fn exact_identity_rejects_approximation_and_duplicates() {
        let original = i();
        assert!(target(&[original.clone()], &original).is_ok());
        let mut other = original.clone();
        other.version = "1.3".into();
        assert!(target(&[other.clone()], &original).is_err());
        other = original.clone();
        other.key = "HKCU/other-view".into();
        assert!(target(&[original.clone(), other], &original).is_err());
        let mut wrong = original.clone();
        wrong.product_code = "{other-code}".into();
        assert!(target(&[wrong], &original).is_err());
        let mut injected = original.clone();
        injected.version = "--all".into();
        assert!(target(&[injected.clone()], &injected).is_err());
    }
    #[test]
    fn command_has_only_exact_filters() {
        let a = args("uninstall", &i()).unwrap();
        for flag in [
            "--product-code",
            "--exact",
            "--version",
            "--scope",
            "--source",
            "--disable-interactivity",
        ] {
            assert!(a.iter().any(|a| a == flag));
        }
        assert!(!a
            .iter()
            .any(|a| a == "--purge" || a == "--all" || a == "--force"));
        assert!(args("cmd", &i()).is_err());
        let mut fake = i();
        assert!(!repairable(&fake));
        fake.product_code = "{00112233-4455-6677-8899-aabbccddeeff}".into();
        assert!(repairable(&fake));
        fake.msi = false;
        assert!(!repairable(&fake));
    }
}
