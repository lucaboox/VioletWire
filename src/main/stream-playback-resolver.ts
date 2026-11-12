import type { ChildProcess } from "node:child_process";
import type {
  NativePlayerAvailability,
  NativeQuality,
  NativeQualityValue,
} from "../shared/player";
import { parseStreamlinkQualityOutput } from "../shared/player";
import {
  channelUrl,
  parseChannelKey,
  streamlinkPlatformArguments,
} from "../shared/platform";
import { getNativeRuntimeAvailability } from "./native-runtime";
import { StreamlinkWorker } from "./streamlink-worker";
import {
  redactSensitivePlaybackText,
  spawnStreamlink,
} from "./streamlink-process";

const RESOLVE_CACHE_LIFETIME = 60_000;
const QUALITY_CACHE_LIFETIME = 5 * 60_000;
const MAX_CONCURRENT_PRERESOLVES = 2;

/**
 * Resolves authenticated Twitch and Kick streams for Chromium HLS playback.
 * This owns only Streamlink processes and caches; it has no video-rendering
 * dependency and can be used independently by every player surface.
 */
export class StreamPlaybackResolver {
  private readonly worker = new StreamlinkWorker();
  private generation = 0;
  private disposed = false;
  private activePrimaryKey: string | null = null;
  private activePreresolves = 0;
  private lastToken: string | null | undefined;
  private readonly streamCache = new Map<
    string,
    { expiresAt: number; streams: Promise<Record<string, string>> }
  >();
  private resolverProcess: ChildProcess | null = null;
  private readonly preresolveProcesses = new Set<ChildProcess>();
  private readonly resolveCache = new Map<
    string,
    { expiresAt: number; url: Promise<string> }
  >();
  private readonly qualityCache = new Map<
    string,
    { expiresAt: number; result: Promise<NativeQuality[]> }
  >();

  constructor(
    private readonly getTwitchPlaybackToken: () => string | null,
    private readonly getKickCookie: () => Promise<string | null> = async () =>
      null,
  ) {}

  warmup(): void {
    this.worker.start();
  }

  private refreshAuthentication(): void {
    const token = this.getTwitchPlaybackToken();
    if (token === this.lastToken) return;
    this.lastToken = token;
    this.resolveCache.clear();
    this.qualityCache.clear();
    this.streamCache.clear();
  }

  private getWarmStreams(channel: string): Promise<Record<string, string>> {
    this.refreshAuthentication();
    const cached = this.streamCache.get(channel);
    if (cached && cached.expiresAt > Date.now()) return cached.streams;
    const streams = this.worker.resolve(
      parseChannelKey(channel).login,
      this.getTwitchPlaybackToken(),
    );
    const entry = { expiresAt: Date.now() + RESOLVE_CACHE_LIFETIME, streams };
    if (this.streamCache.size >= 32) {
      const oldest = this.streamCache.keys().next().value;
      if (oldest !== undefined) this.streamCache.delete(oldest);
    }
    this.streamCache.set(channel, entry);
    streams.catch(() => {
      if (this.streamCache.get(channel) === entry)
        this.streamCache.delete(channel);
    });
    return streams;
  }

  getAvailability(): NativePlayerAvailability {
    return getNativeRuntimeAvailability();
  }

  async getQualities(channel: string): Promise<NativeQuality[]> {
    if (this.disposed) return [{ value: "best", label: "Auto" }];
    this.refreshAuthentication();
    if (parseChannelKey(channel).platform === "twitch") {
      try {
        const streams = await this.getWarmStreams(channel);
        return parseStreamlinkQualityOutput(
          `Available streams: ${Object.keys(streams).join(", ")}`,
        );
      } catch {
        /* The existing CLI remains the compatibility path. */
      }
    }
    const target = parseChannelKey(channel);
    if (this.disposed) return [{ value: "best", label: "Auto" }];
    const playbackToken = this.getTwitchPlaybackToken();
    const cacheKey = `${channel}:${playbackToken ? "authenticated" : "anonymous"}`;
    const cached = this.qualityCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const availability = this.getAvailability();
    if (!availability.available || !availability.streamlinkPath) {
      return Promise.resolve([{ value: "best", label: "Auto" }]);
    }

    const result = new Promise<NativeQuality[]>((resolve) => {
      const child = spawnStreamlink(
        availability.streamlinkPath!,
        [
          "--no-config",
          "--loglevel",
          "none",
          ...streamlinkPlatformArguments(target.platform),
          channelUrl(target.platform, target.login),
        ],
        { twitchToken: playbackToken },
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
        child.kill();
        finish([{ value: "best", label: "Auto" }]);
      }, 12_000);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (output.length < 32_768) output += chunk.toString();
      });
      child.on("error", () => finish([{ value: "best", label: "Auto" }]));
      child.on("close", () => finish(parseStreamlinkQualityOutput(output)));
    });
    this.qualityCache.set(cacheKey, {
      expiresAt: Date.now() + QUALITY_CACHE_LIFETIME,
      result,
    });
    return result;
  }

  preresolve(channel: string): void {
    this.refreshAuthentication();
    if (!this.getAvailability().available) return;
    const key = `${channel.toLowerCase()}:best`;
    const cached = this.resolveCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return;
    if (this.disposed || this.activePreresolves >= MAX_CONCURRENT_PRERESOLVES)
      return;
    this.activePreresolves += 1;
    const url = this.resolveStreamUrl(channel, "best", false);
    this.storeResolvedUrl(key, url);
    void url
      .finally(() => {
        this.activePreresolves -= 1;
      })
      .catch(() => undefined);
  }

  resolve(channel: string, quality: NativeQualityValue): Promise<string> {
    this.refreshAuthentication();
    const key = `${channel.toLowerCase()}:${quality}`;
    const cached = this.resolveCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    this.activePrimaryKey = key;
    const url = this.resolveStreamUrl(channel, quality, true);
    this.storeResolvedUrl(key, url);
    return url;
  }

  cancelActiveResolution(): void {
    this.generation += 1;
    if (this.activePrimaryKey) this.resolveCache.delete(this.activePrimaryKey);
    this.activePrimaryKey = null;
    if (!this.resolverProcess) return;
    this.resolverProcess.kill();
    this.resolverProcess = null;
  }

  destroy(): void {
    this.disposed = true;
    this.worker.destroy();
    this.streamCache.clear();
    this.cancelActiveResolution();
    for (const process of this.preresolveProcesses) process.kill();
    this.preresolveProcesses.clear();
    this.resolveCache.clear();
    this.qualityCache.clear();
  }

  private storeResolvedUrl(key: string, url: Promise<string>): void {
    const entry = { expiresAt: Date.now() + RESOLVE_CACHE_LIFETIME, url };
    this.resolveCache.set(key, entry);
    url.catch(() => {
      if (this.resolveCache.get(key) === entry) this.resolveCache.delete(key);
    });
  }

  private async resolveStreamUrl(
    channel: string,
    quality: NativeQualityValue,
    trackAsPrimary: boolean,
  ): Promise<string> {
    if (this.disposed) throw new Error("Stream resolver stopped.");
    const generation = this.generation;
    if (parseChannelKey(channel).platform === "twitch") {
      try {
        const streams = await this.getWarmStreams(channel);
        if (trackAsPrimary && generation !== this.generation)
          throw new Error("Stream resolution cancelled.");
        const url = streams[quality];
        if (url) return url;
      } catch {
        /* Retry through the established CLI on worker failure. */
      }
      if (this.disposed || (trackAsPrimary && generation !== this.generation))
        throw new Error("Stream resolution cancelled.");
    }
    const streamlinkPath = this.getAvailability().streamlinkPath;
    if (!streamlinkPath) throw new Error("Streamlink is unavailable.");
    const playbackToken = this.getTwitchPlaybackToken();
    const { platform, login } = parseChannelKey(channel);
    const kickCookie = platform === "kick" ? await this.getKickCookie() : null;

    return new Promise((resolve, reject) => {
      const child = spawnStreamlink(
        streamlinkPath,
        [
          "--no-config",
          "--loglevel",
          "error",
          "--stream-url",
          ...streamlinkPlatformArguments(platform),
          channelUrl(platform, login),
          quality,
        ],
        // The Kick session goes the same private way as the Twitch token.
        // On the command line it was readable by any program on the machine
        // whenever Twitch playback was not linked.
        { twitchToken: playbackToken, httpCookie: kickCookie },
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
        if (error) {
          reject(error);
          return;
        }
        const url = output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => /^https?:\/\//i.test(line));
        if (url) {
          resolve(url);
          return;
        }
        const details = redactSensitivePlaybackText(errorOutput.trim());
        reject(
          new Error(
            details ||
              "No playable streams found: the channel appears to be offline.",
          ),
        );
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
}
