export type ProductType =
  | "desktop"
  | "web"
  | "cloud"
  | "developer-tool"
  | "database-server"
  | "container"
  | "emulator";
export interface AppOption {
  id: string;
  label: string;
  type: "boolean" | "number" | "select" | "text";
  default: string | number | boolean;
  values?: string[];
  help?: string;
}
export interface Product {
  id: string;
  name: string;
  publisher: string;
  category: string;
  description: string;
  website: string;
  aliases: string[];
  icon: string;
  color: string;
  type: ProductType;
  platforms: string[];
  architectures: string[];
  license: string;
  licenseNote: string;
  version: string;
  editions: {
    id: string;
    name: string;
    description: string;
    packageId?: string;
    verified?: boolean;
  }[];
  install: {
    method: "winget" | "manual" | "web";
    packageId: string | null;
    source: string | null;
    verifiedAt: string | null;
    verification: "verified" | "unverified";
    download: boolean;
    downloadUrl?: string;
    scope: string;
  };
  detection: { method: string; packageId: string | null };
  options: AppOption[];
  dependencies: string[];
  notes: string;
  sources: string[];
  checkedAt: string;
  downloadMb: number | null;
  diskMb: number | null;
}
export interface Selection {
  appId: string;
  action: "install" | "download" | "open" | "shortcut" | "guide";
  options: Record<string, string | number | boolean>;
  extensions: string[];
  version?: string;
}
export interface Preset {
  customPrograms?: CustomReference[];
  issues?: string[];
  id: string;
  name: string;
  description: string;
  icon: string;
  items: Selection[];
  builtin: boolean;
}
export type TaskStatus =
  | "removed"
  | "repaired"
  | "checked"
  | "blocked"
  | "attention"
  | "user-completed"
  | "queued"
  | "checking"
  | "downloading"
  | "verifying"
  | "installing"
  | "configuring"
  | "installed"
  | "current"
  | "action-required"
  | "reboot-required"
  | "error"
  | "cancelled"
  | "downloaded"
  | "opened"
  | "shortcut-created";
export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  remainingBytes: number | null;
  bytesPerSecond: number;
  remainingSeconds: number | null;
}
export interface QueueTask {
  operation?: {
    kind: string;
    instance?: InstalledInstance;
    id?: string;
    sha256?: string;
    directory?: string;
  } | null;
  readiness?: ReadinessResult | null;
  installationOutcome?: string | null;
  failureStage?: string | null;
  offlineRoot?: string | null;
  resumeFrom?: string | null;
  runId?: string;
  dependencies?: string[];
  lastActivityAt?: number;
  actualVersion?: string | null;
  evidence?: "detected" | "user" | "absent" | null;
  id: string;
  appId: string;
  name: string;
  action:
    | Selection["action"]
    | "extension"
    | "uninstall"
    | "repair"
    | "fix"
    | "custom-install";
  status: TaskStatus;
  message: string;
  log: string[];
  percent: number | null;
  downloadProgress?: DownloadProgress | null;
  downloadPaused?: boolean;
  cancelRequested?: boolean;
  parentId?: string | null;
  selection: Selection;
  startedAt?: number | null;
  finishedAt?: number | null;
}
export interface InstalledInstance {
  key: string;
  productCode: string;
  scope: string;
  name: string;
  version: string;
  publisher: string;
  msi: boolean;
  appId: string | null;
}
export interface CustomReference {
  name: string;
  sha256: string;
}
export interface CustomApp extends CustomReference {
  id: string;
  description: string;
  icon: string;
  fileName: string;
  source: string;
  size: number;
  kind: "exe" | "msi";
  version: string | null;
  publisher: string | null;
  signature: "valid" | "unsigned" | "invalid" | "unknown";
  signatureDetail: string;
}
export interface TroubleshootingReport {
  readiness: ReadinessResult;
  checked: string[];
  problems: string[];
  unknown: string[];
  manual: string[];
  pathAvailable: boolean;
  path?: string;
  repairAvailable: boolean;
  missingExtensions: string[];
}
export interface ReadinessResult {
  state: "ready" | "action" | "unknown";
  reason: string;
  nextStep: string;
  version: string | null;
  checkedAt: number;
  canLaunch: boolean;
}
export interface QueueState {
  schemaVersion?: number;
  currentRunId?: string | null;
  runs?: Run[];
  storageError?: string | null;
  tasks: QueueTask[];
  running: boolean;
  paused: boolean;
  mode: "demo" | "live";
  updatedAt: number;
}
export interface InstalledApp {
  instanceId?: string | null;
  edition?: string | null;
  packageId: string;
  version: string;
  availableVersion?: string;
}
export interface ScanResult {
  installed: InstalledApp[];
  warnings: string[];
  updatesChecked: boolean;
}
export interface SystemInfo {
  windows: boolean;
  arch: string;
  winget: string | null;
  freeDiskMb: number | null;
  virtualization: boolean | null;
  wsl: string;
  hyperV: string;
  admin: boolean;
  os: string;
  error?: string;
}
export interface Plan {
  token: string;
  items: {
    appId: string;
    name: string;
    action: string;
    warnings: string[];
    blocked: boolean;
    installedVersion?: string | null;
    selection: Selection;
    tasks: QueueTask[];
    excluded: boolean;
    expected: string;
  }[];
  warnings: string[];
  system: SystemInfo;
  mode: "demo" | "live";
}
export interface Run {
  id: string;
  createdAt: number;
  finishedAt?: number | null;
  mode: "demo" | "live";
  skipCurrent: boolean;
  parallelDownloads: number;
  selections: Selection[];
  outcome: string;
}
export interface DownloadInventory {
  folder: string;
  limitations: string;
  files: {
    id: string;
    appId: string;
    name: string;
    size: number;
    version: string | null;
    source: string | null;
    verification: string;
    checkedAt: number | null;
  }[];
}
export interface Settings {
  theme: "dark" | "light" | "system";
  mode: "demo" | "live";
  view: "grid" | "list";
  skipCurrent: boolean;
  parallelDownloads: number;
}
