import type { BrowserWindow } from "electron";
import type {
  NativeHlsStateReport,
  NativePlayerCommand,
  NativePlayerState,
  NativePlayerTransition,
  NativeQualityValue,
} from "../shared/player";
import { isHighResolutionQuality } from "../shared/player";
import type { PlaybackLatencyMode } from "../shared/preferences";
import { parseChannelKey } from "../shared/platform";
import { FilteredHlsRelay } from "./filtered-hls-relay";
import type { HlsMediaTransport } from "./hls-media-transport";

type StartResult = { ok: true } | { ok: false; reason: string };

export class HlsNativePlayer {
  private generation = 0;
  private relay: FilteredHlsRelay | null = null;
  private stats: Record<string, string> | null = null;
  private lastAudibleVolume = 100;
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
    private readonly getRendererOrigin: () => string | null,
    private readonly resolvePlaybackUrl: (
      channel: string,
      quality: NativeQualityValue,
    ) => Promise<string>,
    private readonly getStoredVolume: () => number,
    private readonly getLatencyMode: () => PlaybackLatencyMode,
    private readonly onState: (state: NativePlayerState) => void,
    private readonly cancelPlaybackResolution: () => void = () => undefined,
    private readonly renderTarget = "main",
    private readonly mediaTransport?: HlsMediaTransport,
  ) {}

  async start(
    channel: string,
    quality: NativeQualityValue,
    transition?: NativePlayerTransition,
  ): Promise<StartResult> {
    const generation = ++this.generation;
    this.cancelPlaybackResolution();
    await this.closeRelay();
    const storedVolume = this.clampVolume(this.getStoredVolume());
    if (storedVolume > 0) this.lastAudibleVolume = storedVolume;
    const volume = this.state.muted ? 0 : storedVolume;
    this.stats = null;
    this.updateState({
      status: "starting",
      paused: false,
      muted: this.state.muted,
      volume,
      compressorEnabled: this.state.compressorEnabled,
      behindLive: false,
      quality,
      hlsSource: undefined,
      error: undefined,
      transition,
    });

    try {
      const requestedLatencyMode = this.getLatencyMode();
      const target = parseChannelKey(channel);
      const sourceUrl = await this.resolvePlaybackUrl(channel, quality);
      if (generation !== this.generation) {
        return { ok: false, reason: "Native playback was cancelled." };
      }
      const highResolutionSafeguard =
        requestedLatencyMode === "ultra-low" &&
        target.platform === "twitch" &&
        isHighResolutionQuality(quality, []);
      const latencyMode: PlaybackLatencyMode = highResolutionSafeguard
        ? "balanced"
        : requestedLatencyMode;
      const relay = new FilteredHlsRelay(
        this.getRendererOrigin,
        target.platform,
        {
          includePrefetch: latencyMode === "ultra-low",
          // Electron custom-protocol responses are excellent for completed
          // fragments, but do not preserve Twitch's still-growing PREFETCH
          // timing reliably. The localhost relay streams those responses in
          // the same form used by VioletWire's previously stable 1080p path.
          mediaTransport:
            latencyMode === "ultra-low" ? undefined : this.mediaTransport,
        },
      );
      const playlistUrl = await relay.start(sourceUrl);
      if (generation !== this.generation) {
        await relay.close();
        return { ok: false, reason: "Native playback was cancelled." };
      }
      this.relay = relay;
      this.stats = {
        "Latency mode": highResolutionSafeguard
          ? "Balanced (1440p safeguard)"
          : latencyMode === "ultra-low"
            ? "Ultra low"
            : "Balanced",
        "Media transport":
          relay.mediaTransportName === "chromium-protocol"
            ? "Chromium protocol stream"
            : "Localhost compatibility relay",
        Protocol: "Filtered HLS",
      };
      this.updateState({
        hlsSource: {
          sessionId: crypto.randomUUID(),
          playlistUrl,
          latencyMode,
          requestedLatencyMode,
          mediaTransport: relay.mediaTransportName,
        },
      });
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (generation === this.generation) {
        this.updateState({
          status: "error",
          error: reason,
          transition: undefined,
          hlsSource: undefined,
        });
      }
      return { ok: false, reason };
    }
  }

  control(command: NativePlayerCommand): void {
    if (command.command === "set-compressor") {
      this.updateState({ compressorEnabled: command.enabled });
      this.sendCommand(command);
      return;
    }
    if (command.command === "toggle-mute") {
      this.applyMuted(!this.state.muted);
      return;
    }
    if (command.command === "set-muted") {
      this.applyMuted(command.muted);
      return;
    }
    if (command.command === "set-volume") {
      const volume = this.clampVolume(command.value);
      if (volume > 0) this.lastAudibleVolume = volume;
      const muted = volume === 0;
      this.updateState({ volume, muted });
      this.sendCommand({ command: "set-volume", value: volume });
      return;
    }
    this.sendCommand(command);
  }

  private sendCommand(command: NativePlayerCommand): void {
    const window = this.getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send("native-hls:command", {
      target: this.renderTarget,
      command,
    });
  }

  report(report: NativeHlsStateReport): void {
    if (
      report.target !== this.renderTarget ||
      report.sessionId !== this.state.hlsSource?.sessionId
    ) {
      return;
    }
    if (report.stats) this.stats = { ...report.stats };
    const nextVolume = Math.round(report.volume);
    if (!report.muted && nextVolume > 0) {
      this.lastAudibleVolume = nextVolume;
    }
    if (
      this.state.status === report.status &&
      this.state.paused === report.paused &&
      this.state.muted === report.muted &&
      this.state.volume === nextVolume &&
      this.state.behindLive === report.behindLive &&
      this.state.error === report.error &&
      (report.status !== "playing" || this.state.transition === undefined)
    ) {
      return;
    }
    this.updateState({
      status: report.status,
      paused: report.paused,
      muted: report.muted,
      volume: nextVolume,
      behindLive: report.behindLive,
      error: report.error,
      transition: report.status === "playing" ? undefined : this.state.transition,
    });
  }

  getStats(): Record<string, string> | null {
    return this.stats ? { ...this.stats } : null;
  }

  getState(): NativePlayerState {
    return { ...this.state };
  }

  setMuted(muted: boolean): void {
    this.applyMuted(muted);
  }

  destroy(): void {
    const wasActive = this.relay !== null || this.state.status !== "idle";
    this.generation += 1;
    this.cancelPlaybackResolution();
    void this.closeRelay();
    this.stats = null;
    if (!wasActive) return;
    this.updateState({
      status: "idle",
      paused: false,
      muted: false,
      volume: Math.min(100, Math.max(0, Math.round(this.getStoredVolume()))),
      behindLive: false,
      quality: "best",
      hlsSource: undefined,
      error: undefined,
      transition: undefined,
    });
  }

  private async closeRelay(): Promise<void> {
    const relay = this.relay;
    this.relay = null;
    if (relay) await relay.close();
  }

  private applyMuted(muted: boolean): void {
    if (muted) {
      if (!this.state.muted && this.state.volume > 0) {
        this.lastAudibleVolume = this.state.volume;
      }
      this.updateState({ muted: true, volume: 0 });
      this.sendCommand({ command: "set-volume", value: 0 });
      return;
    }
    const storedVolume = this.clampVolume(this.getStoredVolume());
    const volume =
      this.lastAudibleVolume > 0
        ? this.lastAudibleVolume
        : storedVolume > 0
          ? storedVolume
          : 100;
    this.updateState({ muted: false, volume });
    this.sendCommand({ command: "set-volume", value: volume });
  }

  private clampVolume(volume: number): number {
    return Math.min(100, Math.max(0, Math.round(volume)));
  }

  private updateState(update: Partial<NativePlayerState>): void {
    this.state = { ...this.state, ...update };
    this.onState({ ...this.state });
  }
}
