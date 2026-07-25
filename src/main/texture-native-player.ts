import { app, BrowserWindow, sharedTexture } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import type {
  NativePlayerCommand,
  NativePlayerState,
  NativePlayerTransition,
  NativeQualityValue,
  PlayerBounds,
} from "../shared/player";
import {
  channelUrl,
  parseChannelKey,
  streamlinkPlatformArguments,
} from "../shared/platform";
import {
  redactSensitivePlaybackText,
  spawnStreamlink,
} from "./streamlink-process";

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
  // Raw mpv property names mapped to their string values. Null once the player
  // has been torn down.
  stats(): Record<string, string> | null;
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

// Usher playlist URLs stay valid well past this window; keep it short so a
// cache hit never hands mpv an expired token.
const RESOLVE_CACHE_LIFETIME = 60_000;
const MAX_CONCURRENT_PRERESOLVES = 2;

// Frame transfer sequence, shared across every player instance. The preload
// drops frames whose sequence is not newer than the last one it painted for a
// given render target. A per-instance counter would restart at 0 whenever a new
// instance takes over a target (each multistream tile is a fresh instance),
// making all its frames look stale until the app restarts — hence a single
// process-wide monotonic counter that never regresses.
let globalTransferSequence = 0;

export class TextureNativePlayer {
  private session: TexturePlayerSession | null = null;
  private resolverProcess: ChildProcess | null = null;
  private lastBounds: PlayerBounds = { x: 0, y: 0, width: 1280, height: 720 };
  private resizeTimer: NodeJS.Timeout | null = null;
  private startGeneration = 0;
  private stopping = false;
  // True between a live-session "loadfile replace" and the incoming stream's
  // first "playing" event; the old stream's end-of-file must not surface as a
  // "stopped" player state mid-switch.
  private switchPending = false;
  // The channel the live session is currently tuned to; go-live catch-up
  // reloads it through the in-place switch path.
  private currentChannel: string | null = null;
  // Timestamps of recently delivered frames, used to measure the real presented
  // frame rate. mpv's own estimated-vf-fps stays at 0 with the render API since
  // the addon, not mpv, drives presentation.
  private readonly frameTimestamps: number[] = [];
  private readonly resolveCache = new Map<
    string,
    { expiresAt: number; url: Promise<string> }
  >();
  private readonly preresolveProcesses = new Set<ChildProcess>();
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
    // Identifies which renderer canvas this player's frames paint. The single
    // full-window player uses "main"; multistream tiles use their tile id so
    // the preload can route each stream to its own <canvas>.
    private readonly renderTarget: string = "main",
    // The volume (0–100) a fresh session starts at, so it restores the user's
    // last setting instead of jumping from 100% down to their level.
    private readonly getStoredVolume: () => number = () => 100,
    // Supplies Kick's anonymous session cookie for Streamlink. Returns null on
    // Twitch, offline, or when Kick's handshake changes.
    private readonly getKickCookie: () => Promise<string | null> = async () => null,
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
    transition?: NativePlayerTransition,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // A healthy live session switches streams in place: mpv, the D3D/GL
    // bridge, and the shared-texture slots all survive, so a channel or
    // quality change only pays for URL resolution.
    const liveSession = this.session;
    if (
      liveSession &&
      liveSession.acceptingFrames &&
      !this.stopping &&
      this.state.status !== "error"
    ) {
      return this.switchStream(liveSession, channel, quality, transition);
    }

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
    const startVolume = Math.min(100, Math.max(0, Math.round(this.getStoredVolume())));
    this.updateState({
      status: "starting",
      paused: false,
      muted: false,
      volume: startVolume,
      behindLive: false,
      quality,
      error: undefined,
      transition,
    });

    try {
      // Kick off URL resolution first, then build the mpv/graphics pipeline
      // while Streamlink works — the two dominate startup and fully overlap.
      const streamUrlPromise = this.resolveStreamUrlCached(channel, quality);
      streamUrlPromise.catch(() => undefined);
      const gpuDevice = await this.getChromiumGpuDevice();
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
      const startScale = this.lastBounds.scale ?? 1;
      addon.start(
        "",
        Math.round(this.lastBounds.width * startScale),
        Math.round(this.lastBounds.height * startScale),
        gpuDevice?.vendorId,
        gpuDevice?.deviceId,
      );
      // Silence libav/demuxer chatter (every HLS segment open, "duplicated MOOV
      // Atom", etc.) that mpv otherwise routes to stderr. Diagnostics we care
      // about come through the addon's own event channel, not mpv messages.
      addon.command(["set", "msg-level", "all=no"]);
      // Start mpv at the restored volume so the very first audio matches, and
      // the level never audibly jumps from 100% down to the saved value.
      addon.command(["set", "volume", String(startVolume)]);
      const streamUrl = await streamUrlPromise;
      if (this.stopping || generation !== this.startGeneration || this.session !== session) {
        return { ok: false, reason: "Texture playback was cancelled." };
      }
      session.addon.command(["loadfile", streamUrl, "replace"]);
      this.currentChannel = channel;
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A newer start owns the player now. Never let an older resolver's
      // cancellation tear down that newer session.
      if (generation === this.startGeneration) this.destroy();
      return { ok: false, reason };
    }
  }

  private async switchStream(
    session: TexturePlayerSession,
    channel: string,
    quality: NativeQualityValue,
    transition?: NativePlayerTransition,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const generation = this.startGeneration;
    this.updateState({
      status: "starting",
      paused: false,
      behindLive: false,
      quality,
      error: undefined,
      transition,
    });
    this.switchPending = true;
    // Silence the outgoing stream the instant the user picks a new one:
    // otherwise its video and audio keep running through the whole URL
    // resolution, which reads as the app lagging behind the click.
    session.addon.command(["stop"]);
    try {
      const streamUrl = await this.resolveStreamUrlCached(channel, quality);
      if (this.stopping || generation !== this.startGeneration || this.session !== session) {
        return { ok: false, reason: "Texture playback was cancelled." };
      }
      session.addon.command(["loadfile", streamUrl, "replace"]);
      session.addon.command(["set", "pause", "no"]);
      this.currentChannel = channel;
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (generation === this.startGeneration && this.session === session) {
        this.switchPending = false;
        this.updateState({ status: "error", error: reason, transition: undefined });
      }
      return { ok: false, reason };
    }
  }

  preresolve(channel: string): void {
    if (!this.getAvailability().available) return;
    const key = `${channel.toLowerCase()}:best`;
    const cached = this.resolveCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return;
    if (this.preresolveProcesses.size >= MAX_CONCURRENT_PRERESOLVES) return;
    const url = this.resolveStreamUrl(channel, "best", false);
    this.storeResolvedUrl(key, url);
    url.catch(() => undefined);
  }

  private resolveStreamUrlCached(
    channel: string,
    quality: NativeQualityValue,
  ): Promise<string> {
    const key = `${channel.toLowerCase()}:${quality}`;
    const cached = this.resolveCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    const url = this.resolveStreamUrl(channel, quality, true);
    this.storeResolvedUrl(key, url);
    return url;
  }

  private storeResolvedUrl(key: string, url: Promise<string>): void {
    const entry = { expiresAt: Date.now() + RESOLVE_CACHE_LIFETIME, url };
    this.resolveCache.set(key, entry);
    url.catch(() => {
      if (this.resolveCache.get(key) === entry) this.resolveCache.delete(key);
    });
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
        // Render at the display's real pixel count. The bounds themselves stay
        // in CSS pixels for positioning the overlay windows.
        const scale = this.lastBounds.scale ?? 1;
        session.addon.resize(
          Math.round(this.lastBounds.width * scale),
          Math.round(this.lastBounds.height * scale),
        );
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
        // Discarding mpv's demuxer cache left playback at the starvation
        // edge under the low-latency profile: it caught up to live but then
        // stuttered on every network wobble. Reloading the stream through
        // the same in-place switch used for channel changes lands on the
        // playlist head with a normal buffer ramp instead.
        void this.reloadAtLiveEdge();
        break;
    }
  }

  recoverGraphics(cycleAdapter = false): void {
    this.session?.addon.recoverGraphics(cycleAdapter);
  }

  // Deterministic mute for multistream audio focus (only the active tile plays
  // sound). Unlike control("toggle-mute") this sets an explicit state.
  setMuted(muted: boolean): void {
    const addon = this.session?.addon;
    if (!addon) return;
    addon.command(["set", "mute", muted ? "yes" : "no"]);
    this.updateState({ muted });
  }

  get target(): string {
    return this.renderTarget;
  }

  // Polled by the renderer only while the video stats panel is open.
  getStats(): Record<string, string> | null {
    const addon = this.session?.addon;
    if (!addon) return null;
    try {
      const stats = addon.stats();
      if (stats) stats["vw-fps"] = String(this.measuredFps());
      return stats;
    } catch {
      // An older addon build predates the stats method. Report nothing rather
      // than taking playback down over a diagnostic panel.
      return null;
    }
  }

  /** Frames delivered in the last second — the actual on-screen frame rate. */
  private measuredFps(): number {
    const cutoff = Date.now() - 1000;
    let count = 0;
    for (let i = this.frameTimestamps.length - 1; i >= 0; i -= 1) {
      if (this.frameTimestamps[i] >= cutoff) count += 1;
      else break;
    }
    return count;
  }

  private async reloadAtLiveEdge(): Promise<void> {
    const session = this.session;
    const channel = this.currentChannel;
    if (!session || !session.acceptingFrames || !channel) return;
    await this.switchStream(session, channel, this.state.quality, {
      kind: "channel",
      detail: channel,
    });
  }

  destroy(): void {
    this.startGeneration += 1;
    this.stopping = true;
    this.switchPending = false;
    this.currentChannel = null;
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
      // Reset to the stored volume, not 100, so the slider doesn't flash 100%
      // before the next stream's start applies the saved level.
      volume: Math.min(100, Math.max(0, Math.round(this.getStoredVolume()))),
      behindLive: false,
      quality: "best",
      error: undefined,
      transition: undefined,
    });
  }

  private async resolveStreamUrl(
    channel: string,
    quality: NativeQualityValue,
    // Primary resolves belong to an active start and die with it; hover
    // pre-resolves outlive destroy() so their cache entry stays useful.
    trackAsPrimary: boolean,
  ): Promise<string> {
    const streamlinkPath = this.getStreamlinkPath();
    if (!streamlinkPath) throw new Error("Streamlink is unavailable.");
    const playbackToken = this.getTwitchPlaybackToken();
    const { platform, login } = parseChannelKey(channel);
    // Kick's API answers 403 without a session cookie, which is what drives
    // Streamlink to its headless-browser challenge solver. Supplying one that
    // was fetched anonymously keeps that browser out of the picture. It is not
    // a credential, so it is safe on the command line.
    const kickCookie = platform === "kick" ? await this.getKickCookie() : null;
    return new Promise((resolve, reject) => {
      const child = spawnStreamlink(
        streamlinkPath,
        [
          "--no-config",
          "--loglevel",
          // Keep only error-level output. A silent resolver reduces the
          // generic exit-code error to an unhelpful fallback decision when a
          // channel is simply offline.
          "error",
          "--stream-url",
          ...streamlinkPlatformArguments(platform),
          ...(kickCookie === null ? [] : ["--http-cookie", kickCookie]),
          channelUrl(platform, login),
          quality,
        ],
        playbackToken,
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (trackAsPrimary) this.resolverProcess = child;
      else this.preresolveProcesses.add(child);
      let output = "";
      let errorOutput = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.resolverProcess === child) this.resolverProcess = null;
        this.preresolveProcesses.delete(child);
        if (error) reject(error);
        else {
          const url = output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => /^https?:\/\//i.test(line));
          if (url) resolve(url);
          else {
            const details = redactSensitivePlaybackText(errorOutput.trim());
            // Streamlink can exit non-zero with no stderr at all for an offline
            // channel (environment-dependent), in which case there is no "No
            // playable streams" text to recognize. A resolve that yields no URL
            // is, for `--stream-url`, effectively always an unavailable stream,
            // so classify it as offline unless streamlink handed us a concrete
            // error to surface instead.
            reject(
              new Error(
                details || "No playable streams found: the channel appears to be offline.",
              ),
            );
          }
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
      // "close" (not "exit") fires only after stdout/stderr are fully drained,
      // so a slow final stderr chunk is not missed. When streamlink exits
      // non-zero with a concrete message, surface it; when it exits non-zero
      // with nothing (some environments do this for offline channels), fall
      // through to finish()'s no-URL branch, which reports it as offline rather
      // than a bare "exited with code N" that the caller can't recognize.
      child.on("close", (code) => {
        if (code === 0) {
          finish();
          return;
        }
        const details = redactSensitivePlaybackText(errorOutput.trim());
        finish(details ? new Error(details) : undefined);
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
    // Count every frame the addon hands over — that is the real presented rate.
    this.frameTimestamps.push(Date.now());
    if (this.frameTimestamps.length > 200) this.frameTimestamps.shift();
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

    // Frames still in flight from the outgoing stream are stale the moment a
    // switch begins; presenting them would repaint the old channel under the
    // loading surface. The flag clears when the new stream starts playing.
    if (this.switchPending) {
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

    const transferSequence = ++globalTransferSequence;
    void sharedTexture
      .sendSharedTexture(
        {
          frame: window.webContents.mainFrame,
          importedSharedTexture: imported,
        },
        // Tag the frame with its render target so the preload paints it onto
        // the matching canvas; the sequence stays per-target for ordering.
        { target: this.renderTarget, sequence: transferSequence },
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
    // During an in-place stream switch, frames from the outgoing stream keep
    // transferring until mpv swaps files. They must not present the player as
    // already "playing" the incoming channel — the loading surface stays up
    // until the new stream's first frame arrives.
    if (this.switchPending) return;
    // "Playing" means Chromium has actually accepted a presentable frame,
    // rather than merely that mpv has decoded audio or opened the stream.
    if (this.state.status !== "playing") {
      this.updateState({ status: "playing", error: undefined, transition: undefined });
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
      this.updateState({ status: "error", error: message, transition: undefined });
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
      this.switchPending = false;
      // Keep the loading surface visible until the first texture transfer
      // succeeds. mpv can report playback restart before Chromium has a frame.
      if (this.state.status === "stopped") {
        this.updateState({ status: "starting", error: undefined });
      }
    } else if (event.type === "stopped") {
      if (this.switchPending) {
        // The explicit "stop" and the old file's end both surface here while
        // a switch is in flight; neither is a stop of the incoming stream.
        // The pending flag only clears on the new stream's "playing" event
        // or a real error, so stragglers can never leak a wrong state.
        return;
      }
      this.updateState({ status: "stopped", transition: undefined });
    } else if (event.type === "error") {
      this.switchPending = false;
      this.updateState({ status: "error", error: event.message ?? "Texture playback failed.", transition: undefined });
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
