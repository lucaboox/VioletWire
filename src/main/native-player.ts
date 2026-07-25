import { app, BaseWindow, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type {
  NativePlayerAvailability,
  NativePlayerCommand,
  NativePlayerState,
  NativeQuality,
  NativeQualityValue,
  PlayerBounds,
} from "../shared/player";
import { parseStreamlinkQualityOutput, presentNativePlaybackError } from "../shared/player";
import {
  redactSensitivePlaybackText,
  spawnStreamlink,
} from "./streamlink-process";
import {
  channelUrl,
  parseChannelKey,
  streamlinkPlatformArguments,
} from "../shared/platform";

type StateListener = (state: NativePlayerState) => void;
const AUDIO_COMPRESSOR_FILTER =
  "@glint_compressor:lavfi=[acompressor=threshold=0.125:ratio=4:attack=20:release=250:makeup=2:knee=2.828427125:detection=rms:link=average]";
const WINDOW_PLAYER_STATS_PROPERTIES = [
  "file-format",
  "video-codec",
  "video-format",
  "hwdec-current",
  "width",
  "height",
  "dwidth",
  "dheight",
  "estimated-vf-fps",
  "container-fps",
  "display-fps",
  "estimated-display-fps",
  "video-bitrate",
  "audio-codec-name",
  "audio-bitrate",
  "audio-params/channel-count",
  "audio-params/samplerate",
  "current-ao",
  "current-vo",
  "demuxer-cache-duration",
  "demuxer-cache-time",
  "frame-drop-count",
  "decoder-frame-drop-count",
  "mistimed-frame-count",
  "vo-delayed-frame-count",
  "vsync-jitter",
  "avsync",
] as const;

function raiseMpvChildWindow(parentHandle: number): void {
  // Electron creates an "Intermediate D3D Window" child even for BaseWindow.
  // mpv can be inserted underneath it, leaving a gray/black surface while the
  // stream decodes normally. This Windows-only helper raises just mpv's child
  // HWND above its siblings without activating or moving either window.
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class GlintMpvZOrder {
  private delegate bool EnumWindowsProc(IntPtr window, IntPtr state);

  [DllImport("user32.dll")]
  private static extern bool EnumChildWindows(
    IntPtr parent,
    EnumWindowsProc callback,
    IntPtr state
  );

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(
    IntPtr window,
    StringBuilder className,
    int maximumCount
  );

  [DllImport("user32.dll")]
  private static extern bool SetWindowPos(
    IntPtr window,
    IntPtr insertAfter,
    int x,
    int y,
    int width,
    int height,
    uint flags
  );

  public static bool RaiseMpvChild(IntPtr parent) {
    bool found = false;
    EnumChildWindows(parent, (window, state) => {
      var className = new StringBuilder(64);
      GetClassName(window, className, className.Capacity);
      if (!string.Equals(className.ToString(), "mpv", StringComparison.Ordinal)) {
        return true;
      }

      found = SetWindowPos(
        window,
        IntPtr.Zero,
        0,
        0,
        0,
        0,
        0x53
      );
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@

$parentWindow = [IntPtr]::new(${parentHandle})
for ($attempt = 0; $attempt -lt 100; $attempt++) {
  if ([GlintMpvZOrder]::RaiseMpvChild($parentWindow)) {
    exit 0
  }
  Start-Sleep -Milliseconds 50
}
exit 1
`;

  const helper = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    {
      windowsHide: true,
      stdio: "ignore",
    },
  );
  helper.on("error", () => {
    // Playback still runs if the z-order helper is unavailable; the UI's
    // official-player switch remains the fallback.
  });
}

function resolveFromPath(executable: string): string | null {
  const result = spawnSync("where.exe", [executable], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0 && existsSync(candidate)) ?? null;
}

function resolveExecutable(
  environmentVariables: string[],
  executable: string,
  bundledPaths: string[],
  knownPaths: string[],
): string | null {
  for (const environmentVariable of environmentVariables) {
    const override = process.env[environmentVariable]?.trim();
    if (override && existsSync(override)) return override;
  }

  const bundled = bundledPaths.find((candidate) => existsSync(candidate));
  if (bundled) return bundled;

  const fromPath = resolveFromPath(executable);
  if (fromPath) return fromPath;

  return knownPaths.find((candidate) => existsSync(candidate)) ?? null;
}

function getAvailability(): NativePlayerAvailability {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const nativeResources = app.isPackaged
    ? path.join(process.resourcesPath, "native")
    : path.join(app.getAppPath(), "vendor", "native");
  const streamlinkPath = resolveExecutable(
    ["VIOLETWIRE_STREAMLINK_PATH", "GLINT_STREAMLINK_PATH"],
    "streamlink.exe",
    [path.join(nativeResources, "streamlink", "bin", "streamlink.exe")],
    [
    path.join(programFiles, "Streamlink", "bin", "streamlink.exe"),
    path.join(localAppData, "Programs", "Streamlink", "bin", "streamlink.exe"),
    path.join(localAppData, "Microsoft", "WinGet", "Links", "streamlink.exe"),
    ],
  );
  const mpvPath = resolveExecutable(
    ["VIOLETWIRE_MPV_PATH", "GLINT_MPV_PATH"],
    "mpv.exe",
    [path.join(nativeResources, "mpv", "mpv.exe")],
    [
    path.join(localAppData, "Microsoft", "WinGet", "Links", "mpv.exe"),
    path.join(programFiles, "mpv", "mpv.exe"),
    path.join(programFiles, "MPV Player", "mpv.exe"),
    ],
  );

  if (!streamlinkPath || !mpvPath) {
    const missing = [
      !streamlinkPath ? "Streamlink" : null,
      !mpvPath ? "mpv" : null,
    ].filter(Boolean);
    return {
      available: false,
      streamlinkPath: streamlinkPath ?? undefined,
      mpvPath: mpvPath ?? undefined,
      reason: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} unavailable.`,
    };
  }

  return { available: true, streamlinkPath, mpvPath };
}

export class NativePlayer {
  private nativeWindow: BaseWindow | null = null;
  private streamlinkProcess: ChildProcess | null = null;
  private mpvSocket: net.Socket | null = null;
  private nativeHostHandle = 0;
  private connectTimer: NodeJS.Timeout | null = null;
  private lastBounds: PlayerBounds | null = null;
  private stopping = false;
  private surfaceSuspended = false;
  private receiveBuffer = "";
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; timer: NodeJS.Timeout }
  >();
  private readonly frameTimestamps: number[] = [];
  private readonly qualityCache = new Map<
    string,
    { expiresAt: number; result: Promise<NativeQuality[]> }
  >();
  private state: NativePlayerState = {
    status: "idle",
    paused: false,
    muted: false,
    volume: 100,
    compressorEnabled: false,
    behindLive: false,
    quality: "best",
  };

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly onState: StateListener,
    private readonly getTwitchPlaybackToken: () => string | null = () => null,
  ) {}

  getAvailability(): NativePlayerAvailability {
    return getAvailability();
  }

  getState(): NativePlayerState {
    return { ...this.state };
  }

  getQualities(channel: string): Promise<NativeQuality[]> {
    const target = parseChannelKey(channel);
    const playbackToken = this.getTwitchPlaybackToken();
    const cacheKey = `${channel}:${playbackToken ? "authenticated" : "anonymous"}`;
    const cached = this.qualityCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const availability = this.getAvailability();
    if (!availability.available || !availability.streamlinkPath) {
      return Promise.resolve([{ value: "best", label: "Auto" }]);
    }

    const result = new Promise<NativeQuality[]>((resolve) => {
      const process = spawnStreamlink(
        availability.streamlinkPath!,
        [
          "--no-config",
          "--loglevel",
          "none",
          ...streamlinkPlatformArguments(target.platform),
          channelUrl(target.platform, target.login),
        ],
        playbackToken,
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let output = "";
      let settled = false;
      const finish = (qualities: NativeQuality[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(qualities);
      };
      const timeout = setTimeout(() => {
        process.kill();
        finish([{ value: "best", label: "Auto" }]);
      }, 12_000);

      process.stdout?.on("data", (chunk: Buffer | string) => {
        if (output.length < 32_768) output += chunk.toString();
      });
      process.on("error", () => finish([{ value: "best", label: "Auto" }]));
      // "close" waits for stdout to drain; "exit" can fire with the quality
      // list still buffered, truncating the parsed options.
      process.on("close", () => finish(parseStreamlinkQualityOutput(output)));
    });
    this.qualityCache.set(cacheKey, {
      expiresAt: Date.now() + 5 * 60_000,
      result,
    });
    return result;
  }

  start(
    channel: string,
    quality: NativeQualityValue = "best",
  ): { ok: true } | { ok: false; reason: string } {
    this.destroy();
    const availability = this.getAvailability();
    if (!availability.available || !availability.streamlinkPath || !availability.mpvPath) {
      return { ok: false, reason: availability.reason ?? "Native player dependencies are unavailable." };
    }

    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, reason: "The application window is not ready." };
    }

    this.stopping = false;
    // BaseWindow deliberately has no Chromium WebContents. A BrowserWindow
    // adds a Chrome rendering child that can sit above mpv's child HWND and
    // leave the video area gray even while playback and audio are running.
    this.nativeWindow = new BaseWindow({
      parent: mainWindow,
      frame: false,
      show: false,
      focusable: false,
      skipTaskbar: true,
      backgroundColor: "#000000",
      hasShadow: false,
      roundedCorners: false,
      thickFrame: false,
    });
    this.nativeWindow.setIgnoreMouseEvents(true, { forward: true });
    if (this.lastBounds) this.applyBounds();

    // mpv's Windows --wid contract expects the HWND cast to an unsigned
    // 32-bit integer, even on 64-bit Windows.
    const nativeHandle = this.nativeWindow.getNativeWindowHandle().readUInt32LE(0);
    this.nativeHostHandle = nativeHandle;
    const pipeName = `\\\\.\\pipe\\glint-mpv-${process.pid}-${Date.now()}`;
    // Streamlink parses --player-args as a shell-like string, so every Windows
    // path separator must be escaped once more before mpv receives it.
    const escapedPipeName = pipeName.replaceAll("\\", "\\\\");
    const playerArguments = [
      `--wid=${nativeHandle}`,
      `--input-ipc-server=${escapedPipeName}`,
      "--no-config",
      "--terminal=no",
      "--msg-level=all=no",
      "--osc=no",
      "--input-default-bindings=no",
      "--keep-open=no",
      "--vo=gpu-next",
      "--gpu-api=d3d11",
      "--gpu-context=d3d11",
      "--hwdec=auto-safe",
      "--profile=low-latency",
      "{playerinput}",
    ].join(" ");
    const playbackTarget = parseChannelKey(channel);

    this.updateState({
      status: "starting",
      paused: false,
      muted: false,
      volume: 100,
      quality,
      error: undefined,
    });

    const playbackToken = this.getTwitchPlaybackToken();
    const streamlinkProcess = spawnStreamlink(
      availability.streamlinkPath,
      [
        "--no-config",
        "--loglevel",
        "info",
        "--player",
        availability.mpvPath,
        "--player-args",
        playerArguments,
        ...streamlinkPlatformArguments(playbackTarget.platform),
        "--retry-open",
        "3",
        channelUrl(playbackTarget.platform, playbackTarget.login),
        quality,
      ],
      playbackToken,
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.streamlinkProcess = streamlinkProcess;

    let lastFailure = "";
    const rememberFailure = (chunk: Buffer | string) => {
      const text = redactSensitivePlaybackText(chunk.toString());
      const usefulLine = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /error|no playable streams|failed/i.test(line));
      if (usefulLine) lastFailure = usefulLine.slice(0, 240);
    };
    streamlinkProcess.stdout?.on("data", rememberFailure);
    streamlinkProcess.stderr?.on("data", rememberFailure);
    streamlinkProcess.on("error", (error) => {
      if (this.stopping || this.streamlinkProcess !== streamlinkProcess) return;
      this.updateState({ status: "error", error: error.message });
    });
    streamlinkProcess.on("exit", (code) => {
      if (this.stopping || this.streamlinkProcess !== streamlinkProcess) return;
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      this.updateState({
        status: code === 0 ? "stopped" : "error",
        error:
          code === 0
            ? undefined
            : presentNativePlaybackError(
                lastFailure || `Native player exited with code ${code ?? "unknown"}.`,
              ),
      });
    });

    this.connectToMpv(pipeName, 0);
    return { ok: true };
  }

  setBounds(bounds: PlayerBounds): void {
    this.lastBounds = bounds;
    this.applyBounds();
  }

  async getStats(): Promise<Record<string, string> | null> {
    if (!this.mpvSocket?.writable) return null;
    const values = await Promise.all(
      WINDOW_PLAYER_STATS_PROPERTIES.map(async (property) => [
        property,
        await this.getMpvProperty(property),
      ] as const),
    );
    const result: Record<string, string> = {
      "vw-render-path": "Window-hosted D3D11",
      "vw-fps": String(this.measuredFps()),
    };
    for (const [property, value] of values) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        result[property] = String(value);
      }
    }
    return result;
  }

  refreshBounds(): void {
    this.applyBounds();
  }

  suspendSurface(): void {
    this.surfaceSuspended = true;
    if (this.nativeWindow && !this.nativeWindow.isDestroyed()) this.nativeWindow.hide();
  }

  resumeSurface(): void {
    this.surfaceSuspended = false;
    this.applyBounds();
    if (
      this.state.status === "playing" &&
      this.nativeWindow &&
      !this.nativeWindow.isDestroyed()
    ) {
      this.nativeWindow.showInactive();
    }
  }

  control(command: NativePlayerCommand): void {
    switch (command.command) {
      case "toggle-pause":
        if (!this.state.paused) this.updateState({ behindLive: true });
        this.sendMpvCommand(["cycle", "pause"]);
        break;
      case "toggle-mute":
        this.sendMpvCommand(["cycle", "mute"]);
        break;
      case "set-volume":
        this.sendMpvCommand(["set_property", "volume", command.value]);
        break;
      case "set-compressor":
        this.updateState({ compressorEnabled: command.enabled });
        this.applyCompressor(command.enabled);
        break;
      case "go-live":
        // Streamlink's rolling live input has no consistently seekable end.
        // Flush delayed packets while paused, then resume after the cache has
        // been discarded so the disruption is not visible as frame skipping.
        this.sendMpvCommand(["drop-buffers"]);
        this.sendMpvCommand(["set_property", "pause", false]);
        this.updateState({ paused: false, behindLive: false });
        break;
    }
  }

  destroy(): void {
    this.stopping = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.sendMpvCommand(["quit"]);
    this.mpvSocket?.destroy();
    this.mpvSocket = null;
    this.resolvePendingRequests();
    this.receiveBuffer = "";
    this.frameTimestamps.length = 0;
    this.streamlinkProcess?.kill();
    this.streamlinkProcess = null;
    if (this.nativeWindow && !this.nativeWindow.isDestroyed()) this.nativeWindow.destroy();
    this.nativeWindow = null;
    this.nativeHostHandle = 0;
    this.surfaceSuspended = false;
    this.updateState({
      status: "idle",
      paused: false,
      muted: false,
      volume: 100,
      behindLive: false,
      quality: "best",
      error: undefined,
    });
  }

  private applyBounds(): void {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || !this.nativeWindow || !this.lastBounds) return;
    const contentBounds = mainWindow.getContentBounds();
    this.nativeWindow.setBounds({
      x: contentBounds.x + this.lastBounds.x,
      y: contentBounds.y + this.lastBounds.y,
      width: this.lastBounds.width,
      height: this.lastBounds.height,
    });
  }

  private connectToMpv(pipeName: string, attempt: number): void {
    if (this.state.status === "error" || this.state.status === "stopped") return;
    if (this.stopping || attempt >= 40) {
      if (!this.stopping) {
        this.updateState({ status: "error", error: "Timed out while connecting to the native player." });
      }
      return;
    }

    const socket = net.createConnection(pipeName);
    socket.once("connect", () => {
      if (this.stopping) {
        socket.destroy();
        return;
      }
      this.mpvSocket = socket;
      if (this.nativeHostHandle) raiseMpvChildWindow(this.nativeHostHandle);
      socket.on("data", (data) => this.handleMpvData(data.toString("utf8")));
      socket.on("close", () => {
        if (!this.stopping) this.mpvSocket = null;
        this.resolvePendingRequests();
      });
      this.sendMpvCommand(["observe_property", 1, "pause"]);
      this.sendMpvCommand(["observe_property", 2, "mute"]);
      this.sendMpvCommand(["observe_property", 3, "volume"]);
      // time-pos advances with mpv's scheduled video frames and gives the
      // compatibility backend a useful live FPS signal without touching the
      // native swapchain.
      this.sendMpvCommand(["observe_property", 4, "time-pos"]);
      this.applyCompressor(this.state.compressorEnabled);
    });
    socket.once("error", () => {
      socket.destroy();
      this.connectTimer = setTimeout(() => this.connectToMpv(pipeName, attempt + 1), 250);
    });
  }

  private handleMpvData(chunk: string): void {
    this.receiveBuffer += chunk;
    const messages = this.receiveBuffer.split("\n");
    this.receiveBuffer = messages.pop() ?? "";

    for (const message of messages) {
      if (!message.trim()) continue;
      try {
        const event = JSON.parse(message) as {
          event?: string;
          name?: string;
          data?: unknown;
          request_id?: number;
          error?: string;
        };
        if (typeof event.request_id === "number") {
          const pending = this.pendingRequests.get(event.request_id);
          if (pending) {
            this.pendingRequests.delete(event.request_id);
            clearTimeout(pending.timer);
            pending.resolve(event.error === "success" ? event.data : null);
          }
        }
        if (event.event === "playback-restart" || event.event === "file-loaded") {
          this.updateState({ status: "playing", error: undefined });
        } else if (event.event === "end-file" && !this.stopping) {
          this.updateState({ status: "stopped" });
        } else if (event.event === "property-change") {
          if (event.name === "pause" && typeof event.data === "boolean") {
            this.updateState({ paused: event.data });
          } else if (event.name === "mute" && typeof event.data === "boolean") {
            this.updateState({ muted: event.data });
          } else if (event.name === "volume" && typeof event.data === "number") {
            this.updateState({ volume: Math.round(event.data) });
          } else if (event.name === "time-pos" && typeof event.data === "number") {
            this.frameTimestamps.push(Date.now());
            if (this.frameTimestamps.length > 200) this.frameTimestamps.shift();
          }
        }
      } catch {
        // Ignore malformed third-party IPC output.
      }
    }
  }

  private sendMpvCommand(command: unknown[]): void {
    if (!this.mpvSocket?.writable) return;
    this.mpvSocket.write(`${JSON.stringify({ command })}\n`);
  }

  private getMpvProperty(property: string): Promise<unknown> {
    const socket = this.mpvSocket;
    if (!socket?.writable) return Promise.resolve(null);
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve(null);
      }, 750);
      this.pendingRequests.set(requestId, { resolve, timer });
      try {
        socket.write(
          `${JSON.stringify({
            command: ["get_property", property],
            request_id: requestId,
          })}\n`,
        );
      } catch {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        resolve(null);
      }
    });
  }

  private resolvePendingRequests(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingRequests.clear();
  }

  private measuredFps(): number {
    const cutoff = Date.now() - 1_000;
    let count = 0;
    for (let index = this.frameTimestamps.length - 1; index >= 0; index -= 1) {
      if (this.frameTimestamps[index] >= cutoff) count += 1;
      else break;
    }
    return count;
  }

  private applyCompressor(enabled: boolean): void {
    this.sendMpvCommand(["af", "remove", "@glint_compressor"]);
    if (enabled) this.sendMpvCommand(["af", "add", AUDIO_COMPRESSOR_FILTER]);
  }

  private updateState(update: Partial<NativePlayerState>): void {
    this.state = { ...this.state, ...update };
    if (
      update.status === "playing" &&
      !this.surfaceSuspended &&
      this.nativeWindow &&
      !this.nativeWindow.isDestroyed()
    ) {
      this.nativeWindow.showInactive();
      if (this.nativeHostHandle) raiseMpvChildWindow(this.nativeHostHandle);
    } else if (
      (update.status === "error" || update.status === "stopped") &&
      this.nativeWindow &&
      !this.nativeWindow.isDestroyed()
    ) {
      this.nativeWindow.hide();
    }
    this.onState(this.state);
  }
}
