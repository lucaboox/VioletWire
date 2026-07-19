export type AppUpdateState =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export interface AppUpdateStatus {
  state: AppUpdateState;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  message?: string;
}

export interface UpdateApi {
  getStatus(): Promise<AppUpdateStatus>;
  getReleaseNotes(forceRefresh?: boolean): Promise<string | null>;
  check(): Promise<AppUpdateStatus>;
  install(): void;
  onStatus(listener: (status: AppUpdateStatus) => void): () => void;
}
