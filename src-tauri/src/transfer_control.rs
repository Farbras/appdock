use std::time::{Duration, Instant};

pub const CANCELLED: &str = "APPDOCK_DOWNLOAD_CANCELLED";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Request {
    Run,
    Pause,
    Cancel,
}

pub struct ProcessPause {
    #[cfg(windows)]
    handle: std::os::windows::io::OwnedHandle,
    began: Instant,
    paused_at: Option<Instant>,
    paused_total: Duration,
}

#[cfg(windows)]
#[link(name = "ntdll")]
extern "system" {
    fn NtSuspendProcess(handle: *mut std::ffi::c_void) -> i32;
    fn NtResumeProcess(handle: *mut std::ffi::c_void) -> i32;
}

impl ProcessPause {
    pub fn new(pid: u32) -> Result<Self, String> {
        #[cfg(windows)]
        let handle = {
            use std::os::windows::io::FromRawHandle;
            use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SUSPEND_RESUME};
            // Retain the process object for this operation, preventing PID reuse.
            let raw = unsafe { OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid) };
            if raw.is_null() {
                return Err(format!(
                    "Недоступно управление загрузкой: {}",
                    std::io::Error::last_os_error()
                ));
            }
            unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw) }
        };
        #[cfg(not(windows))]
        let _ = pid;
        Ok(Self {
            #[cfg(windows)]
            handle,
            began: Instant::now(),
            paused_at: None,
            paused_total: Duration::ZERO,
        })
    }

    pub fn paused(&self) -> bool {
        self.paused_at.is_some()
    }

    pub fn set_paused(&mut self, paused: bool) -> Result<bool, String> {
        if paused == self.paused() {
            return Ok(false);
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let status = unsafe {
                if paused {
                    NtSuspendProcess(self.handle.as_raw_handle())
                } else {
                    NtResumeProcess(self.handle.as_raw_handle())
                }
            };
            if status < 0 {
                return Err(format!(
                    "Не удалось {} загрузку (0x{:08X})",
                    if paused {
                        "приостановить"
                    } else {
                        "продолжить"
                    },
                    status as u32
                ));
            }
        }
        #[cfg(not(windows))]
        return Err("Управление загрузкой поддерживается в Windows".into());
        #[cfg(windows)]
        {
            if paused {
                self.paused_at = Some(Instant::now());
            } else if let Some(since) = self.paused_at.take() {
                self.paused_total += since.elapsed();
            }
            Ok(true)
        }
    }

    pub fn elapsed(&self) -> Duration {
        self.began
            .elapsed()
            .saturating_sub(self.paused_total)
            .saturating_sub(self.paused_at.map(|t| t.elapsed()).unwrap_or_default())
    }
}

impl Drop for ProcessPause {
    fn drop(&mut self) {
        let _ = self.set_paused(false);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        process::Stdio,
    };

    #[test]
    fn a_real_curl_transfer_stops_on_pause_continues_and_can_be_killed_while_paused() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0u8; 4096];
            stream.read(&mut request).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                65536 * 256
            )
            .unwrap();
            for _ in 0..256 {
                if stream.write_all(&[0x5a; 65536]).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let file =
            std::env::temp_dir().join(format!("appdock-transfer-{}.part", uuid::Uuid::new_v4()));
        let mut child = crate::system::command("curl.exe")
            .args([
                "--disable",
                "--silent",
                "--fail",
                "--noproxy",
                "*",
                "--max-time",
                "15",
                "--output",
            ])
            .arg(&file)
            .arg(format!("http://{address}/test"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut control = ProcessPause::new(child.id()).unwrap();
        let size = || std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
        let began = Instant::now();
        while size() < 131072 && began.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(size() > 0);
        control.set_paused(true).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let stopped = size();
        let active_time = control.elapsed();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(size(), stopped, "file continued growing while paused");
        assert!(control.elapsed().saturating_sub(active_time) < Duration::from_millis(20));
        control.set_paused(false).unwrap();
        let resumed = Instant::now();
        while size() == stopped && resumed.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(size() > stopped, "transfer did not continue after resume");
        control.set_paused(true).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        drop(control);
        let cancelled_size = size();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(size(), cancelled_size);
        server.join().unwrap();
        std::fs::remove_file(file).unwrap();
    }
}
