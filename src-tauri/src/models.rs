use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

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
    pub id: String,
    pub app_id: String,
    pub name: String,
    pub action: String,
    pub status: String,
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
    pub tasks: Vec<Task>,
    pub running: bool,
    pub paused: bool,
    pub mode: String,
    pub updated_at: u64,
}
impl Default for Queue {
    fn default() -> Self {
        Self {
            tasks: vec![],
            running: false,
            paused: false,
            mode: "live".into(),
            updated_at: 0,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
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
