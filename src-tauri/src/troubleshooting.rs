use crate::{
    catalog,
    engine::{self, Shared},
    maintenance::{self, Operation},
    models::*,
    readiness, system,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathBackup {
    id: String,
    app_id: String,
    before: Option<String>,
    after: String,
    added: String,
}
pub fn paths() -> Result<(Option<String>, String), String> {
    let v=system::powershell("[pscustomobject]@{user=[Environment]::GetEnvironmentVariable('Path','User');machine=[Environment]::GetEnvironmentVariable('Path','Machine')} | ConvertTo-Json -Compress")?;
    Ok((
        v["user"].as_str().map(String::from),
        v["machine"].as_str().unwrap_or("").into(),
    ))
}
fn norm(s: &str) -> String {
    s.trim()
        .trim_matches('"')
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_lowercase()
}
pub fn contains_path(value: &str, directory: &str) -> bool {
    value.split(';').any(|p| norm(p) == norm(directory))
}
pub fn append_path(before: &Option<String>, directory: &str) -> Result<String, String> {
    if directory.contains([';', '\r', '\n', '\0', '%']) || directory.is_empty() {
        return Err("Недопустимый путь".into());
    }
    let old = before.as_deref().unwrap_or("");
    if contains_path(old, directory) {
        return Err("Путь уже присутствует".into());
    }
    Ok(format!(
        "{old}{}{directory}",
        if old.is_empty() || old.ends_with(';') {
            ""
        } else {
            ";"
        }
    ))
}
pub fn restore_value(
    current: &Option<String>,
    before: &Option<String>,
    after: &str,
    added: &str,
) -> Result<Option<String>, String> {
    if current.as_deref() == Some(after) {
        return Ok(before.clone());
    }
    let value = current
        .as_deref()
        .ok_or("PATH изменён после исправления; восстановление неоднозначно")?;
    let count = value.split(';').filter(|p| norm(p) == norm(added)).count();
    if count != 1 || before.as_deref().is_some_and(|v| contains_path(v, added)) {
        return Err(
            "Добавленная запись изменена или повторяется. Сравните копию с PATH вручную.".into(),
        );
    }
    // Retain every later entry verbatim. Do not overwrite subsequent changes with a whole backup.
    Ok(Some(
        value
            .split(';')
            .filter(|p| norm(p) != norm(added))
            .collect::<Vec<_>>()
            .join(";"),
    ))
}
fn expanded_entries(value: &str) -> Result<Vec<PathBuf>, String> {
    // Expand Windows variables in the registry PATH using the Windows API through a fixed script.
    let v = system::powershell(&format!(
        "[Environment]::ExpandEnvironmentVariables({}) | ConvertTo-Json -Compress",
        readiness::quote(value)
    ))?;
    Ok(v.as_str()
        .unwrap_or("")
        .split(';')
        .filter(|p| !p.trim().is_empty())
        .map(|s| PathBuf::from(s.trim().trim_matches('"')))
        .collect())
}
pub fn path_candidate(s: &Selection) -> Result<(String, Option<String>), String> {
    if !["python", "git", "nodejs", "node"].contains(&s.app_id.as_str()) {
        return Err(
            "Автоматическое изменение PATH доступно только для Python, Git и Node.js".into(),
        );
    }
    if !valid_readiness_selection(s) {
        return Err("Параметры адаптера не поддерживаются".into());
    }
    let exe = readiness::executable(&s.app_id)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let parent = exe
        .parent()
        .ok_or("Нет папки приложения")?
        .to_string_lossy()
        .to_string();
    let directory = parent
        .strip_prefix("\\\\?\\")
        .unwrap_or(&parent)
        .to_string();
    let out = system::bounded_output(system::command(&exe).arg("--version"), 20)?;
    let text = String::from_utf8_lossy(&out.stdout);
    let prefix = match s.app_id.as_str() {
        "python" => "Python ",
        "git" => "git version ",
        _ => "v",
    };
    if !out.status.success() || !text.trim().starts_with(prefix) {
        return Err("Исполняемый файл не подтвердил ожидаемую версию".into());
    }
    let (before, machine) = paths()?;
    let all = format!("{};{machine}", before.as_deref().unwrap_or(""));
    let dirs = expanded_entries(&all)?;
    if dirs
        .iter()
        .map(|d| d.join(exe.file_name().unwrap_or_default()))
        .filter(|p| p.is_file())
        .any(|p| p.canonicalize().is_ok_and(|p| p != exe))
    {
        return Err("В PATH обнаружена другая установка этой программы. Сравните расположения вручную; автоматическое изменение не предлагается.".into());
    }
    if dirs
        .iter()
        .any(|p| p.canonicalize().ok().as_ref() == exe.parent().map(Path::to_path_buf).as_ref())
    {
        return Err(
            "Папка уже присутствует в актуальном PATH Windows. Откройте новый терминал.".into(),
        );
    }
    let _ = append_path(&before, &directory)?;
    Ok((directory, before))
}
fn compare_write(expected: &Option<String>, new: &Option<String>) -> Result<(), String> {
    let literal = |v: &Option<String>| v.as_deref().map(readiness::quote).unwrap_or("$null".into());
    system::powershell(&format!("$current=[Environment]::GetEnvironmentVariable('Path','User'); $expected={}; if(-not [string]::Equals($current,$expected,[StringComparison]::Ordinal) -or (($null -eq $current) -ne ($null -eq $expected))){{throw 'PATH изменён после просмотра плана. Повторите диагностику.'}}; [Environment]::SetEnvironmentVariable('Path',{},'User'); $true | ConvertTo-Json",literal(expected),literal(new)))?;
    Ok(())
}
pub fn apply_path(
    data: &Path,
    s: &Selection,
    directory: &str,
    before: &Option<String>,
) -> Result<String, String> {
    let (actual, current) = path_candidate(s)?;
    if norm(&actual) != norm(directory) || current != *before {
        return Err("Путь или PATH изменился после просмотра плана".into());
    }
    let after = append_path(before, directory)?;
    let id = uuid::Uuid::new_v4().to_string();
    let root = data.join("path-backups");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let b = PathBackup {
        id: id.clone(),
        app_id: s.app_id.clone(),
        before: before.clone(),
        after: after.clone(),
        added: directory.into(),
    };
    let bytes = serde_json::to_vec_pretty(&b).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(root.join(format!("{id}.json")))
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes)
        .and_then(|_| f.sync_all())
        .map_err(|e| e.to_string())?;
    compare_write(before, &Some(after))?;
    Ok(format!("В пользовательский PATH добавлена только папка {directory}. Исходное значение сохранено: {id}. Откройте новый терминал"))
}
fn backup(data: &Path, id: &str) -> Result<PathBackup, String> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("Неверная копия PATH".into());
    }
    serde_json::from_slice(
        &fs::read(data.join("path-backups").join(format!("{id}.json")))
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
pub fn backups(data: &Path) -> Result<Value, String> {
    let root = data.join("path-backups");
    if !root.exists() {
        return Ok(json!([]));
    }
    let mut rows = vec![];
    for f in fs::read_dir(root).map_err(|e| e.to_string())? {
        let f = f.map_err(|e| e.to_string())?;
        if let Some(id) = f.path().file_stem().and_then(|s| s.to_str()) {
            if let Ok(b) = backup(data, id) {
                rows.push(json!({"id":b.id,"appId":b.app_id,"added":b.added,"before":b.before}));
            }
        }
    }
    Ok(json!(rows))
}
pub fn restore_path(data: &Path, id: &str) -> Result<String, String> {
    let b = backup(data, id)?;
    let (current, _) = paths()?;
    let new = restore_value(&current, &b.before, &b.after, &b.added)?;
    compare_write(&current, &new)?;
    Ok("Добавление PATH отменено с сохранением последующих правок".into())
}
pub fn restore_plan(shared: &Shared, id: &str) -> Result<Plan, String> {
    let data = engine::lock(shared).data_dir.clone();
    let b = backup(&data, id)?;
    let (current, _) = paths()?;
    let result = restore_value(&current, &b.before, &b.after, &b.added)?;
    let s = validated_selection(&b.app_id, vec![])?;
    let mut t = maintenance::task(
        s,
        "Восстановление PATH".into(),
        "fix",
        Operation::PathRestore { backup: id.into() },
    );
    t.log = vec![
        format!("Исходный PATH: {:?}", b.before),
        format!("Текущий PATH: {current:?}"),
        format!("После отмены добавления: {result:?}"),
    ];
    maintenance::plan(shared,vec![t],vec!["При последующих правках удаляется только добавленная запись; неоднозначные изменения блокируют восстановление.".into()])
}
pub fn validated_selection(id: &str, extensions: Vec<String>) -> Result<Selection, String> {
    let mut s = maintenance::selection(id);
    if ["windows-instance", "nodejs"].contains(&id) && extensions.is_empty() {
        return Ok(s);
    }
    s.extensions = extensions;
    let a = catalog::app(id)?;
    s.action = catalog::allowed_actions(&a)
        .first()
        .ok_or("Нет адаптера")?
        .to_string();
    catalog::validate(&s)?;
    Ok(s)
}
pub fn valid_readiness_selection(s: &Selection) -> bool {
    catalog::validate(s).is_ok()
        || (s.app_id == "nodejs"
            && s.action == "guide"
            && s.options.is_empty()
            && s.extensions.is_empty()
            && s.version.is_none())
}
pub fn diagnose(s: &Selection, instance_key: Option<&str>) -> Result<Value, String> {
    if s.app_id != "windows-instance" && !valid_readiness_selection(s) {
        catalog::validate(s)?;
    }
    let checked = readiness::check(s);
    let path = path_candidate(s);
    let all = maintenance::instances();
    let linked: Vec<_> = all
        .as_ref()
        .map(|rs| {
            rs.iter()
                .filter(|i| {
                    instance_key
                        .map(|key| i.key == key)
                        .unwrap_or(i.app_id.as_deref() == Some(&s.app_id))
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let repair = linked.len() == 1
        && maintenance::repairable(&linked[0])
        && maintenance::target(all.as_ref().unwrap(), &linked[0]).is_ok()
        && maintenance::supports("repair");
    let missing = missing_extensions(s);
    let mut verified = vec![format!("Адаптер готовности: {}", checked.reason)];
    let mut problems = vec![];
    let mut unknown = vec![];
    if checked.state == "action" {
        problems.push(checked.reason.clone());
    } else if checked.state == "unknown" {
        unknown.push(checked.reason.clone());
    }
    match &path {
        Ok((d, _)) => {
            verified.push(format!(
                "Исполняемый файл запускается и сообщает версию: {d}"
            ));
            problems.push("Его папка отсутствует в актуальном PATH Windows".into());
        }
        Err(e) => unknown.push(format!("Автоисправление PATH: {e}")),
    }
    if let Err(e) = &all {
        unknown.push(format!("Экземпляры Windows: {e}"));
    }
    if !repair {
        unknown.push("Штатное repair не подтверждено: требуется один точный MSI-экземпляр и поддержка команды установленным WinGet".into());
    }
    if let Err(e) = &missing {
        unknown.push(e.clone());
    }
    if let Ok(ids) = &missing {
        if !ids.is_empty() {
            problems.push(format!(
                "Отсутствуют выбранные расширения: {}",
                ids.join(", ")
            ));
        }
    }
    let name = linked
        .first()
        .map(|i| i.name.clone())
        .or_else(|| {
            catalog::app(&s.app_id)
                .ok()
                .map(|a| catalog::text(&a, "name").to_string())
        })
        .unwrap_or_else(|| {
            if s.app_id == "nodejs" {
                "Node.js".into()
            } else {
                "нужное приложение".into()
            }
        });
    let mut manual=vec![format!("Запустите «{name}» вручную и запишите точный текст ошибки и версию программы."),format!("Параметры Windows → Приложения → Установленные приложения → «{name}» → Изменить / Восстановить (если доступно). Сверьте версию и область с выбранным экземпляром.")];
    if ["python", "git", "nodejs"].contains(&s.app_id.as_str()) {
        manual.push("После изменения PATH откройте новый терминал; старые процессы хранят прежнее окружение. При конфликтующих установках сравните папки в переменных среды Windows и выберите нужную вручную.".into());
    }
    if s.app_id == "vscode" {
        manual.push("В VS Code откройте Расширения (Ctrl+Shift+X), найдите нужные Marketplace ID из выбранного списка и проверьте их наличие в текущем профиле. При ошибке загрузки проверьте доступ к Marketplace и политики организации.".into());
    }
    manual.push("Если ошибка остаётся, откройте встроенную справку / поддержку производителя и передайте версию и точный текст ошибки. AppDock не удаляет конфликтующие установки и не переустанавливает программу автоматически.".into());
    Ok(
        json!({"readiness":checked,"checked":verified,"problems":problems,"unknown":unknown,"pathAvailable":path.is_ok(),"path":path.ok().map(|p|p.0),"repairAvailable":repair,"missingExtensions":missing.unwrap_or_default(),"manual":manual}),
    )
}
pub fn missing_extensions(s: &Selection) -> Result<Vec<String>, String> {
    if s.app_id != "vscode" {
        return Ok(vec![]);
    }
    catalog::validate(s)?;
    let out = system::bounded_output(system::code_command()?.arg("--list-extensions"), 20)?;
    if !out.status.success() {
        return Err("Не удалось проверить расширения VS Code".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(s.extensions
        .iter()
        .filter(|id| !text.lines().any(|l| l.trim().eq_ignore_ascii_case(id)))
        .cloned()
        .collect())
}
pub fn prepare(
    shared: &Shared,
    s: Selection,
    fix: &str,
    instance_key: Option<&str>,
) -> Result<Plan, String> {
    if s.app_id != "windows-instance" && !valid_readiness_selection(&s) {
        catalog::validate(&s)?;
    }
    let name = catalog::app(&s.app_id)
        .ok()
        .map(|a| catalog::text(&a, "name").to_string())
        .unwrap_or("Выбранный экземпляр Windows".into());
    let mut t = maintenance::task(s.clone(), name, "fix", Operation::Recheck);
    match fix {
        "recheck"=>t.log=vec!["Повторная диагностика исполняемого файла, версии и выбранных компонентов. Установка не выполняется.".into()],
        "path"=>{let (directory,before)=path_candidate(&s)?;let after=append_path(&before,&directory)?;t.log=vec![format!("Проверенный путь: {directory}"),format!("Исходный пользовательский PATH: {before:?}"),format!("После исправления: {after}"),"Сначала сохраняется исходное значение. Остальные записи и системный PATH сохраняются.".into()];t.operation=Some(Operation::Path{directory,before});},
        "repair"=>{let rows=maintenance::instances()?;let candidates:Vec<_>=rows.iter().filter(|i|instance_key.map(|key|i.key==key).unwrap_or(i.app_id.as_deref()==Some(&s.app_id))).collect();if candidates.len()!=1 || !maintenance::repairable(candidates[0]) || !maintenance::supports("repair"){return Err("Штатное MSI-восстановление этого экземпляра не подтверждено".into());}let instance=maintenance::target(&rows,candidates[0])?.clone();t.name=instance.name.clone();t.log=vec![format!("WinGet repair: {} · {} · {} · {}",instance.name,instance.version,instance.scope,instance.product_code),"Штатное MSI-восстановление проверяет и восстанавливает файлы приложения. Может потребовать источник MSI, окно мастера и UAC. Пользовательские данные AppDock не удаляет.".into()];t.action="repair".into();t.operation=Some(Operation::Repair {instance});},
        "extensions"=>{let missing=missing_extensions(&s)?;if missing.is_empty(){return Err("Отсутствующих выбранных расширений нет".into());}let mut ordinary=s.clone();ordinary.action="install".into();let mut tasks=engine::build_tasks(&[ordinary])?;tasks.retain(|t|t.action=="extension" && t.selection.extensions.iter().any(|id|missing.contains(id)));let ids:Vec<_>=tasks.iter().map(|t|t.id.clone()).collect();for task in &mut tasks{task.parent_id=None;task.dependencies.retain(|id|ids.contains(id));task.message="Установить только отсутствующее выбранное расширение VS Code".into();}t.dependencies=ids;tasks.push(t);return maintenance::plan(shared,tasks,vec!["Обычные задачи установки расширений из доверенного каталога; сам VS Code не переустанавливается. Затем повторная диагностика.".into()]);},
        _=>return Err("Исправление отсутствует в разрешённом списке".into()),
    }
    maintenance::plan(shared,vec![t],vec!["После исправления AppDock повторит диагностику. Код завершения команды сам по себе не подтверждает исправление.".into()])
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_preserves_entries_and_restores_later_changes() {
        let before = Some("C:\\One;;%USERPROFILE%\\bin;".into());
        let after = append_path(&before, "C:\\Python").unwrap();
        assert_eq!(after, "C:\\One;;%USERPROFILE%\\bin;C:\\Python");
        assert_eq!(
            restore_value(&Some(after.clone()), &before, &after, "C:\\Python").unwrap(),
            before
        );
        let later = Some(format!("{after};D:\\Later"));
        assert_eq!(
            restore_value(&later, &before, &after, "C:\\Python").unwrap(),
            Some("C:\\One;;%USERPROFILE%\\bin;D:\\Later".into())
        );
        assert!(append_path(&Some("c:/python/".into()), "C:\\Python").is_err());
        assert!(restore_value(
            &Some(format!("{after};c:\\python")),
            &before,
            &after,
            "C:\\Python"
        )
        .is_err());
    }
    #[test]
    fn null_path_and_untrusted_fixes() {
        let after = append_path(&None, "C:\\Git").unwrap();
        assert_eq!(
            restore_value(&Some(after.clone()), &None, &after, "C:\\Git").unwrap(),
            None
        );
        assert!(append_path(&None, "C:\\Git;cmd.exe").is_err());
        assert!(validated_selection("cmd.exe", vec![]).is_err());
        assert!(validated_selection("vscode", vec!["evil.extension".into()]).is_err());
        let s = validated_selection("chrome", vec![]).unwrap();
        assert!(path_candidate(&s).is_err());
        let mut node = validated_selection("nodejs", vec![]).unwrap();
        assert!(valid_readiness_selection(&node));
        node.options.insert("command".into(), json!("cmd.exe"));
        assert!(!valid_readiness_selection(&node));
    }
}
