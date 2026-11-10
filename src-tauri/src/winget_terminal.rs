use crate::transfer_control::{self, ProcessPause, Request};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    io::{Read, Write},
    process::Command,
    sync::mpsc,
    time::Duration,
};

pub enum Event {
    Output(Vec<u8>),
    Tick(Duration),
    Paused(bool),
}

// WinGet suppresses progress when stdout is redirected. ConPTY gives each
// operation its own hidden console without changing the user's terminal.
#[cfg(test)]
pub fn run(
    command: &Command,
    observe: impl FnMut(Event) -> Result<(), String>,
) -> Result<i32, String> {
    run_controlled(command, || Request::Run, observe)
}

pub fn run_controlled(
    command: &Command,
    mut request: impl FnMut() -> Request,
    mut observe: impl FnMut(Event) -> Result<(), String>,
) -> Result<i32, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 40,
            cols: 240,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Не удалось создать терминал WinGet: {e}"))?;
    let mut builder = CommandBuilder::new(command.get_program());
    builder.args(command.get_args());
    if let Some(dir) = command.get_current_dir() {
        builder.cwd(dir);
    }
    for (key, value) in command.get_envs() {
        match value {
            Some(value) => builder.env(key, value),
            None => builder.env_remove(key),
        }
    }
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut input = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("Не удалось запустить WinGet: {e}"))?;
    let mut pause = ProcessPause::new(child.process_id().ok_or("Недоступен процесс загрузки")?)?;
    drop(pair.slave);
    let (sender, receiver) = mpsc::channel();
    let output = std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buffer) {
            if n == 0 || sender.send(buffer[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut queries = Vec::new();
    let result = (|| loop {
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(bytes) => {
                queries.extend_from_slice(&bytes);
                if queries.windows(4).any(|s| s == b"\x1b[6n") {
                    // ConPTY asks for the initial cursor before the child can write.
                    input.write_all(b"\x1b[1;1R").map_err(|e| e.to_string())?;
                    queries.clear();
                } else if queries.windows(3).any(|s| s == b"\x1b[c") {
                    input.write_all(b"\x1b[?1;0c").map_err(|e| e.to_string())?;
                    queries.clear();
                }
                if queries.len() > 16 {
                    queries.drain(..queries.len() - 16);
                }
                observe(Event::Output(bytes))?;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                std::thread::sleep(Duration::from_millis(100))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Ok(status.exit_code() as i32);
        }
        let next = request();
        if next == Request::Cancel {
            return Err(transfer_control::CANCELLED.into());
        }
        if pause.set_paused(next == Request::Pause)? {
            observe(Event::Paused(pause.paused()))?;
        }
        if !pause.paused() {
            observe(Event::Tick(pause.elapsed()))?;
        }
    })();
    if result.is_err() {
        let _ = pause.set_paused(false);
        let _ = child.kill();
        let _ = child.wait();
    }
    // Closing ConPTY flushes its final screen updates to the active reader.
    drop(input);
    drop(pair.master);
    let _ = output.join();
    for bytes in receiver.try_iter() {
        observe(Event::Output(bytes))?;
    }
    result
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn hidden_terminal_preserves_arguments_output_and_windows_exit_codes() {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::WriteLine($env:APPDOCK_TERMINAL_TEST); exit -1978335215",
        ]);
        command.env(
            "APPDOCK_TERMINAL_TEST",
            "path with spaces & literal quotes: \"text\"",
        );
        let mut output = vec![];
        let code = run(&command, |event| {
            match event {
                Event::Output(bytes) => output.extend_from_slice(&bytes),
                Event::Tick(time) if time.as_secs() > 10 => return Err("test timed out".into()),
                _ => {}
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(code as u32, 0x8A150011);
        assert!(String::from_utf8_lossy(&output)
            .contains("path with spaces & literal quotes: \"text\""));
    }

    #[test]
    fn a_paused_terminal_process_can_be_resumed_then_cancelled() {
        use std::cell::Cell;
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "while ($true) { [Console]::WriteLine('tick'); Start-Sleep -Milliseconds 50 }",
        ]);
        let request = Cell::new(Request::Run);
        let paused_at = Cell::new(None::<Instant>);
        let pauses = Cell::new(0);
        let mut ticks = 0;
        let mut resumes = 0;
        let began = Instant::now();
        let result = run_controlled(
            &command,
            || {
                if began.elapsed() > Duration::from_secs(10) {
                    return Request::Cancel;
                }
                if paused_at
                    .get()
                    .is_some_and(|t| t.elapsed() > Duration::from_millis(250))
                {
                    if pauses.get() == 1 {
                        return Request::Run;
                    }
                    return Request::Cancel;
                }
                request.get()
            },
            |event| {
                match event {
                    Event::Output(bytes) if String::from_utf8_lossy(&bytes).contains("tick") => {
                        ticks += 1;
                        if (pauses.get() == 0 && ticks >= 2) || (resumes == 1 && ticks >= 4) {
                            request.set(Request::Pause);
                        }
                    }
                    Event::Paused(true) => {
                        pauses.set(pauses.get() + 1);
                        paused_at.set(Some(Instant::now()));
                    }
                    Event::Paused(false) => {
                        resumes += 1;
                        request.set(Request::Run);
                        paused_at.set(None);
                    }
                    _ => {}
                }
                Ok(())
            },
        );
        assert_eq!(result, Err(transfer_control::CANCELLED.into()));
        assert_eq!(pauses.get(), 2);
        assert_eq!(resumes, 1);
    }

    #[test]
    fn timeout_terminates_the_process_and_drains_the_terminal() {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        let began = Instant::now();
        let result = run(&command, |event| {
            if matches!(event, Event::Tick(time) if time >= Duration::from_millis(500)) {
                return Err("test timeout".into());
            }
            Ok(())
        });
        assert_eq!(result, Err("test timeout".into()));
        assert!(began.elapsed() < Duration::from_secs(10));
    }
}
