use crate::models::DownloadProgress;
use std::time::Duration;

// WinGet's byte counters use binary units and CR-delimited terminal frames.
// Ignore percentage-only installer/source progress.
// Format: microsoft/winget-cli, AppInstallerCLICore/ExecutionProgress.cpp.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Counter {
    downloaded: u64,
    total: Option<u64>,
    complete: bool,
}

#[derive(Default)]
pub struct WingetProgress {
    frame: Vec<u8>,
    escape: u8,
    overflow: bool,
    carriage_counter: Option<Counter>,
    latest: Option<Counter>,
    sampled: Option<Counter>,
    sampled_at: Duration,
    restart: bool,
    log: Vec<String>,
}

pub struct Snapshot {
    pub progress: DownloadProgress,
    pub complete: bool,
}

fn bytes(number: &str, unit: &str) -> Option<u64> {
    let power = match unit {
        "B" => 0,
        "KB" | "KiB" => 10,
        "MB" | "MiB" => 20,
        "GB" | "GiB" => 30,
        "TB" | "TiB" => 40,
        _ => return None,
    };
    if !number
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
    {
        return None;
    }
    let value = number.replace(',', ".").parse::<f64>().ok()? * (1u64 << power) as f64;
    (value.is_finite() && value >= 0.0 && value < u64::MAX as f64).then_some(value.round() as u64)
}

fn counter(frame: &[u8], complete: bool) -> Option<Counter> {
    let text = String::from_utf8_lossy(frame);
    let fields: Vec<_> = text.split_whitespace().collect();
    let count = fields.len();
    if count < 2 {
        return None;
    }
    let (start, downloaded, total) = if count >= 5 && fields[count - 3] == "/" {
        (
            count - 5,
            bytes(fields[count - 5], fields[count - 4])?,
            Some(bytes(fields[count - 2], fields[count - 1])?),
        )
    } else {
        (
            count - 2,
            bytes(fields[count - 2], fields[count - 1])?,
            None,
        )
    };
    // A log message ending in a size is not a transfer counter.
    if fields[..start]
        .iter()
        .any(|s| !s.chars().all(|c| ('\u{2580}'..='\u{259f}').contains(&c)))
        || total == Some(0)
        || total.is_some_and(|n| downloaded > n)
    {
        return None;
    }
    Some(Counter {
        downloaded,
        total,
        complete: complete && total == Some(downloaded),
    })
}

impl WingetProgress {
    pub fn feed(&mut self, input: &[u8]) {
        for &byte in input {
            // Strip CSI and OSC sequences across read boundaries.
            match self.escape {
                1 => {
                    self.escape = match byte {
                        b'[' => 2,
                        b']' => 3,
                        _ => 0,
                    };
                    continue;
                }
                2 => {
                    if (0x40..=0x7e).contains(&byte) {
                        self.escape = 0;
                    }
                    continue;
                }
                3 => {
                    if byte == 7 {
                        self.escape = 0;
                    } else if byte == 27 {
                        self.escape = 4;
                    }
                    continue;
                }
                4 => {
                    self.escape = if byte == b'\\' { 0 } else { 3 };
                    continue;
                }
                _ => {}
            }
            match byte {
                27 => self.escape = 1,
                b'\r' => {
                    self.observe(false);
                    self.log_line();
                    self.carriage_counter = if self.overflow {
                        None
                    } else {
                        counter(&self.frame, false)
                    };
                    self.frame.clear();
                    self.overflow = false;
                }
                b'\n' => {
                    self.log_line();
                    if self.frame.is_empty() {
                        if let Some(last) = self.carriage_counter {
                            self.latest = Some(Counter {
                                complete: last.total == Some(last.downloaded),
                                ..last
                            });
                        }
                    } else {
                        self.observe(true);
                    }
                    self.carriage_counter = None;
                    self.frame.clear();
                    self.overflow = false;
                }
                _ if self.frame.len() < 8192 && !self.overflow => {
                    self.carriage_counter = None;
                    self.frame.push(byte);
                }
                _ => {
                    self.frame.clear();
                    self.overflow = true;
                }
            }
        }
        // WinGet flushes the current frame before writing its next CR.
        // A standalone byte count may be the beginning of a split "x / y"
        // frame. Wait for a delimiter before accepting unknown-size counters.
        if self.frame.contains(&b'/') {
            self.observe(false);
        }
    }

    pub fn succeed(&mut self) {
        // Only a successful process can complete an unknown-size transfer.
        // A newline also occurs when WinGet aborts an incomplete download.
        if let Some(last) = self.latest {
            self.latest = Some(Counter {
                total: Some(last.downloaded),
                complete: true,
                ..last
            });
        }
    }

    pub fn reset_speed(&mut self) {
        self.sampled = None;
    }
    pub fn completed(&self) -> bool {
        self.latest.is_some_and(|c| c.complete)
    }

    fn log_line(&mut self) {
        if self.overflow || counter(&self.frame, false).is_some() {
            return;
        }
        let text = String::from_utf8_lossy(&self.frame);
        let text = text.trim().replace('\0', "");
        if !text.is_empty() && !["-", "\\", "|", "/"].contains(&text.as_str()) {
            self.log.push(text);
        }
    }

    pub fn take_log(&mut self) -> Vec<String> {
        std::mem::take(&mut self.log)
    }

    fn observe(&mut self, complete: bool) {
        if self.overflow {
            return;
        }
        if let Some(next) = counter(&self.frame, complete) {
            if let Some(last) = self.latest {
                if last != next
                    && (last.complete
                        || next.downloaded < last.downloaded
                        || (!next.complete && next.total != last.total))
                {
                    self.restart = true;
                }
            }
            self.latest = Some(next);
        }
    }

    pub fn poll(&mut self, elapsed: Duration) -> Option<Snapshot> {
        let next = self.latest?;
        let interval = elapsed.saturating_sub(self.sampled_at);
        let first = self.sampled.is_none() || self.restart;
        let completed = next.complete && self.sampled != Some(next);
        if !first && !completed && (next.complete || interval < Duration::from_millis(500)) {
            return None;
        }
        let speed = if first || next.complete || interval.is_zero() {
            0.0
        } else {
            next.downloaded.saturating_sub(self.sampled?.downloaded) as f64 / interval.as_secs_f64()
        };
        self.sampled = Some(next);
        self.sampled_at = elapsed;
        self.restart = false;
        Some(Snapshot {
            progress: DownloadProgress::new(next.downloaded, next.total, speed),
            complete: next.complete,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragmented_ansi_frames_report_speed_remaining_and_completion() {
        let mut tracker = WingetProgress::default();
        for chunk in b"\x1b[0m\r  1.00 MB / 4.00 MB\x1b]9;4;1;25\x07".chunks(3) {
            tracker.feed(chunk);
        }
        let first = tracker.poll(Duration::ZERO).unwrap();
        assert_eq!(first.progress.percent(), Some(25.0));
        assert_eq!(first.progress.remaining_seconds, None);
        tracker.feed(b"\r  2.00 MB / 4.00 MB");
        let sample = tracker.poll(Duration::from_secs(1)).unwrap();
        assert_eq!(sample.progress.bytes_per_second, 1048576.0);
        assert_eq!(sample.progress.remaining_bytes, Some(2097152));
        assert_eq!(sample.progress.remaining_seconds, Some(2));
        tracker.feed(b"\r  4.00 MB / 4.00 MB\r");
        tracker.feed(b"\nVerified\n");
        let done = tracker.poll(Duration::from_millis(1100)).unwrap();
        assert!(done.complete);
        assert_eq!(done.progress.percent(), Some(100.0));
        assert_eq!(done.progress.remaining_seconds, Some(0));
        assert!(tracker.poll(Duration::from_secs(2)).is_none());
    }

    #[test]
    fn stalls_unknown_sizes_and_multiple_transfers_do_not_reuse_speed() {
        let mut tracker = WingetProgress::default();
        tracker.feed(b"\r  100 KB\r");
        let unknown = tracker.poll(Duration::ZERO).unwrap();
        assert_eq!(unknown.progress.total_bytes, None);
        tracker.feed(b"\r  200 KB\r");
        assert!(tracker.poll(Duration::from_millis(200)).is_none());
        let moving = tracker.poll(Duration::from_secs(1)).unwrap();
        assert_eq!(moving.progress.bytes_per_second, 102400.0);
        let stalled = tracker.poll(Duration::from_secs(2)).unwrap();
        assert_eq!(stalled.progress.bytes_per_second, 0.0);
        assert_eq!(stalled.progress.remaining_seconds, None);
        tracker.feed(b"\n\r  1,00 MB / 2,00 MB");
        let next = tracker.poll(Duration::from_millis(2100)).unwrap();
        assert_eq!(next.progress.percent(), Some(50.0));
        assert_eq!(next.progress.bytes_per_second, 0.0);
        tracker.feed(b"\r  100 KB / 2.00 MB");
        let retry = tracker.poll(Duration::from_millis(2200)).unwrap();
        assert_eq!(retry.progress.bytes_per_second, 0.0);
    }

    #[test]
    fn rejects_installer_percentages_logs_and_invalid_counters() {
        for text in [
            "Installer: 25%\n",
            "Downloading https://example.com/10 MB\n",
            "  100 KB / 0 B\n",
            "  5 MB / 4 MB\n",
            "  NaN MB / 10 MB\n",
            "  -1 MB / 10 MB\n",
            "  1 MB / 10 M",
            "Found package 10 MB\n",
        ] {
            let mut tracker = WingetProgress::default();
            tracker.feed(text.as_bytes());
            assert!(tracker.poll(Duration::ZERO).is_none(), "{text}");
        }
        let mut tracker = WingetProgress::default();
        tracker.feed("\r  ███▒▒▒  512 KB / 1.00 MB".as_bytes());
        assert_eq!(
            tracker.poll(Duration::ZERO).unwrap().progress.percent(),
            Some(50.0)
        );
    }

    #[test]
    fn interrupted_download_is_never_completed_by_a_newline() {
        let mut tracker = WingetProgress::default();
        tracker.feed(b"\r  1.00 MB / 4.00 MB\r\nNetwork failure\n");
        let partial = tracker.poll(Duration::ZERO).unwrap();
        assert!(!partial.complete);
        assert_eq!(partial.progress.percent(), Some(25.0));
        let mut tracker = WingetProgress::default();
        tracker.feed(b"\r  100 KB\r\n");
        assert_eq!(
            tracker.poll(Duration::ZERO).unwrap().progress.total_bytes,
            None
        );
        tracker.succeed();
        let complete = tracker.poll(Duration::from_millis(100)).unwrap();
        assert!(complete.complete);
        assert_eq!(complete.progress.remaining_bytes, Some(0));
    }

    #[test]
    fn logs_preserve_messages_without_ansi_or_progress_frames() {
        let mut tracker = WingetProgress::default();
        for chunk in "\x1b[32mНайден пакет\x1b[0m\r\n\r  ███▒▒▒  512 KB / 1.00 MB\r\n\r -\r\nПроверка SHA-256\r\n".as_bytes().chunks(3) {
            tracker.feed(chunk);
        }
        assert_eq!(tracker.take_log(), vec!["Найден пакет", "Проверка SHA-256"]);
        assert!(tracker.take_log().is_empty());
    }

    #[test]
    #[ignore = "Downloads SQLite using the real WinGet CLI; no installer is executed"]
    fn live_winget_download_reports_byte_counters() {
        use crate::winget_terminal::{self, Event};
        let folder =
            std::env::temp_dir().join(format!("appdock-progress-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let package =
            std::env::var("APPDOCK_TEST_PACKAGE").unwrap_or_else(|_| "SQLite.SQLite".into());
        let mut command = crate::system::command("winget");
        command
            .args([
                "download",
                "--id",
                &package,
                "--exact",
                "--source",
                "winget",
                "--accept-source-agreements",
                "--accept-package-agreements",
                "--disable-interactivity",
                "--download-directory",
            ])
            .arg(&folder);
        let mut tracker = WingetProgress::default();
        let mut output = Vec::new();
        let mut elapsed = Duration::ZERO;
        let mut samples = vec![];
        let result = winget_terminal::run(&command, |event| {
            match event {
                Event::Output(bytes) => {
                    tracker.feed(&bytes);
                    output.extend_from_slice(&bytes);
                }
                Event::Tick(time) => {
                    elapsed = time;
                    if let Some(sample) = tracker.poll(time) {
                        samples.push(sample);
                    }
                    if time.as_secs() > 90 {
                        return Err("WinGet timed out".into());
                    }
                }
                Event::Paused(_) => {}
            }
            Ok(())
        });
        if result == Ok(0) {
            tracker.succeed();
        }
        if let Ok(path) = std::env::var("APPDOCK_PROGRESS_CAPTURE") {
            std::fs::write(path, &output).unwrap();
        }
        if let Some(sample) = tracker.poll(elapsed) {
            samples.push(sample);
        }
        assert!(folder.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(&folder).unwrap();
        assert!(
            result == Ok(0),
            "WinGet failed ({result:?}): {}",
            String::from_utf8_lossy(&output)
        );
        assert!(
            samples.iter().any(|s| s.progress.downloaded_bytes > 0),
            "No byte counters: {}",
            String::from_utf8_lossy(&output)
        );
        assert!(samples.last().unwrap().complete);
        assert_eq!(samples.last().unwrap().progress.percent(), Some(100.0));
        eprintln!(
            "Real WinGet download: {} samples, {} with measured speed, {} bytes",
            samples.len(),
            samples
                .iter()
                .filter(|s| s.progress.bytes_per_second > 0.0)
                .count(),
            samples.last().unwrap().progress.downloaded_bytes
        );
    }
}
