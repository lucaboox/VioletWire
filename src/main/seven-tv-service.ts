import { z } from "zod";
import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  EmoteImageVariant,
  EmoteSetResult,
  ProviderEmote,
} from "../shared/emotes";

const sevenTvFileSchema = z.object({
  name: z.string(),
  static_name: z.string().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.string(),
});

const sevenTvEmoteSchema = z.object({
  id: z.string(),
  name: z.string(),
  data: z.object({
    animated: z.boolean().default(false),
    host: z.object({
      url: z.string(),
      files: z.array(sevenTvFileSchema),
    }),
  }),
});

const globalResponseSchema = z.object({ emotes: z.array(sevenTvEmoteSchema) });
const channelResponseSchema = z.object({
  emote_set: z.object({ emotes: z.array(sevenTvEmoteSchema) }),
});

interface CachedSet {
  expiresAt: number;
  result: EmoteSetResult;
}

export class SevenTvService {
  private readonly cache = new Map<string, CachedSet>();
  private readonly inFlight = new Map<string, Promise<EmoteSetResult>>();
  private readonly cacheLifetime = 10 * 60_000;
  private readonly cachePath: string | null;
  private cacheLoad: Promise<void> | null = null;
  private cacheWrite: Promise<void> = Promise.resolve();

  constructor(cacheDirectory = app?.getPath?.("userData")) {
    this.cachePath = cacheDirectory
      ? path.join(cacheDirectory, "seven-tv-emotes.json")
      : null;
  }

  async getGlobal(): Promise<EmoteSetResult> {
    return this.getSet(
      "global",
      "https://7tv.io/v3/emote-sets/global",
      (payload) => globalResponseSchema.parse(payload).emotes,
    );
  }

  /**
   * 7TV indexes users per service, so a Kick channel is looked up under its
   * Kick user id rather than a Twitch one. The cache key carries the service
   * too, since the two id spaces overlap and would otherwise collide.
   */
  async getChannel(
    broadcasterId: string,
    platform: "twitch" | "kick" = "twitch",
  ): Promise<EmoteSetResult> {
    const id = z.string().regex(/^\d+$/).parse(broadcasterId);
    return this.getSet(
      `channel:${platform}:${id}`,
      `https://7tv.io/v3/users/${platform}/${encodeURIComponent(id)}`,
      (payload) => channelResponseSchema.parse(payload).emote_set.emotes,
    );
  }

  async clear(): Promise<void> {
    await this.loadPersistentCache();
    this.cache.clear();
    this.inFlight.clear();
    await this.cacheWrite.catch(() => undefined);
    if (this.cachePath) await fs.rm(this.cachePath, { force: true });
  }

  private async getSet(
    cacheKey: string,
    url: string,
    select: (payload: unknown) => z.infer<typeof sevenTvEmoteSchema>[],
  ): Promise<EmoteSetResult> {
    await this.loadPersistentCache();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return this.cloneResult(cached.result);
    if (cached) {
      void this.refreshSet(cacheKey, url, select).catch(() => undefined);
      return { ...this.cloneResult(cached.result), stale: true };
    }
    return this.refreshSet(cacheKey, url, select);
  }

  private refreshSet(
    cacheKey: string,
    url: string,
    select: (payload: unknown) => z.infer<typeof sevenTvEmoteSchema>[],
  ): Promise<EmoteSetResult> {
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;
    const request = this.fetchSet(cacheKey, url, select).finally(() => {
      if (this.inFlight.get(cacheKey) === request) this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, request);
    return request;
  }

  private async fetchSet(
    cacheKey: string,
    url: string,
    select: (payload: unknown) => z.infer<typeof sevenTvEmoteSchema>[],
  ): Promise<EmoteSetResult> {
    const cached = this.cache.get(cacheKey);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "VioletWire/0.1-alpha" },
      });
      // A 404 at the per-channel route means the channel has no 7TV emote
      // set. It is expected, and should behave exactly like an empty set.
      if (!response.ok && !(response.status === 404 && cacheKey.startsWith("channel:"))) {
        throw new Error(`7TV returned ${response.status}.`);
      }
      const providerEmotes = response.status === 404
        ? []
        : select(await response.json()).map((emote) => this.mapEmote(emote));
      const result: EmoteSetResult = {
        provider: "7tv",
        scope: cacheKey === "global" ? "global" : "channel",
        emotes: providerEmotes,
        cachedAt: Date.now(),
        stale: false,
      };
      this.cache.set(cacheKey, { expiresAt: Date.now() + this.cacheLifetime, result });
      await this.queueCacheWrite();
      return this.cloneResult(result);
    } catch (error) {
      if (cached) return { ...this.cloneResult(cached.result), stale: true };
      throw error;
    }
  }

  private loadPersistentCache(): Promise<void> {
    const cachePath = this.cachePath;
    if (!cachePath) return Promise.resolve();
    this.cacheLoad ??= (async () => {
      try {
        const payload = JSON.parse(await fs.readFile(cachePath, "utf8")) as unknown;
        if (typeof payload !== "object" || payload === null) return;
        for (const [key, value] of Object.entries(payload)) {
          const parsed = this.cachedSetSchema().safeParse(value);
          if (parsed.success) this.cache.set(key, parsed.data);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
          throw error;
        }
      }
    })();
    return this.cacheLoad;
  }

  private queueCacheWrite(): Promise<void> {
    this.cacheWrite = this.cacheWrite
      .catch(() => undefined)
      .then(() => this.persistCache());
    return this.cacheWrite;
  }

  private async persistCache(): Promise<void> {
    if (!this.cachePath) return;
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    const temporaryPath = `${this.cachePath}.${process.pid}.tmp`;
    const payload = Object.fromEntries(this.cache);
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(payload), "utf8");
      await fs.rename(temporaryPath, this.cachePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private cachedSetSchema() {
    const variant = z.object({
      url: z.string().url(),
      width: z.number().positive(),
      height: z.number().positive(),
      format: z.string(),
      scale: z.number().positive(),
    });
    const emote = z.object({
      id: z.string(),
      name: z.string(),
      provider: z.literal("7tv"),
      animated: z.boolean(),
      variants: z.array(variant),
    });
    return z.object({
      expiresAt: z.number(),
      result: z.object({
        provider: z.literal("7tv"),
        scope: z.enum(["global", "channel"]),
        emotes: z.array(emote),
        cachedAt: z.number(),
        stale: z.boolean(),
      }),
    });
  }

  private cloneResult(result: EmoteSetResult): EmoteSetResult {
    return {
      ...result,
      emotes: result.emotes.map((emote) => ({
        ...emote,
        variants: emote.variants.map((variant) => ({ ...variant })),
      })),
    };
  }

  private mapEmote(emote: z.infer<typeof sevenTvEmoteSchema>): ProviderEmote {
    const host = emote.data.host.url.startsWith("//")
      ? `https:${emote.data.host.url}`
      : emote.data.host.url;
    const variants: EmoteImageVariant[] = emote.data.host.files
      .filter((file) => ["AVIF", "WEBP", "GIF", "PNG"].includes(file.format.toUpperCase()))
      .map((file) => ({
        url: `${host}/${file.name}`,
        width: file.width,
        height: file.height,
        format: file.format.toLowerCase(),
        scale: this.readScale(file.name),
      }))
      .sort((left, right) => left.scale - right.scale);
    return {
      id: emote.id,
      name: emote.name,
      provider: "7tv",
      animated: emote.data.animated,
      variants,
    };
  }

  private readScale(fileName: string): number {
    const match = /^(\d+)x\./.exec(fileName);
    return match ? Number(match[1]) : 1;
  }
}
