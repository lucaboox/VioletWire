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
    | "diagnostic"
    | "pause"
    | "mute"
    | "volume";
  value?: boolean | number;
  message?: string;
}

interface TexturePlayerAddonInstance {
  start(url: string, width: number, height: number): void;
  resize(width: number, height: number): void;
  command(command: string[]): void;
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
  retireTimer?: NodeJS.Timeout;
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
      const streamUrl = await this.resolveStreamUrl(channel, quality);
      if (this.stopping) return { ok: false, reason: "Texture playback was cancelled." };
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
      };
      sessionHolder.current = session;
      this.session = session;
      addon.start(streamUrl, this.lastBounds.width, this.lastBounds.height);
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.destroy();
      return { ok: false, reason };
    }
  }

  setBounds(bounds: PlayerBounds): void {
    this.lastBounds = bounds;
    this.session?.addon.resize(bounds.width, bounds.height);
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
        addon.command(["set", "pause", "no"]);
        addon.command(["seek", "100", "absolute-percent", "exact"]);
        addon.command(["drop-buffers"]);
        this.updateState({ paused: false, behindLive: false });
        break;
    }
  }

  destroy(): void {
    this.stopping = true;
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

    void sharedTexture
      .sendSharedTexture(
        {
          frame: window.webContents.mainFrame,
          importedSharedTexture: imported,
        },
        frame.sequence,
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
    if (this.state.status === "error") {
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
      this.updateState({ status: "playing", error: undefined });
    } else if (event.type === "stopped") {
      this.updateState({ status: "stopped" });
    } else if (event.type === "error") {
      this.updateState({ status: "error", error: event.message ?? "Texture playback failed." });
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
