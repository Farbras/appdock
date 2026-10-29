use crate::{catalog, models::*, system, winget};
use serde_json::Value;
use std::{
    collections::HashSet,
    io::Read,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter};

pub struct Engine {
    pub queue: Queue,
    pub pending: Option<PendingPlan>,
    pub data_dir: PathBuf,
    pub worker_active: bool,
    pub skip_current: bool,
    pub parallel_downloads: usize,
    pub last_log_save: u64,
}
pub type Shared = Arc<Mutex<Engine>>;
pub fn lock(shared: &Shared) -> std::sync::MutexGuard<'_, Engine> {
    shared.lock().unwrap_or_else(|e| e.into_inner())
}
pub fn migrate_queue(queue: &mut Queue) {
    queue.schema_version = 2;
    if !queue.tasks.is_empty() && queue.runs.is_empty() {
        let id = uuid::Uuid::new_v4().to_string();
        for t in &mut queue.tasks {
            t.run_id = id.clone();
        }
        queue.current_run_id = Some(id.clone());
        queue.runs.push(Run {
            id,
            created_at: queue.updated_at,
            finished_at: None,
            mode: queue.mode.clone(),
            skip_current: true,
            parallel_downloads: 2,
            selections: queue
                .tasks
                .iter()
                .filter(|t| t.parent_id.is_none())
                .map(|t| t.selection.clone())
                .collect(),
            outcome: "migrated".into(),
        });
    }
    // Legacy extension queues only recorded their editor parent.
    let snapshot = queue.tasks.clone();
    for t in &mut queue.tasks {
        if t.dependencies.is_empty() {
            if let Some(parent) = &t.parent_id {
                t.dependencies.push(parent.clone());
            }
            if t.action == "extension" {
                if let Some(ext) = catalog::extensions().iter().find(|e| {
                    Some(catalog::text(e, "id"))
                        == t.selection.extensions.first().map(String::as_str)
                }) {
                    for dep in ext["dependencies"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                    {
                        if let Some(found) = snapshot.iter().find(|other| {
                            other.run_id == t.run_id
                                && other.action == "extension"
                                && other.selection.extensions.iter().any(|id| id == dep)
                        }) {
                            t.dependencies.push(found.id.clone());
                        }
                    }
                }
            }
        }
    }
}
pub fn finish_run(q: &mut Queue) {
    if let Some(id) = q.current_run_id.clone() {
        finish_run_id(q, &id)
    }
}
fn finish_run_id(q: &mut Queue, run_id: &str) {
    let tasks: Vec<_> = q.tasks.iter().filter(|t| t.run_id == run_id).collect();
    if let Some(run) = q.runs.iter_mut().find(|r| r.id == run_id) {
        run.finished_at = Some(now());
        run.outcome = if tasks
            .iter()
            .any(|t| t.status == "error" || t.status == "blocked")
        {
            "errors"
        } else if tasks.iter().any(|t| t.status == "action-required") {
            "action-required"
        } else if tasks.iter().any(|t| t.status == "cancelled") {
            "cancelled"
        } else {
            "completed"
        }
        .into();
    }
}
pub fn build_tasks(items: &[Selection]) -> Result<Vec<Task>, String> {
    let mut tasks = Vec::new();
    for selection in items {
        let a = catalog::app(&selection.app_id)?;
        if selection.action == "download" && a["install"]["download"] != true {
            continue;
        }
        catalog::validate(selection)?;
        let parent = uuid::Uuid::new_v4().to_string();
        tasks.push(Task {
            id: parent.clone(),
            run_id: String::new(),
            dependencies: vec![],
            last_activity_at: now(),
            actual_version: None,
            evidence: None,
            app_id: selection.app_id.clone(),
            name: catalog::text(&a, "name").into(),
            action: selection.action.clone(),
            status: "queued".into(),
            message: "Перед выполнением состояние будет проверено заново".into(),
            log: vec![],
            percent: None,
            parent_id: None,
            selection: selection.clone(),
            started_at: None,
            finished_at: None,
        });
        if selection.app_id == "vscode" && selection.action == "install" {
            for ext in catalog::extensions()
                .iter()
                .filter(|e| selection.extensions.iter().any(|id| e["id"] == *id))
            {
                let mut task = tasks.iter().find(|t| t.id == parent).unwrap().clone();
                task.id = uuid::Uuid::new_v4().to_string();
                task.action = "extension".into();
                task.name = catalog::text(ext, "name").into();
                task.parent_id = Some(parent.clone());
                task.dependencies.push(parent.clone());
                task.selection.extensions = vec![catalog::text(ext, "id").into()];
                tasks.push(task);
            }
        }
    }
    let snapshot = tasks.clone();
    for t in &mut tasks {
        let a = catalog::app(&t.app_id)?;
        for dep in a["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if let Some(found) = snapshot
                .iter()
                .find(|o| o.app_id == dep && o.parent_id.is_none())
            {
                t.dependencies.push(found.id.clone());
            }
        }
        if t.action == "extension" {
            if let Some(ext) = catalog::extensions()
                .iter()
                .find(|e| e["id"] == t.selection.extensions[0])
            {
                for dep in ext["dependencies"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    if let Some(found) = snapshot.iter().find(|o| {
                        o.action == "extension" && o.selection.extensions.iter().any(|id| id == dep)
                    }) {
                        t.dependencies.push(found.id.clone());
                    }
                }
            }
        }
    }
    // Stable topological order, so dependency checks also work when catalog order changes.
    let mut sorted = Vec::<Task>::new();
    while !tasks.is_empty() {
        let Some(pos) = tasks.iter().position(|t| {
            t.dependencies
                .iter()
                .all(|d| sorted.iter().any(|o| &o.id == d))
        }) else {
            return Err("Цикл или отсутствующая зависимость в плане".into());
        };
        sorted.push(tasks.remove(pos));
    }
    Ok(sorted)
}
pub fn dependency_failure(task: &Task, tasks: &[Task]) -> Option<String> {
    task.dependencies
        .iter()
        .find_map(|id| match tasks.iter().find(|t| &t.id == id) {
            Some(dep)
                if ["installed", "current", "reboot-required"].contains(&dep.status.as_str()) =>
            {
                None
            }
            Some(dep) => Some(format!(
                "Зависимость «{}»: {}. Исправьте её и проверьте новый план зависимых задач.",
                dep.name, dep.message
            )),
            None => {
                Some("Зависимость отсутствует в сохранённом плане. Составьте новый план.".into())
            }
        })
}
fn check_recovered_dependencies(shared: &Shared, task: &Task) -> Option<String> {
    let (mut observed, data) = {
        let e = lock(shared);
        (e.queue.tasks.clone(), e.data_dir.clone())
    };
    for id in &task.dependencies {
        let Some(dep) = observed.iter_mut().find(|t| &t.id == id) else {
            return Some(
                "Зависимость отсутствует в сохранённой очереди. Составьте новый план.".into(),
            );
        };
        if dep.run_id == task.run_id {
            continue;
        }
        let detected = if dep.action == "extension" {
            system::code_command()
                .and_then(|mut c| {
                    c.args(["--list-extensions"]);
                    system::bounded_output(&mut c, 45)
                })
                .is_ok_and(|o| {
                    o.status.success()
                        && String::from_utf8_lossy(&o.stdout).lines().any(|l| {
                            dep.selection
                                .extensions
                                .first()
                                .is_some_and(|id| l.trim().eq_ignore_ascii_case(id))
                        })
                })
        } else {
            catalog::app(&dep.app_id)
                .and_then(|a| {
                    let package = catalog::package_id(&a, &dep.selection)
                        .unwrap_or_else(|_| format!("appdock:{}", dep.app_id));
                    system::scan(&data).map(|items| {
                        items
                            .iter()
                            .any(|i| i.package_id.eq_ignore_ascii_case(&package))
                    })
                })
                .unwrap_or(false)
        };
        if detected {
            dep.status = "current".into();
        } else {
            dep.status = "blocked".into();
            dep.message="Фактическое состояние зависимости не подтверждено. Сначала выполните её и повторите проверку.".into();
        }
    }
    dependency_failure(task, &observed)
}
fn valid_saved_queue(q: &Queue) -> bool {
    matches!(q.schema_version, 1 | 2)
        && q.tasks.len() <= 20000
        && ["live", "demo"].contains(&q.mode.as_str())
        && q.tasks.iter().all(|t| {
            !t.id.is_empty()
                && t.id.len() <= 80
                && t.app_id == t.selection.app_id
                && catalog::app(&t.app_id).is_ok()
                && [
                    "install",
                    "download",
                    "open",
                    "shortcut",
                    "guide",
                    "extension",
                ]
                .contains(&t.action.as_str())
        })
        && q.runs.iter().all(|r| {
            (1..=3).contains(&r.parallel_downloads)
                && ["live", "demo"].contains(&r.mode.as_str())
                && r.selections.iter().all(|s| catalog::app(&s.app_id).is_ok())
        })
        && (q.runs.is_empty()
            || q.tasks
                .iter()
                .all(|t| q.runs.iter().any(|r| r.id == t.run_id)))
}
impl Engine {
    pub fn load(data_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&data_dir);
        let mut queue = match std::fs::read_to_string(data_dir.join("queue.json")) {
            Ok(text) => match serde_json::from_str::<Queue>(&text) {
                Ok(q) if valid_saved_queue(&q) => q,
                _ => {
                    let backup = data_dir.join(format!("queue-corrupt-{}.json", now()));
                    let _ = std::fs::copy(data_dir.join("queue.json"), backup);
                    let mut q = Queue::default();
                    q.storage_error = Some("Сохранённая очередь повреждена или имеет новую схему. Исходный файл сохранён рядом с queue.json; создана пустая очередь.".into());
                    q
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Queue::default(),
            Err(e) => {
                let mut q = Queue::default();
                q.storage_error = Some(format!("Не удалось прочитать очередь: {e}"));
                q
            }
        };
        migrate_queue(&mut queue);
        if queue.running || queue.tasks.iter().any(|t| !terminal(&t.status)) {
            queue.running = false;
            queue.paused = true;
            for t in &mut queue.tasks {
                if !terminal(&t.status) {
                    t.status = "queued".into();
                    t.percent = None;
                    t.message="Восстановлено после перезапуска. Перед повтором будет выполнена проверка состояния.".into();
                    t.log.push("Выполнение было прервано. Установщик мог завершиться самостоятельно; повтор требует проверки.".into())
                }
            }
        }
        let policy = queue
            .runs
            .iter()
            .find(|r| Some(&r.id) == queue.current_run_id.as_ref())
            .map(|r| (r.skip_current, r.parallel_downloads))
            .unwrap_or((true, 2));
        Self {
            queue,
            pending: None,
            data_dir,
            worker_active: false,
            skip_current: policy.0,
            parallel_downloads: policy.1.clamp(1, 3),
            last_log_save: 0,
        }
    }
    pub fn save(&mut self) -> Result<(), String> {
        self.queue.updated_at = now();
        let result = self.save_inner();
        if let Err(err) = &result {
            self.queue.storage_error = Some(format!(
                "Не удалось сохранить очередь: {err}. Проверьте место и права папки данных."
            ));
            self.queue.paused = true;
        }
        result
    }
    fn save_inner(&mut self) -> Result<(), String> {
        let path = self.data_dir.join("queue.json");
        let temp = self.data_dir.join("queue.tmp");
        let bytes = serde_json::to_vec_pretty(&self.queue).map_err(|e| e.to_string())?;
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
            f.write_all(&bytes).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        let result = std::fs::rename(&temp, &path).map_err(|e| format!("Не удалось сохранить очередь: {e}. Освободите место и проверьте права папки данных."));
        self.queue.storage_error = result.as_ref().err().cloned();
        result
    }
}
pub fn update(shared: &Shared, app: &AppHandle, id: &str, status: &str, message: &str) {
    let mut e = lock(shared);
    if let Some(t) = e.queue.tasks.iter_mut().find(|t| t.id == id) {
        t.last_activity_at = now();
        t.status = status.into();
        t.message = message.into();
        t.percent = None;
        t.log.push(message.into());
        if terminal(status) {
            t.finished_at = Some(now())
        } else if t.started_at.is_none() {
            t.started_at = Some(now())
        }
    }
    if terminal(status) {
        if let Some(run_id) = e
            .queue
            .tasks
            .iter()
            .find(|t| t.id == id)
            .map(|t| t.run_id.clone())
        {
            if e.queue
                .tasks
                .iter()
                .filter(|t| t.run_id == run_id)
                .all(|t| terminal(&t.status))
            {
                finish_run_id(&mut e.queue, &run_id);
            }
        }
    }
    if let Err(err) = e.save() {
        e.queue.storage_error = Some(err);
    }
    let _ = app.emit("queue-changed", &e.queue);
}
fn append(shared: &Shared, app: &AppHandle, id: &str, line: &str) {
    let mut e = lock(shared);
    if let Some(t) = e.queue.tasks.iter_mut().find(|t| t.id == id) {
        t.last_activity_at = now();
        let clean = line.replace('\0', "");
        if !clean.trim().is_empty() {
            t.log.push(clean.trim().chars().take(1500).collect());
            if t.log.len() > 300 {
                t.log.remove(0);
            }
        }
    }
    if now().saturating_sub(e.last_log_save) >= 1000 {
        e.last_log_save = now();
        if let Err(err) = e.save() {
            e.queue.storage_error = Some(err);
            e.queue.paused = true;
        }
        let _ = app.emit("queue-changed", &e.queue);
    }
}
pub fn prepare(
    shared: &Shared,
    items: Vec<Selection>,
    skip_current: bool,
    parallel_downloads: usize,
) -> Result<Plan, String> {
    if items.is_empty() || items.len() > 100 {
        return Err("Выберите от 1 до 100 программ".into());
    }
    if !(1..=3).contains(&parallel_downloads) {
        return Err("Параллельные загрузки: от 1 до 3".into());
    }
    {
        let e = lock(shared);
        if e.queue.running || e.queue.tasks.iter().any(|t| !terminal(&t.status)) {
            return Err("Сначала завершите или отмените сохранённую очередь".into());
        }
    }
    let system = system::info();
    let data = lock(shared).data_dir.clone();
    let installed = system::scan(&data)?;
    let tasks = build_tasks(&items)?;
    let mut result = Vec::new();
    let mut ids = HashSet::new();
    let mut warnings = vec![];
    if !system.windows {
        return Err("Рабочий режим поддерживается только в Windows".into());
    }
    let mut disk = 0;
    let mut unknown_size = false;
    for s in &items {
        let a = catalog::app(&s.app_id)?;
        let excluded = s.action == "download" && a["install"]["download"] != true;
        if !excluded {
            catalog::validate(s)?;
        }
        if !ids.insert(s.app_id.clone()) {
            return Err("Повторяющаяся программа в плане".into());
        }
        let mut item_warnings = Vec::new();
        let mut blocked = false;
        let native_action = ["install", "download"].contains(&s.action.as_str());
        if native_action && !excluded {
            if !a["platforms"]
                .as_array()
                .is_some_and(|p| p.iter().any(|p| p == "windows"))
            {
                item_warnings
                    .push("Актуальная установка в Windows недоступна. Выберите инструкцию.".into());
                blocked = true
            }
            if !a["architectures"]
                .as_array()
                .is_some_and(|ar| ar.iter().any(|ar| ar == system.arch.as_str()))
            {
                item_warnings.push("Архитектура не проверена для этого пакета".into());
                blocked = true
            }
            if system.winget.is_none() {
                item_warnings
                    .push("WinGet не найден. Установите App Installer из Microsoft Store.".into());
                blocked = true
            }
            if let Err(err) = catalog::package_id(&a, s) {
                item_warnings.push(err);
                blocked = true
            }
        }
        if let Some(mb) = a["diskMb"].as_u64() {
            disk += mb
        } else if native_action {
            unknown_size = true
        }
        if !catalog::text(&a, "notes").is_empty() {
            item_warnings.push(catalog::text(&a, "notes").into())
        }
        if catalog::text(&a, "type") == "database-server" {
            if let Some(port) = s.options.get("port").and_then(Value::as_u64) {
                if !system::port_available(port as u16)? {
                    item_warnings.push(format!(
                        "Порт {port} занят или недоступен. Укажите другой в официальном мастере."
                    ))
                }
            }
            item_warnings.push("Пароль и фактические параметры задаются в установщике производителя; AppDock не выполняет миграции данных.".into());
        }
        if ["docker", "podman", "virtualbox", "vmware"].contains(&s.app_id.as_str()) {
            if system.virtualization != Some(true) {
                item_warnings.push("Аппаратная виртуализация не подтверждена. Проверьте BIOS/UEFI и требования производителя.".into())
            }
            item_warnings.push(format!(
                "WSL: {}. Hyper-V: {}. Компоненты Windows не изменяются автоматически.",
                system.wsl, system.hyper_v
            ));
        }
        if s.options.get("fullProfile") == Some(&Value::Bool(true)) {
            item_warnings.push("Visual Studio: снимок состава 18.10.3. Окончательные совместимость и объём покажет Installer. Полный профиль может потребовать много места; неизвестные или пропущенные компоненты будут отмечены как частичный результат.".into())
        }
        let package =
            catalog::package_id(&a, s).unwrap_or_else(|_| format!("appdock:{}", s.app_id));
        let found = installed
            .iter()
            .find(|i| i.package_id.eq_ignore_ascii_case(&package));
        if s.app_id == "visual-studio"
            && s.action == "install"
            && installed
                .iter()
                .filter(|i| i.package_id.eq_ignore_ascii_case(&package))
                .count()
                > 1
        {
            blocked = true;
            item_warnings.push("Найдено несколько экземпляров редакции Visual Studio. Выберите инструкцию и измените нужный экземпляр в Visual Studio Installer.".into());
        }
        if let Some(i) = found {
            if catalog::text(&a, "type") == "database-server" {
                item_warnings.push(format!("Обнаружен существующий экземпляр: {}. Его данные и версия не меняются автоматически.",i.version))
            }
        }
        if s.app_id == "vscode" && s.action == "install" {
            item_warnings.push(format!(
                "После редактора: {} отдельных задач расширений в профиле текущего пользователя",
                s.extensions.len()
            ))
        }
        if excluded {
            item_warnings
                .push("Отдельная загрузка недоступна. Программа останется в выборе.".into());
        }
        result.push(PlanItem {
            selection: s.clone(),
            tasks: tasks
                .iter()
                .filter(|t| t.app_id == s.app_id)
                .cloned()
                .collect(),
            excluded,
            expected: if excluded {
                "Пропуск: загрузка недоступна".into()
            } else if found.is_some()
                && skip_current
                && s.version
                    .as_ref()
                    .is_some_and(|v| found.is_some_and(|i| i.version == *v))
            {
                "Ожидается пропуск: версия уже установлена".into()
            } else if s.action == "install" && found.is_some() {
                "Обновление / проверка состояния".into()
            } else {
                s.action.clone()
            },
            app_id: s.app_id.clone(),
            name: catalog::text(&a, "name").into(),
            action: s.action.clone(),
            warnings: item_warnings,
            blocked,
            installed_version: found.map(|i| i.version.clone()),
        });
    }
    if system.free_disk_mb.is_some_and(|free| free < disk + 512) {
        for r in &mut result {
            if !r.excluded && ["install", "download"].contains(&r.action.as_str()) {
                r.blocked = true;
                r.warnings.push(
                    "Недостаточно свободного места с учётом известных требований и резерва 512 МБ"
                        .into(),
                )
            }
        }
    }
    if unknown_size {
        warnings.push("Размер части установок неизвестен. Доступное место проверено на системном диске; окончательный объём и расположение определит установщик.".into())
    }
    if !system.admin {
        warnings.push("AppDock работает от текущего пользователя. Системные установщики могут запросить штатный UAC; расширения VS Code выполняются без повышения прав.".into())
    }
    let token = uuid::Uuid::new_v4().to_string();
    if !result.iter().any(|i| i.blocked) {
        lock(shared).pending = Some(PendingPlan {
            token: token.clone(),
            items,
            created_at: now(),
            skip_current,
            parallel_downloads,
            tasks,
        })
    } else {
        lock(shared).pending = None
    }
    Ok(Plan {
        token,
        items: result,
        warnings,
        system,
        mode: "live".into(),
    })
}
pub fn start(shared: &Shared, token: &str, app: AppHandle) -> Result<(), String> {
    {
        let mut e = lock(shared);
        if e.worker_active {
            return Err("Очередь уже выполняется".into());
        }
        let p = e
            .pending
            .take()
            .ok_or("План не найден. Выполните проверку повторно.")?;
        if p.token != token || now() - p.created_at > 600_000 {
            return Err("План устарел. Выполните проверку повторно.".into());
        }
        let previous_queue = e.queue.clone();
        let mut tasks = p.tasks;
        let run_id = uuid::Uuid::new_v4().to_string();
        for task in &mut tasks {
            task.run_id = run_id.clone();
        }
        if tasks.is_empty() {
            return Err("В плане нет доступных действий".into());
        }
        e.queue.runs.push(Run {
            id: run_id.clone(),
            created_at: now(),
            finished_at: None,
            mode: "live".into(),
            skip_current: p.skip_current,
            parallel_downloads: p.parallel_downloads,
            selections: p.items,
            outcome: "running".into(),
        });
        e.queue.current_run_id = Some(run_id);
        e.skip_current = p.skip_current;
        e.parallel_downloads = p.parallel_downloads;
        e.queue.tasks.extend(tasks);
        e.queue.mode = "live".into();
        e.queue.running = true;
        e.queue.paused = false;
        if let Err(err) = e.save() {
            e.queue = previous_queue;
            e.queue.storage_error = Some(err.clone());
            return Err(err);
        }
    }
    spawn_worker(shared, app);
    Ok(())
}
fn retry_candidates(
    queue: &Queue,
    run_id: &str,
    status: &str,
    task_id: Option<&str>,
    included: Option<&[String]>,
) -> Vec<Task> {
    queue
        .tasks
        .iter()
        .filter(|t| {
            t.run_id == run_id
                && t.status == status
                && task_id.is_none_or(|id| t.id == id)
                && included.is_none_or(|ids| ids.contains(&t.app_id))
        })
        .cloned()
        .collect()
}
pub fn prepare_retry(
    shared: &Shared,
    run_id: &str,
    status: &str,
    task_id: Option<&str>,
    edits: Vec<Selection>,
    included_app_ids: Option<Vec<String>>,
) -> Result<Plan, String> {
    if !["error", "cancelled", "action-required", "blocked"].contains(&status) {
        return Err("Недопустимый вид повтора".into());
    }
    let (run, old, chosen) = {
        let e = lock(shared);
        let run = e
            .queue
            .runs
            .iter()
            .find(|r| r.id == run_id)
            .cloned()
            .ok_or("Запуск не найден")?;
        let chosen = retry_candidates(
            &e.queue,
            run_id,
            status,
            task_id,
            included_app_ids.as_deref(),
        );
        (run, e.queue.tasks.clone(), chosen)
    };
    if chosen.is_empty() {
        return Err("В выбранном запуске нет задач с этим статусом".into());
    }
    let mut items: Vec<_> = run
        .selections
        .into_iter()
        .filter(|s| chosen.iter().any(|t| t.app_id == s.app_id))
        .collect();
    for s in edits {
        catalog::validate(&s)?;
        if let Some(item) = items.iter_mut().find(|i| i.app_id == s.app_id) {
            *item = s;
        }
    }
    let mut plan = prepare(shared, items, run.skip_current, run.parallel_downloads)?;
    let matches = |a: &Task, b: &Task| {
        a.app_id == b.app_id
            && a.action == b.action
            && (a.action != "extension" || a.selection.extensions == b.selection.extensions)
    };
    let mut e = lock(shared);
    let Some(pending) = e.pending.as_mut() else {
        for item in &mut plan.items {
            item.tasks.retain(|t| chosen.iter().any(|c| matches(t, c)));
        }
        return Ok(plan);
    };
    let generated = pending.tasks.clone();
    pending
        .tasks
        .retain(|t| chosen.iter().any(|c| matches(t, c)));
    let selected = pending.tasks.clone();
    for task in &mut pending.tasks {
        for dep in &mut task.dependencies {
            if !selected.iter().any(|t| &t.id == dep) {
                if let Some(template) = generated.iter().find(|t| &t.id == dep) {
                    if let Some(found) = old
                        .iter()
                        .find(|t| t.run_id == run_id && matches(t, template))
                    {
                        *dep = found.id.clone();
                    }
                }
            }
        }
        if let Some(parent) = &mut task.parent_id {
            if !selected.iter().any(|t| &t.id == parent) {
                if let Some(found) = old.iter().find(|t| {
                    t.run_id == run_id && t.app_id == task.app_id && t.parent_id.is_none()
                }) {
                    *parent = found.id.clone();
                }
            }
        }
    }
    for item in &mut plan.items {
        item.tasks = pending
            .tasks
            .iter()
            .filter(|t| t.app_id == item.app_id)
            .cloned()
            .collect();
    }
    Ok(plan)
}
fn run_command(
    shared: &Shared,
    app: &AppHandle,
    task: &Task,
    mut command: std::process::Command,
) -> Result<i32, String> {
    let diagnostic = command
        .get_args()
        .next()
        .and_then(|a| a.to_str())
        .is_some_and(|verb| ["show", "source", "list", "export"].contains(&verb));
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Не удалось запустить операцию: {e}"))?;
    let stdout = child.stdout.take().ok_or("Недоступен stdout")?;
    let stderr = child.stderr.take().ok_or("Недоступен stderr")?;
    let pipe = |mut reader: Box<dyn Read + Send>, shared: Shared, app: AppHandle, id: String| {
        std::thread::spawn(move || {
            let mut bytes = [0u8; 2048];
            while let Ok(n) = reader.read(&mut bytes) {
                if n == 0 {
                    break;
                }
                append(&shared, &app, &id, &String::from_utf8_lossy(&bytes[..n]));
            }
        })
    };
    let out = pipe(
        Box::new(stdout),
        shared.clone(),
        app.clone(),
        task.id.clone(),
    );
    let err = pipe(
        Box::new(stderr),
        shared.clone(),
        app.clone(),
        task.id.clone(),
    );
    let began = std::time::Instant::now();
    let mut attention = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        let limit = if diagnostic {
            45
        } else if task.action == "download" {
            600
        } else {
            1200
        };
        if began.elapsed().as_secs() > limit && !attention {
            if diagnostic || task.action == "download" {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if diagnostic {
                    "Диагностическая команда превысила 45 секунд. Проверьте источник WinGet и повторите проверку.".into()
                } else {
                    "Превышено время загрузки (10 минут). Проверьте сеть и повторите через новый план.".into()
                });
            }
            attention = true;
            update(shared, app, &task.id, "attention", "Операция длится более 20 минут. Проверьте UAC и окно установщика. AppDock продолжает наблюдение за процессом; работающий установщик не отменён.");
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    let _ = out.join();
    let _ = err.join();
    Ok(status.code().unwrap_or(-1))
}
fn execute(shared: &Shared, app: &AppHandle, task: Task) {
    if let Err(message) = execute_inner(shared, app, &task) {
        update(shared, app, &task.id, "error", &message)
    }
}
fn run_winget(
    shared: &Shared,
    app: &AppHandle,
    task: &Task,
    command: std::process::Command,
) -> Result<i32, String> {
    let args = command
        .get_args()
        .map(std::ffi::OsStr::to_os_string)
        .collect();
    winget::run_with_recovery(
        args,
        |args| {
            append(shared, app, &task.id, &format!("WinGet: {args:?}"));
            let mut command = system::command("winget");
            command.args(args);
            let code = run_command(shared, app, task, command)?;
            append(
                shared,
                app,
                &task.id,
                &format!("WinGet завершился: 0x{:08X}", code as u32),
            );
            Ok(code)
        },
        |message| append(shared, app, &task.id, message),
    )
}
fn execute_inner(shared: &Shared, app: &AppHandle, task: &Task) -> Result<(), String> {
    let dependency = check_recovered_dependencies(shared, task);
    if let Some(reason) = dependency {
        update(shared, app, &task.id, "blocked", &reason);
        return Ok(());
    }
    let a = catalog::app(&task.app_id)?;
    let data = lock(shared).data_dir.clone();
    update(
        shared,
        app,
        &task.id,
        "checking",
        "Проверка источника, зависимостей и текущего состояния",
    );
    if let Some(parent_id) = &task.parent_id {
        let e = lock(shared);
        let parent = e.queue.tasks.iter().find(|t| &t.id == parent_id);
        if !parent.is_some_and(|t| {
            ["installed", "current", "reboot-required"].contains(&t.status.as_str())
        }) {
            drop(e);
            update(
                shared,
                app,
                &task.id,
                "action-required",
                "Сначала завершите установку VS Code, затем повторите эту задачу",
            );
            return Ok(());
        }
    }
    if task.action == "extension" {
        let id = task
            .selection
            .extensions
            .first()
            .ok_or("Не указано расширение")?;
        if !catalog::extensions()
            .iter()
            .any(|e| e["id"] == *id && e["verifiedAt"].is_string())
        {
            return Err("Расширение не входит в доверенный каталог".into());
        }
        let mut list = system::code_command()?;
        list.args(["--list-extensions", "--show-versions"]);
        let out = system::bounded_output(&mut list, 45)?;
        if out.status.success()
            && String::from_utf8_lossy(&out.stdout).lines().any(|l| {
                l.split('@')
                    .next()
                    .is_some_and(|i| i.eq_ignore_ascii_case(id))
            })
        {
            update(
                shared,
                app,
                &task.id,
                "current",
                "Расширение уже установлено в профиле текущего пользователя",
            );
            return Ok(());
        }
        update(
            shared,
            app,
            &task.id,
            "configuring",
            "Установка расширения через CLI VS Code в профиль текущего пользователя",
        );
        let mut cmd = system::code_command()?;
        cmd.args([
            "--install-extension",
            id,
            "--do-not-include-pack-dependencies",
        ]);
        let code = run_command(shared, app, task, cmd)?;
        if code != 0 {
            return Err(format!("VS Code CLI завершился с кодом {code}. Проверьте сеть и Marketplace, затем повторите задачу."));
        }
        let mut verify = system::code_command()?;
        verify.args(["--list-extensions"]);
        let result = system::bounded_output(&mut verify, 45)?;
        if !result.status.success()
            || !String::from_utf8_lossy(&result.stdout)
                .lines()
                .any(|s| s.trim().eq_ignore_ascii_case(id))
        {
            return Err(
                "CLI завершился, но расширение не обнаружено в профиле. Повторите проверку.".into(),
            );
        }
        update(
            shared,
            app,
            &task.id,
            "installed",
            "Расширение установлено и обнаружено в текущем профиле",
        );
        return Ok(());
    }
    catalog::validate(&task.selection)?;
    match task.action.as_str() {
        "open" => {
            open::that(catalog::text(&a, "website")).map_err(|e| e.to_string())?;
            update(
                shared,
                app,
                &task.id,
                "opened",
                "Официальный сервис открыт в браузере по умолчанию",
            );
            return Ok(());
        }
        "shortcut" => {
            let file = system::desktop_dir()?.join(format!("AppDock-{}.url", task.app_id));
            std::fs::write(
                file,
                format!(
                    "[InternetShortcut]\r\nURL={}\r\n",
                    catalog::text(&a, "website")
                ),
            )
            .map_err(|e| e.to_string())?;
            update(
                shared,
                app,
                &task.id,
                "shortcut-created",
                "Интернет-ярлык создан на рабочем столе",
            );
            return Ok(());
        }
        "guide" => {
            open::that(catalog::text(&a, "website")).map_err(|e| e.to_string())?;
            update(shared,app,&task.id,"action-required","Официальный источник открыт. Завершите установку или настройку в мастере производителя; AppDock не подтверждает её автоматически.");
            return Ok(());
        }
        _ => {}
    }
    let package = catalog::package_id(&a, &task.selection)?;
    if !a["platforms"]
        .as_array()
        .is_some_and(|p| p.iter().any(|p| p == "windows"))
    {
        return Err("Установка на Windows недоступна".into());
    }
    let sys = system::info();
    if sys.winget.is_none() {
        return Err("WinGet не найден. Установите App Installer из Microsoft Store.".into());
    }
    if !a["architectures"]
        .as_array()
        .is_some_and(|arch| arch.iter().any(|ar| ar == sys.arch.as_str()))
    {
        return Err("Архитектура не поддерживается проверенным пакетом".into());
    }
    if sys
        .free_disk_mb
        .is_some_and(|free| free < 512 + a["diskMb"].as_u64().unwrap_or(0))
    {
        return Err("Недостаточно места на системном диске. Освободите место и повторите.".into());
    }
    let mut show = system::command("winget");
    show.args([
        "show",
        "--id",
        &package,
        "--exact",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--disable-interactivity",
    ]);
    if task.app_id == "python" {
        show.args(["--version", "3.12.10"]);
    } else if let Some(v) = &task.selection.version {
        show.args(["--version", v]);
    }
    let shown = run_winget(shared, app, task, show)?;
    if shown != 0 {
        return Err(winget::failure(shown, &package));
    }
    let installed = system::scan(&data)?;
    let current = installed
        .iter()
        .find(|i| i.package_id.eq_ignore_ascii_case(&package));
    let full_profile = task.app_id == "visual-studio"
        && task.selection.options.get("fullProfile") == Some(&Value::Bool(true));
    if task.action != "download"
        && lock(shared).skip_current
        && (task.app_id == "python" || task.selection.version.is_some())
        && !full_profile
    {
        if let Some(i) = current {
            let target = if task.app_id == "python" {
                "3.12.10"
            } else {
                task.selection
                    .version
                    .as_deref()
                    .unwrap_or(catalog::text(&a, "version"))
            };
            if i.version == target || system::version_less(target, &i.version) {
                update(
                    shared,
                    app,
                    &task.id,
                    "current",
                    &format!(
                        "Уже установлена версия {}. Переустановка и понижение не выполняются.",
                        i.version
                    ),
                );
                return Ok(());
            }
        }
    }
    let verb = if task.action == "download" {
        "download"
    } else if current.is_some() && !full_profile {
        "upgrade"
    } else {
        "install"
    };
    let mut cmd = system::command("winget");
    cmd.args([
        verb,
        "--id",
        &package,
        "--exact",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--disable-interactivity",
    ]);
    if full_profile && current.is_some() {
        cmd.arg("--force");
    }
    if task.app_id == "python" {
        cmd.args(["--version", "3.12.10"]);
    } else if let Some(v) = &task.selection.version {
        cmd.args(["--version", v]);
    }
    if task.action == "download" {
        let download = system::download_dir(&data)
            .join(&task.app_id)
            .join(&task.id);
        std::fs::create_dir_all(&download).map_err(|e| e.to_string())?;
        cmd.arg("--download-directory")
            .arg(download)
            .args(["--architecture", &sys.arch]);
        update(shared,app,&task.id,"downloading","WinGet скачивает установщик и проверяет SHA-256 по манифесту. Процент и скорость не предоставлены адаптером.");
    } else {
        cmd.arg("--silent");
        if task.app_id == "vscode" {
            cmd.args(["--scope", "user"]);
        }
        if task.app_id == "python" {
            let b = |key: &str, default: bool| {
                task.selection
                    .options
                    .get(key)
                    .and_then(Value::as_bool)
                    .unwrap_or(default) as u8
            };
            let machine =
                task.selection.options.get("scope").and_then(Value::as_str) == Some("machine");
            let args = format!(
                "/quiet InstallAllUsers={} PrependPath={} Include_pip={} Include_test=0",
                machine as u8,
                b("path", true),
                b("pip", true)
            );
            cmd.args(["--override", &args]);
        }
        if task.app_id == "visual-studio"
            && task.selection.options.get("fullProfile") == Some(&Value::Bool(true))
        {
            let edition = task
                .selection
                .options
                .get("edition")
                .and_then(Value::as_str)
                .unwrap_or("community");
            let profiles: Value =
                serde_json::from_str(include_str!("../../catalog/vs-profiles.json"))
                    .map_err(|e| e.to_string())?;
            let profile = profiles["editions"]
                .as_array()
                .and_then(|eds| eds.iter().find(|e| e["id"] == edition))
                .ok_or("Профиль редакции не найден")?;
            let components: Vec<_> = profile["components"]
                .as_array()
                .ok_or("Неверный состав профиля")?
                .iter()
                .map(|c| c["id"].clone())
                .collect();
            let config = data.join(format!("AppDock-{edition}.vsconfig"));
            std::fs::write(
                &config,
                serde_json::to_vec_pretty(
                    &serde_json::json!({"version":"1.0","components":components}),
                )
                .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let modify = if current.is_some() {
                let path=system::vs_instance(edition,&[])?.ok_or("Существующий экземпляр Visual Studio 2026 не найден через vswhere. Проверьте редакцию в Installer.")?;
                format!("modify --installPath \"{}\" ", path.display())
            } else {
                String::new()
            };
            let args=format!("{modify}--wait --passive --norestart --config \"{}\" --includeRecommended --includeOptional",config.display());
            cmd.args(["--override", &args]);
        }
        update(shared,app,&task.id,"installing","WinGet выполняет установку; при необходимости подтвердите штатный UAC. Автоматическая перезагрузка не разрешена.");
    }
    let code = run_winget(shared, app, task, cmd)?;
    let unsigned = code as u32;
    if unsigned == 0x8A15002B {
        update(
            shared,
            app,
            &task.id,
            "current",
            "WinGet: применимое обновление отсутствует",
        );
        return Ok(());
    }
    if code == 3010 || code == 1641 || unsigned == 0x8A150109 || unsigned == 0x8A15010A {
        update(shared,app,&task.id,"reboot-required","Установщик требует перезагрузку. Перезагрузите компьютер самостоятельно после завершения задач.");
        return Ok(());
    }
    if code != 0 {
        return Err(winget::failure(code, &package));
    }
    if task.action == "download" {
        crate::downloads::record(&data, task)?;
        update(
            shared,
            app,
            &task.id,
            "downloaded",
            "WinGet завершил скачивание и проверку файлов. Установка не запускалась.",
        );
        return Ok(());
    }
    update(
        shared,
        app,
        &task.id,
        "verifying",
        "Проверка обнаружения после завершения установщика",
    );
    let detected = system::scan(&data)?;
    if !detected
        .iter()
        .any(|i| i.package_id.eq_ignore_ascii_case(&package))
    {
        update(shared,app,&task.id,"action-required","Установщик завершился успешно, но программа пока не обнаружена. Проверьте приложение и перезапустите проверку.");
        return Ok(());
    }
    if let Some(found) = detected
        .iter()
        .find(|i| i.package_id.eq_ignore_ascii_case(&package))
    {
        if let Some(saved) = lock(shared)
            .queue
            .tasks
            .iter_mut()
            .find(|t| t.id == task.id)
        {
            saved.actual_version = Some(found.version.clone());
            saved.evidence = Some("detected".into());
        }
    }
    if full_profile {
        let edition = task
            .selection
            .options
            .get("edition")
            .and_then(Value::as_str)
            .unwrap_or("community");
        let profiles: Value = serde_json::from_str(include_str!("../../catalog/vs-profiles.json"))
            .map_err(|e| e.to_string())?;
        let profile = profiles["editions"]
            .as_array()
            .and_then(|eds| eds.iter().find(|e| e["id"] == edition))
            .ok_or("Профиль редакции не найден")?;
        let ids: Vec<String> = profile["components"]
            .as_array()
            .ok_or("Состав профиля отсутствует")?
            .iter()
            .filter_map(|c| c["id"].as_str().map(String::from))
            .collect();
        if system::vs_instance(edition, &ids)?.is_none() {
            update(shared,app,&task.id,"action-required","Частичная установка Visual Studio: не все компоненты снимка обнаружены через vswhere. Откройте Installer и проверьте совместимость / пропуски.");
            return Ok(());
        }
        append(shared,app,&task.id,"Все компоненты проверенного снимка профиля обнаружены через vswhere. Снятые с поддержки компоненты не включены.");
    }
    if ["android-studio", "docker", "podman"].contains(&task.app_id.as_str()) {
        update(shared,app,&task.id,"action-required","Основной пакет обнаружен. Завершите настройку SDK / среды / лицензий по официальной инструкции. Дополнительное окружение не создавалось.");
        return Ok(());
    }
    update(
        shared,
        app,
        &task.id,
        "installed",
        "Программа установлена и обнаружена в системе",
    );
    Ok(())
}
pub fn spawn_worker(shared: &Shared, app: AppHandle) {
    {
        let mut e = lock(shared);
        if e.worker_active {
            return;
        }
        e.worker_active = true;
        e.queue.running = true;
        let _ = e.save();
    }
    let shared = shared.clone();
    std::thread::spawn(move || loop {
        let tasks = {
            let mut e = lock(&shared);
            let queued: Vec<_> = e
                .queue
                .tasks
                .iter()
                .filter(|t| t.status == "queued")
                .cloned()
                .collect();
            if queued.is_empty() {
                e.queue.running = false;
                e.worker_active = false;
                finish_run(&mut e.queue);
                let _ = e.save();
                let _ = app.emit("queue-changed", &e.queue);
                return;
            }
            if e.queue.paused {
                drop(e);
                system::pause_briefly();
                continue;
            }
            let dispatched = if queued[0].action == "download" {
                queued
                    .into_iter()
                    .take_while(|t| t.action == "download")
                    .take(e.parallel_downloads)
                    .collect::<Vec<_>>()
            } else {
                vec![queued[0].clone()]
            };
            for task in &dispatched {
                if let Some(saved) = e.queue.tasks.iter_mut().find(|t| t.id == task.id) {
                    saved.status = "checking".into();
                    saved.started_at = Some(now());
                    saved.message = "Задача передана исполнителю".into();
                }
            }
            if let Err(err) = e.save() {
                for task in &dispatched {
                    if let Some(t) = e.queue.tasks.iter_mut().find(|t| t.id == task.id) {
                        t.status = "queued".into();
                    }
                }
                e.worker_active = false;
                e.queue.running = false;
                e.queue.paused = true;
                e.queue.storage_error = Some(err);
                let _ = app.emit("queue-changed", &e.queue);
                return;
            }
            dispatched
        };
        std::thread::scope(|scope| {
            for task in tasks {
                let s = &shared;
                let a = &app;
                scope.spawn(move || execute(s, a, task));
            }
        });
    });
}
pub fn control(
    shared: &Shared,
    app: AppHandle,
    action: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    let mut should_spawn = false;
    {
        let mut e = lock(shared);
        match action {
            "pause" => e.queue.paused = true,
            "resume" => {
                if !e.queue.tasks.iter().any(|t| t.status == "queued") {
                    return Err("Нет ожидающих задач".into());
                }
                e.queue.paused = false;
                should_spawn = !e.worker_active;
            }
            "cancel" => {
                for t in &mut e.queue.tasks {
                    if t.status == "queued" && task_id.is_none_or(|id| t.id == id) {
                        t.status = "cancelled".into();
                        t.message =
                            "Отменено пользователем. Работающий установщик не прерывается.".into();
                        t.finished_at = Some(now())
                    }
                }
                if !e.worker_active {
                    e.queue.running = false
                }
            }
            "retry" => return Err("Повтор требует нового плана. Используйте «Повторить ошибки» и подтвердите проверку.".into()),
            "complete-manual" => {
                let t = e.queue.tasks.iter_mut().find(|t| Some(t.id.as_str()) == task_id).ok_or("Задача не найдена")?;
                if t.status != "action-required" { return Err("Эта задача не ожидает ручного действия".into()); }
                t.status = "user-completed".into(); t.evidence = Some("user".into()); t.finished_at = Some(now()); t.message = "Пользователь отметил шаг выполненным; обнаружение не подтверждено".into();
                let run_id=t.run_id.clone();if e.queue.tasks.iter().filter(|t|t.run_id==run_id).all(|t|terminal(&t.status)){finish_run_id(&mut e.queue,&run_id);}
            }
            "clear" => {
                if e.worker_active {
                    return Err("Сначала завершите очередь".into());
                }
                // Keep completed records referenced by pending dependencies.
                let referenced:HashSet<_>=e.queue.tasks.iter().filter(|t|!terminal(&t.status)).flat_map(|t|t.dependencies.clone()).collect();
                e.queue.tasks.retain(|t| !terminal(&t.status)||referenced.contains(&t.id));
                let remaining:HashSet<_>=e.queue.tasks.iter().map(|t|t.run_id.clone()).collect();e.queue.runs.retain(|r|remaining.contains(&r.id));
            }
            _ => return Err("Неизвестное управление очередью".into()),
        }
        e.save()?;
        let _ = app.emit("queue-changed", &e.queue);
    }
    if should_spawn {
        spawn_worker(shared, app)
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task(status: &str) -> Task {
        Task {
            run_id: String::new(),
            dependencies: vec![],
            last_activity_at: 0,
            actual_version: None,
            evidence: None,
            id: uuid::Uuid::new_v4().to_string(),
            app_id: "chrome".into(),
            name: "Google Chrome".into(),
            action: "install".into(),
            status: status.into(),
            message: String::new(),
            log: vec![],
            percent: None,
            parent_id: None,
            selection: Selection {
                app_id: "chrome".into(),
                action: "install".into(),
                options: Default::default(),
                extensions: vec![],
                version: None,
            },
            started_at: None,
            finished_at: None,
        }
    }
    #[test]
    fn interrupted_queue_is_restored_paused_without_repeating_completed_tasks() {
        let path = std::env::temp_dir().join(format!("appdock-recovery-{}", uuid::Uuid::new_v4()));
        let mut first = Engine::load(path.clone());
        first.queue.tasks = vec![task("installed"), task("installing"), task("error")];
        first.queue.running = true;
        first.save().unwrap();
        let restored = Engine::load(path.clone());
        assert!(!restored.queue.running);
        assert!(restored.queue.paused);
        assert_eq!(
            restored
                .queue
                .tasks
                .iter()
                .map(|t| t.status.as_str())
                .collect::<Vec<_>>(),
            vec!["installed", "queued", "error"]
        );
        assert!(restored.pending.is_none());
        assert!(!restored.worker_active);
        std::fs::remove_file(path.join("queue.json")).unwrap();
        std::fs::remove_dir(path).unwrap();
    }
    #[test]
    fn atomic_save_replaces_previous_snapshot() {
        let path = std::env::temp_dir().join(format!("appdock-storage-{}", uuid::Uuid::new_v4()));
        let mut state = Engine::load(path.clone());
        state.queue.tasks.push(task("queued"));
        state.save().unwrap();
        state.queue.tasks[0].status = "installed".into();
        state.save().unwrap();
        let restored = Engine::load(path.clone());
        assert_eq!(restored.queue.tasks[0].status, "installed");
        assert!(!path.join("queue.tmp").exists());
        std::fs::remove_file(path.join("queue.json")).unwrap();
        std::fs::remove_dir(path).unwrap();
    }
    #[test]
    fn retry_is_scoped_to_one_run_and_exact_status() {
        let mut queue = Queue::default();
        for (run, status) in [
            ("a", "error"),
            ("a", "cancelled"),
            ("a", "action-required"),
            ("b", "error"),
        ] {
            let mut t = task(status);
            t.run_id = run.into();
            queue.tasks.push(t);
        }
        assert_eq!(retry_candidates(&queue, "a", "error", None, None).len(), 1);
        assert_eq!(
            retry_candidates(&queue, "a", "cancelled", None, None).len(),
            1
        );
        assert!(retry_candidates(&queue, "a", "error", Some(&queue.tasks[3].id), None).is_empty());
    }
    #[test]
    fn finished_run_outcome_ignores_a_long_history() {
        let mut q = Queue::default();
        for _ in 0..120 {
            let mut t = task("error");
            t.run_id = "old".into();
            q.tasks.push(t)
        }
        let mut t = task("installed");
        t.run_id = "new".into();
        q.tasks.push(t);
        q.current_run_id = Some("new".into());
        q.runs.push(Run {
            id: "new".into(),
            created_at: now(),
            finished_at: None,
            mode: "live".into(),
            skip_current: false,
            parallel_downloads: 3,
            selections: vec![],
            outcome: "running".into(),
        });
        finish_run(&mut q);
        assert_eq!(q.runs[0].outcome, "completed");
    }
    #[test]
    fn expanded_plan_carries_extension_dependencies_and_partial_downloads() {
        let mut vscode = task("queued").selection;
        vscode.app_id = "vscode".into();
        vscode.extensions = vec!["ms-python.vscode-pylance".into(), "ms-python.python".into()];
        let mut chrome = task("queued").selection;
        let tasks = build_tasks(&[vscode, chrome.clone()]).unwrap();
        let python = tasks
            .iter()
            .find(|t| t.action == "extension" && t.selection.extensions[0] == "ms-python.python")
            .unwrap();
        let pylance = tasks
            .iter()
            .find(|t| {
                t.action == "extension" && t.selection.extensions[0] == "ms-python.vscode-pylance"
            })
            .unwrap();
        assert!(pylance.dependencies.contains(&python.id));
        let mut failed = tasks.clone();
        for t in &mut failed {
            if t.id == python.id {
                t.status = "error".into();
                t.message = "Нет сети".into();
            } else {
                t.status = "installed".into();
            }
        }
        assert!(dependency_failure(pylance, &failed)
            .unwrap()
            .contains("Нет сети"));
        assert!(dependency_failure(
            tasks.iter().find(|t| t.app_id == "chrome").unwrap(),
            &failed
        )
        .is_none());
        chrome.action = "download".into();
        let mut manual = chrome.clone();
        manual.app_id = "postgres".into();
        let mut web = chrome.clone();
        web.app_id = "github".into();
        assert_eq!(build_tasks(&[chrome, manual, web]).unwrap().len(), 1);
    }
    #[test]
    fn restored_policy_is_not_replaced_by_defaults() {
        let path = std::env::temp_dir().join(format!("appdock-policy-{}", uuid::Uuid::new_v4()));
        let mut e = Engine::load(path.clone());
        e.queue.tasks = vec![task("installing")];
        migrate_queue(&mut e.queue);
        e.queue.runs[0].skip_current = false;
        e.queue.runs[0].parallel_downloads = 3;
        e.save().unwrap();
        let restored = Engine::load(path.clone());
        assert!(!restored.skip_current);
        assert_eq!(restored.parallel_downloads, 3);
        assert!(restored.queue.paused);
        std::fs::remove_file(path.join("queue.json")).unwrap();
        std::fs::remove_dir(path).unwrap();
    }
    #[test]
    fn corruption_is_preserved_and_write_denial_is_visible() {
        let path = std::env::temp_dir().join(format!("appdock-corrupt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("queue.json"), "{broken").unwrap();
        let mut e = Engine::load(path.clone());
        assert!(e.queue.storage_error.is_some());
        assert!(std::fs::read_dir(&path).unwrap().flatten().any(|e| e
            .file_name()
            .to_string_lossy()
            .starts_with("queue-corrupt-")));
        std::fs::create_dir(path.join("queue.tmp")).unwrap();
        assert!(e.save().is_err());
        assert!(e.queue.storage_error.is_some());
        assert!(e.queue.paused);
        std::fs::remove_dir(path.join("queue.tmp")).unwrap();
        for entry in std::fs::read_dir(&path).unwrap().flatten() {
            std::fs::remove_file(entry.path()).unwrap();
        }
        std::fs::remove_dir(path).unwrap();
    }
}
