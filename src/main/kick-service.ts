import { z } from "zod";

/**
 * Kick's public API does not expose enough to run a viewer: there is no
 * followed-channels endpoint and the chat API is send-only. The site's own v2
 * API covers both, and is what the bundled Streamlink already calls to resolve
 * a stream, so this service talks to the same surface.
 *
 * It is reverse engineered and can change without notice. Every call here
 * degrades to null or an empty list rather than throwing, so a Kick outage
 * leaves the rest of the app working.
 */

const KICK_ORIGIN = "https://kick.com";
// Kick issues a session cookie to anonymous visitors, and presenting it is
// enough to satisfy the challenge that otherwise makes the API return 403.
// Nothing about it identifies a person until someone signs in.
const SESSION_COOKIE = "kick_session";
const REQUEST_TIMEOUT_MS = 10_000;
// Long enough that a viewing session reuses one cookie, short enough that a
// rotated cookie recovers without waiting for a failure.
const SESSION_TTL_MS = 30 * 60 * 1000;

// Kick sends far more than this; only the fields the app renders are declared,
// and everything is optional so a shape change degrades a single card rather
// than failing the whole response.
const kickLivestreamSchema = z.object({
  id: z.number().optional(),
  is_live: z.boolean().optional(),
  viewer_count: z.number().optional(),
  session_title: z.string().optional(),
  created_at: z.string().optional(),
  thumbnail: z
    .union([z.string(), z.object({ url: z.string().optional() })])
    .optional(),
  categories: z
    .array(z.object({ name: z.string().optional() }))
    .optional(),
});

const kickChannelSchema = z.object({
  id: z.number().optional(),
  slug: z.string().optional(),
  user: z
    .object({
      username: z.string().optional(),
      profile_pic: z.string().nullable().optional(),
    })
    .optional(),
  chatroom: z.object({ id: z.number().optional() }).optional(),
  livestream: kickLivestreamSchema.nullable().optional(),
});

export interface KickChannel {
  id: string;
  slug: string;
  displayName: string;
  profileImageUrl: string;
  /** Needed to subscribe to the channel's chat; absent means chat is unavailable. */
  chatroomId?: string;
  isLive: boolean;
  title?: string;
  category?: string;
  viewerCount: number;
  startedAt?: string;
  thumbnailUrl?: string;
}

function readThumbnail(livestream: z.infer<typeof kickLivestreamSchema>): string | undefined {
  const { thumbnail } = livestream;
  if (typeof thumbnail === "string") return thumbnail;
  return thumbnail?.url;
}

export class KickService {
  private sessionCookie: string | null = null;
  private sessionFetchedAt = 0;
  // Single-flight, so a burst of channel lookups on startup shares one refresh
  // instead of each opening its own request.
  private sessionRequest: Promise<string | null> | null = null;

  /**
   * The cookie Streamlink needs to resolve a Kick stream without falling back
   * to its headless-browser challenge solver.
   */
  async getSessionCookie(forceRefresh = false): Promise<string | null> {
    const fresh =
      this.sessionCookie !== null &&
      Date.now() - this.sessionFetchedAt < SESSION_TTL_MS;
    if (fresh && !forceRefresh) return this.sessionCookie;

    this.sessionRequest ??= this.requestSessionCookie().finally(() => {
      this.sessionRequest = null;
    });
    return this.sessionRequest;
  }

  private async requestSessionCookie(): Promise<string | null> {
    try {
      const response = await fetch(KICK_ORIGIN, {
        headers: { Accept: "text/html", "User-Agent": this.userAgent() },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // getSetCookie keeps the individual cookies separate; a plain get()
      // joins them into one string that cannot be split safely, because
      // cookie values may contain commas.
      const cookies = response.headers.getSetCookie();
      for (const cookie of cookies) {
        const [pair] = cookie.split(";");
        const separator = pair.indexOf("=");
        if (separator === -1) continue;
        if (pair.slice(0, separator).trim() !== SESSION_COOKIE) continue;
        this.sessionCookie = pair.slice(separator + 1).trim();
        this.sessionFetchedAt = Date.now();
        return this.sessionCookie;
      }
    } catch {
      // Offline, blocked, or Kick changed the handshake. Callers treat a null
      // cookie as "try without one" rather than as a hard failure.
    }
    return null;
  }

  /** `name=value`, ready for Streamlink's --http-cookie. */
  async getStreamlinkCookie(): Promise<string | null> {
    const value = await this.getSessionCookie();
    return value === null ? null : `${SESSION_COOKIE}=${value}`;
  }

  async getChannel(slug: string): Promise<KickChannel | null> {
    const payload = await this.requestJson(`/api/v2/channels/${encodeURIComponent(slug)}`);
    if (payload === null) return null;

    const parsed = kickChannelSchema.safeParse(payload);
    if (!parsed.success) return null;
    return this.mapChannel(parsed.data);
  }

  private mapChannel(channel: z.infer<typeof kickChannelSchema>): KickChannel | null {
    const slug = channel.slug;
    if (!slug) return null;

    const livestream = channel.livestream ?? null;
    return {
      id: channel.id === undefined ? slug : String(channel.id),
      slug,
      displayName: channel.user?.username ?? slug,
      profileImageUrl: channel.user?.profile_pic ?? "",
      chatroomId: channel.chatroom?.id === undefined ? undefined : String(channel.chatroom.id),
      // A null livestream is how Kick reports an offline channel.
      isLive: Boolean(livestream?.is_live),
      title: livestream?.session_title,
      category: livestream?.categories?.[0]?.name,
      viewerCount: livestream?.viewer_count ?? 0,
      startedAt: livestream?.created_at,
      thumbnailUrl: livestream === null ? undefined : readThumbnail(livestream),
    };
  }

  /**
   * Retries once with a fresh cookie: a 403 usually means the session rotated
   * rather than that the request was wrong.
   */
  private async requestJson(path: string, retryOnForbidden = true): Promise<unknown> {
    const cookie = await this.getSessionCookie();
    try {
      const response = await fetch(`${KICK_ORIGIN}${path}`, {
        headers: {
          Accept: "application/json",
          "User-Agent": this.userAgent(),
          ...(cookie === null ? {} : { Cookie: `${SESSION_COOKIE}=${cookie}` }),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if ((response.status === 403 || response.status === 401) && retryOnForbidden) {
        await this.getSessionCookie(true);
        return this.requestJson(path, false);
      }
      // 404 is an ordinary answer here: the channel does not exist.
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  private userAgent(): string {
    // Kick's edge rejects requests without a browser-shaped agent.
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  }
}
