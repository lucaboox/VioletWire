import { z } from "zod";
import type { LinkPreview } from "../shared/link-preview";
import type { TwitchService } from "./twitch-service";

const CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 160;

const youTubeOEmbedSchema = z.object({
  title: z.string().min(1).max(500),
  author_name: z.string().min(1).max(200),
  thumbnail_url: z.string().url(),
});

type CachedPreview = { expiresAt: number; value: LinkPreview | null };

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

  constructor(private readonly twitchService: TwitchService) {}

  async getPreview(rawUrl: string): Promise<LinkPreview | null> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") return null;
    const cacheKey = url.toString();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value: LinkPreview | null = null;
    try {
      const clipId = twitchClipId(url);
      if (clipId) value = await this.getTwitchClip(clipId);
      else {
        const videoId = youTubeVideoId(url);
        if (videoId) value = await this.getYouTubeVideo(videoId);
        else {
          const albumId = imgurAlbumId(url);
          if (albumId) value = await this.getImgurAlbum(albumId);
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
