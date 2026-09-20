/** Absolute paths resolved by the shared engine, independent of caller cwd. */
export interface ServiceContext {
  dataDir: string;
  configPath: string;
  storePath: string;
  repoRoot: string;
  nodePath: string;
  logDir: string;
  serviceName: string;
}

export type ServiceManager = "windows-service" | "scheduled-task" | "launchd" | "systemd" | "none";

export interface ServiceSnapshot {
  state: "running" | "stopped" | "failed" | "unknown";
  manager: ServiceManager;
  since: string | null;
  pid: number | null;
  lastExitCode: number | null;
  /** Observed open database, not a guess from configuration or process arguments. */
  observedStorePath: string | null;
  /** Restarts in the stated interval. Null if the platform cannot measure it. */
  restartCount: number | null;
  restartWindowMs: number | null;
  detail?: string;
}

export interface ClientDetection {
  id: "claude-code" | "claude-desktop" | "codex-cli" | "codex-desktop";
  installed: boolean;
  configPath: string | null;
  format: "json" | "toml";
  detail?: string;
}

export interface PlatformAdapter {
  manager: ServiceManager;
  status(context: ServiceContext): Promise<ServiceSnapshot>;
  install(context: ServiceContext): Promise<void>;
  start(context: ServiceContext): Promise<void>;
  stop(context: ServiceContext): Promise<void>;
  uninstall?(context: ServiceContext): Promise<void>;
  detectClients(context: ServiceContext): Promise<ClientDetection[]>;
}
