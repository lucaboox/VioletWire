import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...arguments_: unknown[]) => void>();
  return {
    listeners,
    showMessageBox: vi.fn(),
    updater: {
      allowPrerelease: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdates: vi.fn(),
      on: vi.fn((event: string, listener: (...arguments_: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      quitAndInstall: vi.fn(),
    },
  };
});

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.3.2-alpha.1",
    isPackaged: true,
  },
  dialog: {
    showMessageBox: mocks.showMessageBox,
  },
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: mocks.updater,
  },
}));

vi.mock("node:fs", () => ({
  existsSync: () => true,
}));

Object.defineProperty(process, "resourcesPath", {
  configurable: true,
  value: "C:\\VioletWire\\resources",
});

import { UpdateService } from "./update-service";

function createService(): UpdateService {
  return new UpdateService(
    () => null,
    () => undefined,
  );
}

describe("UpdateService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
  });

  it("offers to restart only once when update-downloaded is emitted repeatedly", async () => {
    const service = createService();
    service.initialize();
    const downloaded = mocks.listeners.get("update-downloaded");
    expect(downloaded).toBeDefined();

    downloaded?.({ version: "0.3.2-alpha.1" });
    downloaded?.({ version: "0.3.2-alpha.1" });
    await Promise.resolve();

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("does not start another update check after an installer is ready", async () => {
    const service = createService();
    service.initialize();
    mocks.listeners.get("update-downloaded")?.({
      version: "0.3.2-alpha.1",
    });
    await service.check();

    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
  });
});
