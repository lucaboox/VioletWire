import { app, dialog, type BrowserWindow, type MessageBoxOptions } from "electron";
import electronUpdater, {
  type AppUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from "electron-updater";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AppUpdateStatus } from "../shared/updates";

const AUTOMATIC_CHECK_DELAY = 15_000;
const AUTOMATIC_CHECK_INTERVAL = 6 * 60 * 60 * 1_000;

/**
 * GitHub can expose a newly-created release tag a moment before the publish
 * job has attached electron-updater's `latest.yml` asset. It is a temporary
 * publishing state, not a failed update check.
 */
function isReleaseStillPublishing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /latest\.yml/i.test(message) && /\b404\b|cannot find/i.test(message);
}

function getAutoUpdater(): AppUpdater {
  // electron-updater is CommonJS internally; default import + destructuring is
  // its documented TypeScript/ESM compatibility path.
  const { autoUpdater } = electronUpdater;
  return autoUpdater;
}

export class UpdateService {
  private readonly updater = getAutoUpdater();
  private status: AppUpdateStatus;
  private initialized = false;
  private downloaded = false;
  private readonly configured =
    app.isPackaged && existsSync(path.join(process.resourcesPath, "app-update.yml"));

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly publishStatus: (status: AppUpdateStatus) => void,
  ) {
    this.status = this.configured
      ? { state: "idle", currentVersion: app.getVersion() }
      : {
          state: "disabled",
          currentVersion: app.getVersion(),
          message: app.isPackaged
            ? "This build is not connected to a GitHub release feed."
            : "Update checks are available in installed builds.",
        };
  }

  initialize(): void {
    if (this.initialized || !this.configured) return;
    this.initialized = true;
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;
    this.updater.allowPrerelease = app.getVersion().includes("-");

    this.updater.on("checking-for-update", () => {
      this.setStatus({ state: "checking" });
    });
    this.updater.on("update-available", (info: UpdateInfo) => {
      this.setStatus({
        state: "available",
        availableVersion: info.version,
        message: `VioletWire ${info.version} is available.`,
      });
    });
    this.updater.on("download-progress", (progress: ProgressInfo) => {
      this.setStatus({
        state: "downloading",
        progress: Math.max(0, Math.min(100, progress.percent)),
        message: `Downloading ${progress.percent.toFixed(0)}%`,
      });
    });
    this.updater.on("update-not-available", () => {
      this.setStatus({
        state: "not-available",
        message: "VioletWire is up to date.",
      });
    });
    this.updater.on("update-downloaded", (info: UpdateInfo) => {
      const shouldOfferRestart = !this.downloaded;
      this.downloaded = true;
      this.setStatus({
        state: "downloaded",
        availableVersion: info.version,
        progress: 100,
        message: "Update ready. Restart to install it; VioletWire reopens on its own.",
      });
      if (shouldOfferRestart) void this.offerRestart(info.version);
    });
    this.updater.on("error", (error: Error) => {
      if (isReleaseStillPublishing(error)) {
        this.setStatus({
          state: "not-available",
          message: "A new release is still being published. Check again shortly.",
        });
        return;
      }
      this.setStatus({
        state: "error",
        message: error.message || "The update check failed.",
      });
    });

    const firstCheck = setTimeout(() => void this.check(), AUTOMATIC_CHECK_DELAY);
    firstCheck.unref();
    const recurringCheck = setInterval(() => void this.check(), AUTOMATIC_CHECK_INTERVAL);
    recurringCheck.unref();
  }

  getStatus(): AppUpdateStatus {
    return { ...this.status };
  }

  async check(): Promise<AppUpdateStatus> {
    if (
      !this.configured ||
      this.downloaded ||
      this.status.state === "checking" ||
      this.status.state === "downloading"
    ) {
      return this.getStatus();
    }
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      if (isReleaseStillPublishing(error)) {
        this.setStatus({
          state: "not-available",
          message: "A new release is still being published. Check again shortly.",
        });
        return this.getStatus();
      }
      this.setStatus({
        state: "error",
        message: error instanceof Error ? error.message : "The update check failed.",
      });
    }
    return this.getStatus();
  }

  install(): void {
    // The first argument is `isSilent`, which is what makes electron-updater
    // pass NSIS `/S`. Without it the full installer wizard opens and the user
    // has to click through it again. The second relaunches VioletWire once the
    // install finishes. Installing on quit is already silent.
    if (this.downloaded) this.updater.quitAndInstall(true, true);
  }

  private setStatus(update: Omit<AppUpdateStatus, "currentVersion">): void {
    this.status = {
      ...update,
      currentVersion: app.getVersion(),
    };
    this.publishStatus(this.getStatus());
  }

  private async offerRestart(version: string): Promise<void> {
    const options: MessageBoxOptions = {
      type: "info",
      title: "VioletWire update ready",
      message: `VioletWire ${version} has been downloaded.`,
      detail:
        "Restarting installs it in a few seconds and reopens VioletWire. Choose Later to install it the next time you close VioletWire.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const window = this.getWindow();
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) this.install();
  }
}
