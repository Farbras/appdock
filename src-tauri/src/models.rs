use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TaskStatus {
    Queued,
    Checking,
    Downloading,
    Verifying,
    Installing,
    Configuring,
    Installed,
    Current,
    ActionRequired,
    RebootRequired,
    Error,
    Cancelled,
    Downloaded,
    Opened,
    ShortcutCreated,
    Blocked,
    Attention,
    UserCompleted,
}
impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Checking => "checking",
            Self::Downloading => "downloading",
            Self::Verifying => "verifying",
            Self::Installing => "installing",
            Self::Configuring => "configuring",
            Self::Installed => "installed",
            Self::Current => "current",
            Self::ActionRequired => "action-required",
            Self::RebootRequired => "reboot-required",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
            Self::Downloaded => "downloaded",
            Self::Opened => "opened",
            Self::ShortcutCreated => "shortcut-created",
            Self::Blocked => "blocked",
            Self::Attention => "attention",
            Self::UserCompleted => "user-completed",
        }
    }
}
impl From<&str> for TaskStatus {
    fn from(s: &str) -> Self {
        serde_json::from_value(Value::String(s.into()))
            .expect("Internal status must belong to TaskStatus")
    }
}
impl PartialEq<&str> for TaskStatus {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}
impl std::ops::Deref for TaskStatus {
    type Target = str;
    fn deref(&self) -> &str {
        self.as_str()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub app_id: String,
    pub action: String,
    pub options: HashMap<String, Value>,
    pub extensions: Vec<String>,
    #[serde(default)]
    pub version: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub last_activity_at: u64,
    #[serde(default)]
    pub actual_version: Option<String>,
    #[serde(default)]
    pub evidence: Option<String>,
    pub id: String,
    pub app_id: String,
    pub name: String,
    pub action: String,
    pub status: TaskStatus,
    pub message: String,
    pub log: Vec<String>,
    pub percent: Option<f64>,
    pub parent_id: Option<String>,
    pub selection: Selection,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub current_run_id: Option<String>,
    #[serde(default)]
    pub runs: Vec<Run>,
    #[serde(default)]
    pub storage_error: Option<String>,
    pub tasks: Vec<Task>,
    pub running: bool,
    pub paused: bool,
    pub mode: String,
    pub updated_at: u64,
}
impl Default for Queue {
    fn default() -> Self {
        Self {
            schema_version: schema_version(),
            current_run_id: None,
            runs: vec![],
            storage_error: None,
            tasks: vec![],
            running: false,
            paused: false,
            mode: "live".into(),
            updated_at: 0,
        }
    }
}
pub fn schema_version() -> u32 {
    2
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub mode: String,
    pub skip_current: bool,
    pub parallel_downloads: usize,
    pub selections: Vec<Selection>,
    pub outcome: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub edition: Option<String>,
    pub package_id: String,
    pub version: String,
    pub available_version: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub windows: bool,
    pub arch: String,
    pub winget: Option<String>,
    pub free_disk_mb: Option<u64>,
    pub virtualization: Option<bool>,
    pub wsl: String,
    pub hyper_v: String,
    pub admin: bool,
    pub os: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub selection: Selection,
    pub tasks: Vec<Task>,
    pub excluded: bool,
    pub expected: String,
    pub app_id: String,
    pub name: String,
    pub action: String,
    pub warnings: Vec<String>,
    pub blocked: bool,
    pub installed_version: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub token: String,
    pub items: Vec<PlanItem>,
    pub warnings: Vec<String>,
    pub system: SystemInfo,
    pub mode: String,
}
#[derive(Clone)]
pub struct PendingPlan {
    pub token: String,
    pub items: Vec<Selection>,
    pub created_at: u64,
    pub skip_current: bool,
    pub parallel_downloads: usize,
    pub tasks: Vec<Task>,
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn terminal(status: &str) -> bool {
    matches!(
        status,
        "installed"
            | "blocked"
            | "user-completed"
            | "current"
            | "action-required"
            | "reboot-required"
            | "error"
            | "cancelled"
            | "downloaded"
            | "opened"
            | "shortcut-created"
    )
}
