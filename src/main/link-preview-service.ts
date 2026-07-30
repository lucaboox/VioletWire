import { z } from "zod";
import type { LinkPreview } from "../shared/link-preview";
import { resolveGenericLinkPreview } from "./generic-link-preview";
import type { KickService } from "./kick-service";
import type { TwitchService } from "./twitch-service";

const CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 160;

const youTubeOEmbedSchema = z.object({
  title: z.string().min(1).max(500),
  author_name: z.string().min(1).max(200),
  thumbnail_url: z.string().url(),
});

type CachedPreview = { expiresAt: number; value: LinkPreview | null };
type GenericPreviewResolver = (
  url: URL,
  maxHtmlBytes?: number,
) => Promise<LinkPreview>;

function twitchClipId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === "clips.twitch.tv") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id && /^[A-Za-z0-9_-]{4,160}$/.test(id) ? id : null;
  }
  if (host !== "twitch.tv" && host !== "www.twitch.tv" && host !== "m.twitch.tv") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const clipIndex = segments.findIndex((segment) => segment.toLowerCase() === "clip");
  const pathId = clipIndex >= 0 ? segments[clipIndex + 1] : undefined;
  const queryId = url.searchParams.get("clip") ?? undefined;
  const id = pathId ?? queryId;
  return id && /^[A-Za-z0-9_-]{4,160}$/.test(id) ? id : null;
}

function kickClipId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host !== "kick.com" && host !== "www.kick.com") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const clipIndex = segments.findIndex((segment) => {
    const lower = segment.toLowerCase();
    return lower === "clip" || lower === "clips";
  });
  const pathId = clipIndex >= 0 ? segments[clipIndex + 1] : undefined;
  const queryId = url.searchParams.get("clip") ?? undefined;
  const id = pathId ?? queryId;
  return id && /^[A-Za-z0-9_-]{4,160}$/.test(id) ? id : null;
}

function youTubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] ?? null;
  if (host === "youtube.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else if (/^\/(shorts|live|embed)\//.test(url.pathname)) id = url.pathname.split("/")[2] ?? null;
  }
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
}

function youTubeChannelUrl(url: URL): URL | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "youtube.com") return null;

  const pathname = url.pathname.replace(/\/+$/, "");
  const isHandle = /^\/@[A-Za-z0-9._-]{3,30}$/.test(pathname);
  const isChannelId = /^\/channel\/UC[A-Za-z0-9_-]{20,30}$/.test(pathname);
  const isLegacyChannel = /^\/(?:c|user)\/[A-Za-z0-9._-]{1,100}$/.test(pathname);
  if (!isHandle && !isChannelId && !isLegacyChannel) return null;

  return new URL(pathname, "https://www.youtube.com");
}

function imgurAlbumId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host !== "imgur.com" && host !== "www.imgur.com" && host !== "m.imgur.com") {
    return null;
  }
  const match = /^\/a\/([A-Za-z0-9]{5,16})\/?$/.exec(url.pathname);
  return match?.[1] ?? null;
}

function htmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag);
  return match?.[2] ?? null;
}

function htmlMetaContent(html: string, property: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = htmlAttribute(tag, "property") ?? htmlAttribute(tag, "name");
    if (key?.toLowerCase() !== property) continue;
    return htmlAttribute(tag, "content");
  }
  return null;
}

/** Fetches metadata only from fixed, allow-listed provider endpoints. */
export class LinkPreviewService {
  private readonly cache = new Map<string, CachedPreview>();

  constructor(
    private readonly twitchService: TwitchService,
    private readonly kickService: Pick<KickService, "getClipPreview">,
    private readonly genericPreviewResolver: GenericPreviewResolver =
      resolveGenericLinkPreview,
  ) {}

  async getPreview(
    rawUrl: string,
    allowGeneric = false,
  ): Promise<LinkPreview | null> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") return null;
    const cacheKey = `${allowGeneric ? "generic" : "known"}:${url.toString()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value: LinkPreview | null = null;
    try {
      const clipId = twitchClipId(url);
      if (clipId) value = await this.getTwitchClip(clipId);
      else {
        const kickId = kickClipId(url);
        if (kickId) value = await this.getKickClip(kickId);
        else {
          const videoId = youTubeVideoId(url);
          if (videoId) value = await this.getYouTubeVideo(videoId);
          else {
            const channelUrl = youTubeChannelUrl(url);
            if (channelUrl) value = await this.getYouTubeChannel(channelUrl);
            else {
              const albumId = imgurAlbumId(url);
              if (albumId) value = await this.getImgurAlbum(albumId);
              else if (allowGeneric) value = await this.genericPreviewResolver(url);
            }
          }
        }
      }
    } catch {
      // Chat links are untrusted and previews are optional. A signed-out
      // Twitch session or a provider outage must never interrupt chat.
      value = null;
    }
    if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  }

  private async getTwitchClip(clipId: string): Promise<LinkPreview | null> {
    const clip = await this.twitchService.getClipPreview(clipId);
    return clip
      ? {
          kind: "twitch-clip",
          url: clip.url,
          title: clip.title,
          author: clip.broadcasterName,
          thumbnailUrl: clip.thumbnailUrl,
          durationSeconds: clip.durationSeconds,
          createdAt: clip.createdAt,
          viewCount: clip.viewCount,
        }
      : null;
  }

  private async getKickClip(clipId: string): Promise<LinkPreview | null> {
    const clip = await this.kickService.getClipPreview(clipId);
    if (!clip) return null;

    const thumbnail = new URL(clip.thumbnailUrl);
    if (
      thumbnail.protocol !== "https:" ||
      thumbnail.hostname.toLowerCase() !== "clips.kick.com"
    ) {
      return null;
    }
    const channelSlug = /^[A-Za-z0-9_-]{1,100}$/.test(clip.channelSlug)
      ? clip.channelSlug
      : "kick";
    return {
      kind: "kick-clip",
      url: `https://kick.com/${channelSlug}/clips/${encodeURIComponent(clip.id)}`,
      title: clip.title,
      author: channelSlug,
      thumbnailUrl: thumbnail.toString(),
      durationSeconds: clip.durationSeconds,
      createdAt: clip.createdAt,
      viewCount: clip.viewCount,
    };
  }

  private async getYouTubeVideo(videoId: string): Promise<LinkPreview | null> {
    const canonicalUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const response = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return null;
    const payload = youTubeOEmbedSchema.parse(await response.json());
    const thumbnail = new URL(payload.thumbnail_url);
    if (thumbnail.protocol !== "https:") return null;
    return {
      kind: "youtube",
      url: canonicalUrl,
      title: payload.title,
      author: payload.author_name,
      thumbnailUrl: thumbnail.toString(),
    };
  }

  private async getYouTubeChannel(channelUrl: URL): Promise<LinkPreview | null> {
    const preview = await this.genericPreviewResolver(channelUrl, 1_000_000);
    return {
      ...preview,
      kind: "youtube",
      url: channelUrl.toString(),
      title: preview.title.replace(/\s*-\s*YouTube\s*$/i, ""),
      author: "YouTube channel",
    };
  }

  private async getImgurAlbum(albumId: string): Promise<LinkPreview | null> {
    const canonicalUrl = `https://imgur.com/a/${albumId}`;
    const response = await fetch(canonicalUrl, {
      headers: { Accept: "text/html" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.toLowerCase().startsWith("text/html")) return null;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > 512_000) return null;

    const html = (await response.text()).slice(0, 512_000);
    const rawThumbnail =
      htmlMetaContent(html, "og:image") ?? htmlMetaContent(html, "twitter:image");
    if (!rawThumbnail) return null;
    const thumbnail = new URL(rawThumbnail.replaceAll("&amp;", "&"));
    if (thumbnail.protocol !== "https:" || thumbnail.hostname.toLowerCase() !== "i.imgur.com") {
      return null;
    }
    if (!/\.(png|jpe?g|gif|webp)$/i.test(thumbnail.pathname)) return null;
    return {
      kind: "imgur-album",
      url: canonicalUrl,
      title: "Imgur album",
      author: "Imgur",
      thumbnailUrl: thumbnail.toString(),
    };
  }
}
