import { z } from "zod";
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
  private readonly cacheLifetime = 10 * 60_000;

  async getGlobal(): Promise<EmoteSetResult> {
    return this.getSet(
      "global",
      "https://7tv.io/v3/emote-sets/global",
      (payload) => globalResponseSchema.parse(payload).emotes,
    );
  }

  async getChannel(broadcasterId: string): Promise<EmoteSetResult> {
    const id = z.string().regex(/^\d+$/).parse(broadcasterId);
    return this.getSet(
      `channel:${id}`,
      `https://7tv.io/v3/users/twitch/${encodeURIComponent(id)}`,
      (payload) => channelResponseSchema.parse(payload).emote_set.emotes,
    );
  }

  clear(): void {
    this.cache.clear();
  }

  private async getSet(
    cacheKey: string,
    url: string,
    select: (payload: unknown) => z.infer<typeof sevenTvEmoteSchema>[],
  ): Promise<EmoteSetResult> {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "VioletWire/0.1-alpha" },
      });
      if (!response.ok) throw new Error(`7TV returned ${response.status}.`);
      const providerEmotes = select(await response.json()).map((emote) => this.mapEmote(emote));
      const result: EmoteSetResult = {
        provider: "7tv",
        scope: cacheKey === "global" ? "global" : "channel",
        emotes: providerEmotes,
        cachedAt: Date.now(),
        stale: false,
      };
      this.cache.set(cacheKey, { expiresAt: Date.now() + this.cacheLifetime, result });
      return result;
    } catch (error) {
      if (cached) return { ...cached.result, stale: true };
      throw error;
    }
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
