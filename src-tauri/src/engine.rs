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
}
pub type Shared = Arc<Mutex<Engine>>;
pub fn lock(shared: &Shared) -> std::sync::MutexGuard<'_, Engine> {
    shared.lock().unwrap_or_else(|e| e.into_inner())
}
impl Engine {
    pub fn load(data_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&data_dir);
        let mut queue: Queue = std::fs::read_to_string(data_dir.join("queue.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
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
        Self {
            queue,
            pending: None,
            data_dir,
            worker_active: false,
            skip_current: true,
            parallel_downloads: 2,
        }
    }
    pub fn save(&mut self) -> Result<(), String> {
        self.queue.updated_at = now();
        let path = self.data_dir.join("queue.json");
        let temp = self.data_dir.join("queue.tmp");
        let bytes = serde_json::to_vec_pretty(&self.queue).map_err(|e| e.to_string())?;
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
            f.write_all(&bytes).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())
    }
}
pub fn update(shared: &Shared, app: &AppHandle, id: &str, status: &str, message: &str) {
    let mut e = lock(shared);
    if let Some(t) = e.queue.tasks.iter_mut().find(|t| t.id == id) {
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
    let _ = e.save();
    let _ = app.emit("queue-changed", &e.queue);
}
fn append(shared: &Shared, app: &AppHandle, id: &str, line: &str) {
    let mut e = lock(shared);
    if let Some(t) = e.queue.tasks.iter_mut().find(|t| t.id == id) {
        let clean = line.replace('\0', "");
        if !clean.trim().is_empty() {
            t.log.push(clean.trim().chars().take(1500).collect());
            if t.log.len() > 300 {
                t.log.remove(0);
            }
        }
    }
    let _ = e.save();
    let _ = app.emit("queue-changed", &e.queue);
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
    let installed = if system.winget.is_some() {
        system::scan(&data)?
    } else {
        vec![]
    };
    let mut result = Vec::new();
    let mut ids = HashSet::new();
    let mut warnings = vec![];
    if !system.windows {
        return Err("Рабочий режим поддерживается только в Windows".into());
    }
    let mut disk = 0;
    let mut unknown_size = false;
    for s in &items {
        let a = catalog::validate(s)?;
        if !ids.insert(s.app_id.clone()) {
            return Err("Повторяющаяся программа в плане".into());
        }
        let mut item_warnings = Vec::new();
        let mut blocked = false;
        let native_action = ["install", "download"].contains(&s.action.as_str());
        if native_action {
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
        result.push(PlanItem {
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
            if ["install", "download"].contains(&r.action.as_str()) {
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
        let mut tasks = Vec::new();
        for s in p.items {
            let a = catalog::validate(&s)?;
            let id = uuid::Uuid::new_v4().to_string();
            tasks.push(Task {
                id: id.clone(),
                app_id: s.app_id.clone(),
                name: catalog::text(&a, "name").into(),
                action: s.action.clone(),
                status: "queued".into(),
                message: "Ожидает проверки".into(),
                log: vec![],
                percent: None,
                parent_id: None,
                selection: s.clone(),
                started_at: None,
                finished_at: None,
            });
            if s.app_id == "vscode" && s.action == "install" {
                for ext in catalog::extensions()
                    .iter()
                    .filter(|ext| s.extensions.iter().any(|id| ext["id"] == *id))
                {
                    let mut ext_selection = s.clone();
                    ext_selection.extensions = vec![catalog::text(ext, "id").into()];
                    tasks.push(Task {
                        id: uuid::Uuid::new_v4().to_string(),
                        app_id: s.app_id.clone(),
                        name: catalog::text(ext, "name").into(),
                        action: "extension".into(),
                        status: "queued".into(),
                        message: "После VS Code".into(),
                        log: vec![],
                        percent: None,
                        parent_id: Some(id.clone()),
                        selection: ext_selection,
                        started_at: None,
                        finished_at: None,
                    })
                }
            }
        }
        e.skip_current = p.skip_current;
        e.parallel_downloads = p.parallel_downloads;
        e.queue.tasks.extend(tasks);
        e.queue.mode = "live".into();
        e.queue.running = true;
        e.queue.paused = false;
        e.save()?;
    }
    spawn_worker(shared, app);
    Ok(())
}
fn run_command(
    shared: &Shared,
    app: &AppHandle,
    task: &Task,
    mut command: std::process::Command,
) -> Result<i32, String> {
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
    let status = child.wait().map_err(|e| e.to_string())?;
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
        let out = list.output().map_err(|e| e.to_string())?;
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
        let result = verify.output().map_err(|e| e.to_string())?;
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
        let download = system::download_dir(&data).join(&task.app_id);
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
            let _ = e.save();
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
            "retry" => {
                if e.worker_active && !e.queue.paused {
                    return Err("Приостановите очередь перед повтором".into());
                }
                for t in &mut e.queue.tasks {
                    if ["error", "action-required", "cancelled"].contains(&t.status.as_str())
                        && task_id.is_none_or(|id| t.id == id)
                    {
                        t.status = "queued".into();
                        t.finished_at = None;
                        t.message = "Повторная проверка состояния перед выполнением".into();
                    }
                }
                e.queue.paused = false;
                should_spawn = !e.worker_active
            }
            "clear" => {
                if e.worker_active {
                    return Err("Сначала завершите очередь".into());
                }
                e.queue.tasks.retain(|t| !terminal(&t.status));
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
}
