import { app, BrowserWindow, sharedTexture } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  NativePlayerCommand,
  NativePlayerState,
  NativeQualityValue,
  PlayerBounds,
} from "../shared/player";

interface TextureFrame {
  slot: number;
  handle: bigint;
  width: number;
  height: number;
  sequence: number;
}

interface TextureEvent {
  type:
    | "playing"
    | "stopped"
    | "idle"
    | "error"
    | "renderer"
    | "diagnostic"
    | "pause"
    | "mute"
    | "volume";
  value?: boolean | number;
  message?: string;
}

interface TexturePlayerAddonInstance {
  start(
    url: string,
    width: number,
    height: number,
    preferredVendorId?: number,
    preferredDeviceId?: number,
  ): void;
  resize(width: number, height: number): void;
  command(command: string[]): void;
  recoverGraphics(cycleAdapter: boolean): void;
  releaseFrame(slot: number): void;
  destroy(): void;
}

interface TexturePlayerAddon {
  TexturePlayer: new (
    onFrame: (frame: TextureFrame) => void,
    onEvent: (event: TextureEvent) => void,
    libmpvPath: string,
  ) => TexturePlayerAddonInstance;
}

interface TexturePlayerSession {
  addon: TexturePlayerAddonInstance;
  acceptingFrames: boolean;
  inFlightSlots: Set<number>;
  consecutiveTransferFailures: number;
  firstTransferFailureAt?: number;
  lastDiagnosticAt?: number;
  graphicsRecoveryAttempts: number;
  retireTimer?: NodeJS.Timeout;
}

interface ChromiumGpuDevice {
  active?: boolean;
  vendorId?: number;
  deviceId?: number;
}

type StateListener = (state: NativePlayerState) => void;

function resolveNativePaths(): {
  addonPath: string;
  libmpvPath: string;
} {
  if (app.isPackaged) {
    return {
      addonPath: path.join(
        process.resourcesPath,
        "native",
        "texture-player",
        "violetwire_texture_player.node",
      ),
      libmpvPath: path.join(process.resourcesPath, "native", "mpv-dev", "libmpv-2.dll"),
    };
  }
  const root = app.getAppPath();
  return {
    addonPath: path.join(
      root,
      "native",
      "texture-player",
      "build",
      "Release",
      "violetwire_texture_player.node",
    ),
    libmpvPath: path.join(root, "vendor", "native", "mpv-dev", "libmpv-2.dll"),
  };
}

export class TextureNativePlayer {
  private session: TexturePlayerSession | null = null;
  private resolverProcess: ChildProcess | null = null;
  private lastBounds: PlayerBounds = { x: 0, y: 0, width: 1280, height: 720 };
  private resizeTimer: NodeJS.Timeout | null = null;
  private transferSequence = 0;
  private startGeneration = 0;
  private stopping = false;
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
    private readonly getStreamlinkPath: () => string | undefined,
    private readonly getTwitchPlaybackToken: () => string | null,
  ) {}

  getAvailability(): { available: boolean; reason?: string } {
    const { addonPath, libmpvPath } = resolveNativePaths();
    if (!existsSync(addonPath)) {
      return {
        available: false,
        reason: "The experimental texture-player module has not been built.",
      };
    }
    if (!existsSync(libmpvPath)) {
      return {
        available: false,
        reason: "The bundled libmpv development runtime is missing.",
      };
    }
    if (!this.getStreamlinkPath()) {
      return { available: false, reason: "Streamlink is unavailable." };
    }
    return { available: true };
  }

  getState(): NativePlayerState {
    return { ...this.state };
  }

  async start(
    channel: string,
    quality: NativeQualityValue,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.destroy();
    const generation = this.startGeneration;
    const availability = this.getAvailability();
    if (!availability.available) {
      return { ok: false, reason: availability.reason ?? "Texture playback is unavailable." };
    }

    const window = this.getMainWindow();
    if (!window || window.isDestroyed()) {
      return { ok: false, reason: "The application window is not ready." };
    }

    this.stopping = false;
    this.updateState({
      status: "starting",
      paused: false,
      muted: false,
      volume: 100,
      behindLive: false,
      quality,
      error: undefined,
    });

    try {
      const [streamUrl, gpuDevice] = await Promise.all([
        this.resolveStreamUrl(channel, quality),
        this.getChromiumGpuDevice(),
      ]);
      if (this.stopping || generation !== this.startGeneration) {
        return { ok: false, reason: "Texture playback was cancelled." };
      }
      const nativePaths = resolveNativePaths();
      const require = createRequire(import.meta.url);
      const module = require(nativePaths.addonPath) as TexturePlayerAddon;
      const sessionHolder: { current?: TexturePlayerSession } = {};
      const addon = new module.TexturePlayer(
        (frame) => {
          if (sessionHolder.current) this.sendFrame(sessionHolder.current, frame);
          else addon.releaseFrame(frame.slot);
        },
        (event) => {
          if (sessionHolder.current) this.handleEvent(sessionHolder.current, event);
        },
        nativePaths.libmpvPath,
      );
      const session: TexturePlayerSession = {
        addon,
        acceptingFrames: true,
        inFlightSlots: new Set(),
        consecutiveTransferFailures: 0,
        graphicsRecoveryAttempts: 0,
      };
      sessionHolder.current = session;
      this.session = session;
      addon.start(
        streamUrl,
        this.lastBounds.width,
        this.lastBounds.height,
        gpuDevice?.vendorId,
        gpuDevice?.deviceId,
      );
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A newer start owns the player now. Never let an older resolver's
      // cancellation tear down that newer session.
      if (generation === this.startGeneration) this.destroy();
      return { ok: false, reason };
    }
  }

  setBounds(bounds: PlayerBounds): void {
    this.lastBounds = bounds;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    const session = this.session;
    if (!session) return;
    // During a window drag, CSS can scale the last completed frame smoothly.
    // Reallocating multi-megabyte shared textures for every intermediate
    // ResizeObserver measurement caused blank frames and import failures.
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (this.session === session && session.acceptingFrames) {
        session.addon.resize(this.lastBounds.width, this.lastBounds.height);
      }
    }, 120);
  }

  control(command: NativePlayerCommand): void {
    const addon = this.session?.addon;
    if (!addon) return;
    switch (command.command) {
      case "toggle-pause":
        if (!this.state.paused) this.updateState({ behindLive: true });
        addon.command(["cycle", "pause"]);
        break;
      case "toggle-mute":
        addon.command(["cycle", "mute"]);
        break;
      case "set-volume":
        addon.command(["set", "volume", String(command.value)]);
        break;
      case "set-compressor":
        this.updateState({ compressorEnabled: command.enabled });
        addon.command(["af", "remove", "@glint_compressor"]);
        if (command.enabled) {
          addon.command([
            "af",
            "add",
            "@glint_compressor:lavfi=[acompressor=threshold=0.125:ratio=4:attack=20:release=250:makeup=2:knee=2.828427125:detection=rms:link=average]",
          ]);
        }
        break;
      case "go-live":
        // Streamlink's live input does not consistently expose a seekable
        // percentage range. Discard its delayed cache while playback is still
        // paused, then resume only after mpv has moved back to fresh packets.
        // This keeps the necessary live-edge catch-up from dropping frames
        // that are already being presented.
        addon.command(["drop-buffers"]);
        addon.command(["set", "pause", "no"]);
        this.updateState({ paused: false, behindLive: false });
        break;
    }
  }

  recoverGraphics(cycleAdapter = false): void {
    this.session?.addon.recoverGraphics(cycleAdapter);
  }

  destroy(): void {
    this.startGeneration += 1;
    this.stopping = true;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.resolverProcess?.kill();
    this.resolverProcess = null;
    const session = this.session;
    this.session = null;
    if (session) this.retireSession(session);
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

  private resolveStreamUrl(
    channel: string,
    quality: NativeQualityValue,
  ): Promise<string> {
    const streamlinkPath = this.getStreamlinkPath();
    if (!streamlinkPath) return Promise.reject(new Error("Streamlink is unavailable."));
    const playbackToken = this.getTwitchPlaybackToken();
    return new Promise((resolve, reject) => {
      const child = spawn(
        streamlinkPath,
        [
          "--no-config",
          "--loglevel",
          "none",
          "--stream-url",
          ...(playbackToken
            ? [`--twitch-api-header=Authorization=OAuth ${playbackToken}`]
            : []),
          "--twitch-low-latency",
          "--twitch-supported-codecs",
          "h264,h265,av1",
          `https://www.twitch.tv/${channel}`,
          quality,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      this.resolverProcess = child;
      let output = "";
      let errorOutput = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.resolverProcess === child) this.resolverProcess = null;
        if (error) reject(error);
        else {
          const url = output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => /^https?:\/\//i.test(line));
          if (url) resolve(url);
          else reject(new Error(errorOutput.trim() || "Streamlink did not return a playable URL."));
        }
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error("Streamlink timed out while resolving the stream."));
      }, 20_000);
      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (output.length < 65_536) output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (errorOutput.length < 16_384) errorOutput += chunk.toString();
      });
      child.on("error", (error) => finish(error));
      child.on("exit", (code) => {
        if (code === 0) finish();
        else finish(new Error(errorOutput.trim() || `Streamlink exited with code ${code}.`));
      });
    });
  }

  private async getChromiumGpuDevice(): Promise<ChromiumGpuDevice | undefined> {
    try {
      const info = await app.getGPUInfo("basic");
      if (!info || typeof info !== "object" || !("gpuDevice" in info)) return undefined;
      const devices = (info as { gpuDevice?: unknown }).gpuDevice;
      if (!Array.isArray(devices)) return undefined;
      return devices.find(
        (device): device is ChromiumGpuDevice =>
          Boolean(
            device &&
            typeof device === "object" &&
            (device as ChromiumGpuDevice).active &&
            typeof (device as ChromiumGpuDevice).vendorId === "number" &&
            typeof (device as ChromiumGpuDevice).deviceId === "number",
          ),
      );
    } catch {
      return undefined;
    }
  }

  private sendFrame(session: TexturePlayerSession, frame: TextureFrame): void {
    const window = this.getMainWindow();
    if (
      !session.acceptingFrames ||
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    ) {
      session.addon.releaseFrame(frame.slot);
      return;
    }

    // A minimized window presents nothing: skip the import/IPC round trip
    // per frame. Audio and decoding continue; frames resume on restore.
    if (window.isMinimized()) {
      session.addon.releaseFrame(frame.slot);
      return;
    }

    const handle = Buffer.allocUnsafe(8);
    handle.writeBigUInt64LE(frame.handle);
    let imported: Electron.SharedTextureImported;
    try {
      session.inFlightSlots.add(frame.slot);
      imported = sharedTexture.importSharedTexture({
        textureInfo: {
          handle: { ntHandle: handle },
          codedSize: { width: frame.width, height: frame.height },
          visibleRect: { x: 0, y: 0, width: frame.width, height: frame.height },
          pixelFormat: "bgra",
        },
        allReferencesReleased: () => {
          session.inFlightSlots.delete(frame.slot);
          session.addon.releaseFrame(frame.slot);
          if (!session.acceptingFrames && session.inFlightSlots.size === 0) {
            this.finalizeSession(session);
          }
        },
      });
    } catch (error) {
      session.inFlightSlots.delete(frame.slot);
      session.addon.releaseFrame(frame.slot);
      this.recordTransferFailure(
        session,
        error instanceof Error
          ? `Electron could not import the D3D11 texture from libmpv: ${error.message}`
          : "Electron could not import the D3D11 texture from libmpv.",
      );
      return;
    }

    const transferSequence = ++this.transferSequence;
    void sharedTexture
      .sendSharedTexture(
        {
          frame: window.webContents.mainFrame,
          importedSharedTexture: imported,
        },
        transferSequence,
      )
      .then(() => this.recordTransferSuccess(session))
      .catch((error: unknown) => {
        this.recordTransferFailure(
          session,
          error instanceof Error
            ? `Texture transfer failed: ${error.message}`
            : "Texture transfer failed.",
        );
      })
      .finally(() => imported.release());
  }

  private recordTransferSuccess(session: TexturePlayerSession): void {
    if (this.stopping || this.session !== session) return;
    session.consecutiveTransferFailures = 0;
    session.firstTransferFailureAt = undefined;
    session.graphicsRecoveryAttempts = 0;
    // "Playing" means Chromium has actually accepted a presentable frame,
    // rather than merely that mpv has decoded audio or opened the stream.
    if (this.state.status !== "playing") {
      this.updateState({ status: "playing", error: undefined });
    }
  }

  private recordTransferFailure(session: TexturePlayerSession, message: string): void {
    if (this.stopping || this.session !== session) return;
    const now = Date.now();
    session.consecutiveTransferFailures += 1;
    session.firstTransferFailureAt ??= now;

    // A texture can be rejected transiently while Chromium is replacing a
    // renderer surface (HMR, resize, fullscreen, display changes). Dropping
    // that frame is safe; treating it as a terminal player error hides the
    // canvas even when the following frame transfers successfully.
    if (
      session.consecutiveTransferFailures >= 30 &&
      now - session.firstTransferFailureAt >= 3_000
    ) {
      if (session.graphicsRecoveryAttempts < 2) {
        session.graphicsRecoveryAttempts += 1;
        session.consecutiveTransferFailures = 0;
        session.firstTransferFailureAt = undefined;
        session.addon.recoverGraphics(true);
        console.warn(
          `[texture-player] Recreating the graphics bridge on another adapter after repeated import failures (${session.graphicsRecoveryAttempts}/2).`,
        );
        return;
      }
      this.updateState({ status: "error", error: message });
      return;
    }

    // Keep diagnostics useful without flooding the terminal at video-frame
    // rate. A successful transfer resets the failure streak.
    if (!session.lastDiagnosticAt || now - session.lastDiagnosticAt >= 2_000) {
      session.lastDiagnosticAt = now;
      console.warn(`[texture-player] Dropped frame: ${message}`);
    }
  }

  private retireSession(session: TexturePlayerSession): void {
    if (!session.acceptingFrames) return;
    session.acceptingFrames = false;
    session.addon.command(["quit"]);
    if (session.inFlightSlots.size === 0) {
      this.finalizeSession(session);
      return;
    }
    // sendSharedTexture has its own one-second timeout. This guard prevents a
    // renderer crash from retaining the native session forever.
    session.retireTimer = setTimeout(() => this.finalizeSession(session), 2_000);
  }

  private finalizeSession(session: TexturePlayerSession): void {
    if (session.retireTimer) clearTimeout(session.retireTimer);
    session.retireTimer = undefined;
    session.addon.destroy();
  }

  private handleEvent(session: TexturePlayerSession, event: TextureEvent): void {
    if (this.stopping || this.session !== session) return;
    if (event.type === "playing") {
      // Keep the loading surface visible until the first texture transfer
      // succeeds. mpv can report playback restart before Chromium has a frame.
      if (this.state.status === "stopped") {
        this.updateState({ status: "starting", error: undefined });
      }
    } else if (event.type === "stopped") {
      this.updateState({ status: "stopped" });
    } else if (event.type === "error") {
      this.updateState({ status: "error", error: event.message ?? "Texture playback failed." });
    } else if (event.type === "renderer") {
      console.info(`[texture-player] ${event.message ?? "Selected the texture renderer."}`);
    } else if (event.type === "diagnostic") {
      const now = Date.now();
      if (!session.lastDiagnosticAt || now - session.lastDiagnosticAt >= 2_000) {
        session.lastDiagnosticAt = now;
        console.warn(`[texture-player] ${event.message ?? "Native texture diagnostic"}`);
      }
    } else if (event.type === "pause" && typeof event.value === "boolean") {
      this.updateState({ paused: event.value });
    } else if (event.type === "mute" && typeof event.value === "boolean") {
      this.updateState({ muted: event.value });
    } else if (event.type === "volume" && typeof event.value === "number") {
      this.updateState({ volume: Math.round(event.value) });
    }
  }

  private updateState(update: Partial<NativePlayerState>): void {
    this.state = { ...this.state, ...update };
    this.onState(this.state);
  }
}
