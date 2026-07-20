import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  EmoteImageVariant,
  EmoteProvider,
  EmoteSetResult,
  ProviderEmote,
} from "../shared/emotes";

const ffzEmoteSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  width: z.number().positive(),
  height: z.number().positive(),
  urls: z.record(z.string(), z.string()),
  modifier: z.boolean().optional().default(false),
  modifier_flags: z.number().int().nonnegative().optional().default(0),
});
const ffzResponseSchema = z.object({
  sets: z.record(
    z.string(),
    z.object({ emoticons: z.array(ffzEmoteSchema) }),
  ),
});
const bttvEmoteSchema = z.object({
  id: z.string(),
  code: z.string(),
  imageType: z.string().optional(),
  animated: z.boolean().optional(),
  modifier: z.boolean().optional().default(false),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});
const bttvGlobalSchema = z.array(bttvEmoteSchema);
const bttvChannelSchema = z.object({
  channelEmotes: z.array(bttvEmoteSchema).default([]),
  sharedEmotes: z.array(bttvEmoteSchema).default([]),
});

interface CachedSet {
  expiresAt: number;
  result: EmoteSetResult;
}

export class ThirdPartyEmoteService {
  private readonly cache = new Map<string, CachedSet>();
  private readonly inFlight = new Map<string, Promise<EmoteSetResult>>();
  private readonly cacheLifetime = 30 * 60_000;
  private readonly cachePath: string | null;
  private cacheLoad: Promise<void> | null = null;
  private cacheWrite: Promise<void> = Promise.resolve();

  constructor(cacheDirectory = app?.getPath?.("userData")) {
    this.cachePath = cacheDirectory
      ? path.join(cacheDirectory, "third-party-emotes.json")
      : null;
  }

  getFfzGlobal(): Promise<EmoteSetResult> {
    return this.getSet("ffz:global", "ffz", "global", async () => {
      const payload = ffzResponseSchema.parse(
        await this.fetchJson("https://api.frankerfacez.com/v1/set/global", "FFZ"),
      );
      return Object.values(payload.sets).flatMap((set) =>
        set.emoticons.map((emote) => this.mapFfzEmote(emote)),
      );
    });
  }

  getFfzChannel(broadcasterId: string): Promise<EmoteSetResult> {
    const id = z.string().regex(/^\d+$/).parse(broadcasterId);
    return this.getSet(`ffz:channel:${id}`, "ffz", "channel", async () => {
      const response = await this.fetchChannelJson(
        `https://api.frankerfacez.com/v1/room/id/${encodeURIComponent(id)}`,
        "FFZ",
      );
      if (response === null) return [];
      const payload = ffzResponseSchema.parse(response);
      return Object.values(payload.sets).flatMap((set) =>
        set.emoticons.map((emote) => this.mapFfzEmote(emote)),
      );
    });
  }

  getBttvGlobal(): Promise<EmoteSetResult> {
    return this.getSet("bttv:v2:global", "bttv", "global", async () =>
      bttvGlobalSchema
        .parse(
          await this.fetchJson(
            "https://api.betterttv.net/3/cached/emotes/global",
            "BetterTTV",
          ),
        )
        .map((emote) => this.mapBttvEmote(emote)),
    );
  }

  getBttvChannel(broadcasterId: string): Promise<EmoteSetResult> {
    const id = z.string().regex(/^\d+$/).parse(broadcasterId);
    return this.getSet(`bttv:v2:channel:${id}`, "bttv", "channel", async () => {
      const response = await this.fetchChannelJson(
        `https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(id)}`,
        "BetterTTV",
      );
      if (response === null) return [];
      const payload = bttvChannelSchema.parse(response);
      return [...payload.channelEmotes, ...payload.sharedEmotes].map((emote) =>
        this.mapBttvEmote(emote),
      );
    });
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
    provider: EmoteProvider,
    scope: "global" | "channel",
    load: () => Promise<ProviderEmote[]>,
  ): Promise<EmoteSetResult> {
    await this.loadPersistentCache();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return this.cloneResult(cached.result);
    if (cached) {
      void this.refreshSet(cacheKey, provider, scope, load).catch(() => undefined);
      return { ...this.cloneResult(cached.result), stale: true };
    }
    return this.refreshSet(cacheKey, provider, scope, load);
  }

  private refreshSet(
    cacheKey: string,
    provider: EmoteProvider,
    scope: "global" | "channel",
    load: () => Promise<ProviderEmote[]>,
  ): Promise<EmoteSetResult> {
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;
    const request = (async () => {
      const cached = this.cache.get(cacheKey);
      try {
        const result: EmoteSetResult = {
          provider,
          scope,
          emotes: await load(),
          cachedAt: Date.now(),
          stale: false,
        };
        this.cache.set(cacheKey, {
          expiresAt: Date.now() + this.cacheLifetime,
          result,
        });
        await this.queueCacheWrite();
        return this.cloneResult(result);
      } catch (error) {
        if (cached) return { ...this.cloneResult(cached.result), stale: true };
        throw error;
      }
    })().finally(() => {
      if (this.inFlight.get(cacheKey) === request) this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, request);
    return request;
  }

  private async fetchJson(url: string, provider: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "VioletWire/0.1-alpha",
      },
    });
    if (!response.ok) throw new Error(`${provider} returned ${response.status}.`);
    return response.json();
  }

  // These APIs use 404 to mean that a valid Twitch channel simply has no
  // emote set with that provider. Treat it as an empty, cacheable set rather
  // than rejecting the IPC request and making an expected condition look like
  // an Electron application error.
  private async fetchChannelJson(url: string, provider: string): Promise<unknown | null> {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "VioletWire/0.1-alpha",
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${provider} returned ${response.status}.`);
    return response.json();
  }

  private mapFfzEmote(emote: z.infer<typeof ffzEmoteSchema>): ProviderEmote {
    const variants: EmoteImageVariant[] = Object.entries(emote.urls)
      .map(([scaleText, rawUrl]) => {
        const scale = Number(scaleText);
        return {
          url: rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl,
          width: emote.width * (Number.isFinite(scale) ? scale : 1),
          height: emote.height * (Number.isFinite(scale) ? scale : 1),
          format: "webp",
          scale: Number.isFinite(scale) ? scale : 1,
        };
      })
      .sort((left, right) => left.scale - right.scale);
    return {
      id: String(emote.id),
      name: emote.name,
      provider: "ffz",
      animated: false,
      modifier: emote.modifier,
      modifierFlags: emote.modifier_flags,
      variants,
    };
  }

  private mapBttvEmote(emote: z.infer<typeof bttvEmoteSchema>): ProviderEmote {
    const logicalWidth = emote.width ?? 28;
    const logicalHeight = emote.height ?? 28;
    const variants: EmoteImageVariant[] = [1, 2, 3].map((scale) => ({
      url: `https://cdn.betterttv.net/emote/${encodeURIComponent(emote.id)}/${scale}x.webp`,
      width: logicalWidth * scale,
      height: logicalHeight * scale,
      format: "webp",
      scale,
    }));
    return {
      id: emote.id,
      name: emote.code,
      provider: "bttv",
      animated: emote.animated ?? emote.imageType?.toLowerCase() === "gif",
      modifier: emote.modifier,
      variants,
    };
  }

  private loadPersistentCache(): Promise<void> {
    if (!this.cachePath) return Promise.resolve();
    this.cacheLoad ??= (async () => {
      try {
        const payload = JSON.parse(await fs.readFile(this.cachePath!, "utf8")) as unknown;
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
    try {
      await fs.writeFile(
        temporaryPath,
        JSON.stringify(Object.fromEntries(this.cache)),
        "utf8",
      );
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
      provider: z.enum(["ffz", "bttv"]),
      animated: z.boolean(),
      modifier: z.boolean(),
      modifierFlags: z.number().int().nonnegative().optional(),
      variants: z.array(variant),
    });
    return z.object({
      expiresAt: z.number(),
      result: z.object({
        provider: z.enum(["ffz", "bttv"]),
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
}
