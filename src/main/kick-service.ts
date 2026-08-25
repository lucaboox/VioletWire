import { BrowserWindow, session, type Session } from "electron";
import { z } from "zod";
import type {
  BrowseCategory,
  BrowseStream,
  BrowsePage,
  ChatUserProfile,
  TwitchPinnedChatMessage,
} from "../shared/twitch";
import type { KickAuthState, KickChatColorState } from "../shared/platform";

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
const KICK_IDENTITY_ORIGIN = "https://id.kick.com";
// Kick's newer API host, which serves the category directory the site itself
// pages through (viewer-sorted and cursor-paginated). It needs no account.
const KICK_WEB_ORIGIN = "https://web.kick.com";
// Kick issues a session cookie to anonymous visitors, and presenting it is
// enough to satisfy the challenge that otherwise makes the API return 403.
// Nothing about it identifies a person until someone signs in.
const SESSION_COOKIE = "kick_session";
const REQUEST_TIMEOUT_MS = 10_000;
// Long enough that a viewing session reuses one cookie, short enough that a
// rotated cookie recovers without waiting for a failure.
const SESSION_TTL_MS = 30 * 60 * 1000;
// Its own partition, so the solved cookie survives restarts and the challenge
// is not re-run on every launch. Kept apart from the Twitch website session.
const KICK_PARTITION = "persist:violetwire-kick";
const CHALLENGE_TIMEOUT_MS = 15_000;
// When the challenge does not yield a cookie, every later request would
// otherwise re-run it and wait the full timeout again. Back off instead, and
// let requests proceed without a cookie in the meantime.
const CHALLENGE_FAILURE_BACKOFF_MS = 60_000;
// How long stream resolution will wait for a cookie before going without one.
const COOKIE_WAIT_MS = 2_500;
// Long enough that the followed poll rarely refetches details, short enough
// that a thumbnail does not go stale while watching.
const DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;

type UnknownRecord = Record<string, unknown>;

/**
 * Kick's social-login page only forwards the completed provider callback to
 * the main site when its `redirect` query is present. Without it, Google can
 * leave the auth window on the identity landing page and the kick.com session
 * never becomes observable by the app.
 */
export function getKickLoginUrl(): string {
  const loginUrl = new URL("/login", KICK_IDENTITY_ORIGIN);
  loginUrl.searchParams.set("redirect", `${KICK_ORIGIN}/`);
  return loginUrl.toString();
}

interface KickWriteCredentials {
  bearer: string;
  xsrf: string;
}

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// Kick sends far more than this; only the fields the app renders are declared,
// and everything is optional so a shape change degrades a single card rather
// than failing the whole response.
const kickLivestreamSchema = z.object({
  id: z.number().nullish(),
  is_live: z.boolean().nullish(),
  viewer_count: z.number().nullish(),
  session_title: z.string().nullish(),
  created_at: z.string().nullish(),
  start_time: z.string().nullish(),
  categories: z
    .array(z.object({ name: z.string().nullish() }))
    .optional(),
});

// The dedicated livestream route, whose thumbnail actually loads. The channel
// endpoint returns one on stream.kick.com that answers 403, while this returns
// an images.kick.com URL that the site itself uses.
const kickLivestreamRouteSchema = z.object({
  data: z
    .object({
      created_at: z.string().nullish(),
      start_time: z.string().nullish(),
      thumbnail: z.object({ src: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

const kickChannelSchema = z.object({
  id: z.number().nullish(),
  slug: z.string().nullish(),
  user_id: z.number().nullish(),
  user: z
    .object({
      id: z.number().nullish(),
      username: z.string().nullish(),
      profile_pic: z.string().nullish(),
      bio: z.string().nullish(),
      created_at: z.string().nullish(),
    })
    .optional(),
  subscriber_badges: z
    .array(z.object({ id: z.number().nullish(), months: z.number().nullish() }))
    .nullish(),
  chatroom: z
    .object({
      id: z.number().nullish(),
      followers_mode: z.boolean().nullish(),
      subscribers_mode: z.boolean().nullish(),
      emotes_mode: z.boolean().nullish(),
      slow_mode: z.boolean().nullish(),
      message_interval: z.number().nullish(),
      following_min_duration: z.number().nullish(),
    })
    .optional(),
  livestream: kickLivestreamSchema.nullable().optional(),
  // Only returned to a signed-in caller; absent otherwise.
  following: z.boolean().nullish(),
});

// Search entries are a different, thinner shape than the channel endpoint's:
// live state is `isLive` rather than a nested livestream, and there is no
// chatroom, title, or viewer count.
const kickSearchSchema = z.object({
  channels: z
    .array(
      z.object({
        id: z.number().nullish(),
        slug: z.string().nullish(),
        isLive: z.boolean().nullish(),
        user: z
          .object({
            username: z.string().nullish(),
            profilePic: z.string().nullish(),
            profile_pic: z.string().nullish(),
          })
          .optional(),
        recentCategories: z
          .array(z.object({ name: z.string().nullish() }))
          .optional(),
      }),
    )
    .optional(),
});

// Signed out, /api/v1/user answers with an empty array rather than an error,
// so identity is decided by whether a username came back.
const kickUserSchema = z.object({
  id: z.number().nullish(),
  username: z.string().nullish(),
  profile_pic: z.string().nullish(),
  color: z.string().nullish(),
  chat_color: z.string().nullish(),
  identity: z.object({ color: z.string().nullish() }).nullish(),
});

const kickPublicUserSchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  username: z.string().nullish(),
  slug: z.string().nullish(),
  profile_pic: z.string().nullish(),
  profile_picture: z.string().nullish(),
  bio: z.string().nullish(),
  created_at: z.string().nullish(),
  user: z
    .object({
      id: z.union([z.string(), z.number()]).nullish(),
      username: z.string().nullish(),
      slug: z.string().nullish(),
      profile_pic: z.string().nullish(),
      profile_picture: z.string().nullish(),
      bio: z.string().nullish(),
      created_at: z.string().nullish(),
    })
    .nullish(),
  following_since: z.string().nullish(),
  followed_at: z.string().nullish(),
  is_following: z.boolean().nullish(),
  following: z.boolean().nullish(),
  subscribed: z.boolean().nullish(),
  is_subscribed: z.boolean().nullish(),
  subscription: z
    .object({
      active: z.boolean().nullish(),
      is_subscribed: z.boolean().nullish(),
      tier: z.union([z.string(), z.number()]).nullish(),
      gifted: z.boolean().nullish(),
    })
    .nullish(),
});

const kickIdentitySchema = z.object({
  color: z.string().nullish(),
  data: z.object({ color: z.string().nullish() }).nullish(),
});

const kickClipSchema = z.object({
  clip: z.object({
    id: z.union([z.string(), z.number()]).nullish(),
    title: z.string().nullish(),
    thumbnail_url: z.string().nullish(),
    duration: z.number().nullish(),
    views: z.number().nullish(),
    created_at: z.string().nullish(),
    channel: z
      .object({
        slug: z.string().nullish(),
      })
      .nullish(),
  }),
});

export interface KickClipPreview {
  id: string;
  title: string;
  channelSlug: string;
  thumbnailUrl: string;
  durationSeconds?: number;
  createdAt?: string;
  viewCount?: number;
}

// The followed list is its own shape again: live state sits on the entry
// rather than in a nested livestream.
// Every field is nullish rather than optional: Kick returns null for anything
// unset, and a plain .optional() rejects null, which failed the whole page over
// one absent title or start time.
// The observed shape of a followed entry. It shares almost no field names with
// the channel endpoint: the slug is channel_slug, the avatar is
// profile_picture, and there is no id or start time at all. The alternatives
// below are kept because the search and channel routes spell the same things
// differently, and this route is unofficial enough to drift.
const kickFollowedEntrySchema = z.object({
  id: z.number().nullish(),
  channel_slug: z.string().nullish(),
  slug: z.string().nullish(),
  user_username: z.string().nullish(),
  username: z.string().nullish(),
  profile_picture: z.string().nullish(),
  profile_pic: z.string().nullish(),
  profilePic: z.string().nullish(),
  is_live: z.boolean().nullish(),
  isLive: z.boolean().nullish(),
  viewer_count: z.number().nullish(),
  viewers: z.number().nullish(),
  session_title: z.string().nullish(),
  category_name: z.string().nullish(),
  category: z.union([z.string(), z.object({ name: z.string().nullish() })]).nullish(),
  start_time: z.string().nullish(),
  created_at: z.string().nullish(),
});

const kickFollowedSchema = z.object({
  channels: z.array(z.unknown()).nullish(),
  next_cursor: z.union([z.string(), z.number()]).nullish(),
});

// Emote sets: the channel's own, then Global and Emoji.
const kickEmoteSetsSchema = z.array(
  z.object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().nullish(),
    emotes: z
      .array(
        z.object({
          id: z.number().nullish(),
          name: z.string().nullish(),
          subscribers_only: z.boolean().nullish(),
        }),
      )
      .optional(),
  }),
);

export interface KickChatHistoryEntry {
  id?: string | null;
  content?: string | null;
  created_at?: string | null;
  type?: string | null;
  metadata?: unknown;
  thread_parent_id?: string | null;
  replied_to?: unknown;
  replies_to?: unknown;
  sender?: {
    id?: number | null;
    slug?: string | null;
    username?: string | null;
    identity?: {
      color?: string | null;
      badges?: { type?: string | null; text?: string | null; count?: number | null }[] | null;
      badges_v2?: { name?: string | null; image_url?: string | null }[] | null;
    } | null;
  } | null;
}

const kickHistorySenderSchema = z
  .object({
    id: z.number().nullish(),
    slug: z.string().nullish(),
    username: z.string().nullish(),
    identity: z
      .object({
        color: z.string().nullish(),
        badges: z
          .array(
            z.object({
              type: z.string().nullish(),
              text: z.string().nullish(),
              count: z.number().nullish(),
            }),
          )
          .nullish(),
        badges_v2: z
          .array(
            z.object({ name: z.string().nullish(), image_url: z.string().nullish() }),
          )
          .nullish(),
      })
      .nullish(),
  })
  .nullish();

const kickChatHistorySchema = z.object({
  data: z
    .object({
      messages: z
        .array(
          z.object({
            id: z.union([z.string(), z.number()]).nullish(),
            content: z.string().nullish(),
            created_at: z.string().nullish(),
            type: z.string().nullish(),
            metadata: z.unknown().optional(),
            thread_parent_id: z.union([z.string(), z.number()]).nullish(),
            replied_to: z.unknown().optional(),
            replies_to: z.unknown().optional(),
            sender: kickHistorySenderSchema,
          }),
        )
        .nullish()
        .transform((messages) =>
          (messages ?? []).map((message) => ({
            ...message,
            id: message.id === null || message.id === undefined ? undefined : String(message.id),
            thread_parent_id:
              message.thread_parent_id === null || message.thread_parent_id === undefined
                ? undefined
                : String(message.thread_parent_id),
          })),
        ),
      pinned_message: z
        .object({
          duration: z.union([z.string(), z.number()]).nullish(),
          finish_at: z.string().nullish(),
          pinned_by: z
            .object({
              username: z.string().nullish(),
              slug: z.string().nullish(),
            })
            .nullish(),
          message: z
            .object({
              id: z.union([z.string(), z.number()]),
              content: z.string(),
              created_at: z.string().nullish(),
              sender: kickHistorySenderSchema,
            })
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

export interface KickUser {
  id: string;
  username: string;
  profileImageUrl: string;
}

export interface KickEmote {
  id: string;
  name: string;
  imageUrl: string;
  subscribersOnly: boolean;
}

export interface KickEmoteSet {
  id: string;
  name: string;
  emotes: KickEmote[];
}

export interface KickChatRestrictions {
  followersOnly: boolean;
  followersMinMinutes?: number;
  subscribersOnly: boolean;
  slowModeSeconds?: number;
  emoteOnly: boolean;
}

export interface KickChannel {
  id: string;
  /** Kick's user id, which is what 7TV indexes a Kick channel by. */
  userId?: string;
  slug: string;
  displayName: string;
  profileImageUrl: string;
  /** Needed to subscribe to the channel's chat; absent means chat is unavailable. */
  chatroomId?: string;
  /** Whether the signed-in account follows this channel; undefined if unknown. */
  following?: boolean;
  restrictions?: KickChatRestrictions;
  /** Sub badge tiers, newest-months first, so a sub's count picks its image. */
  subscriberBadges?: { months: number; imageUrl: string }[];
  isLive: boolean;
  title?: string;
  category?: string;
  viewerCount: number;
  startedAt?: string;
  thumbnailUrl?: string;
}

export interface KickChatReplyTarget {
  id: string;
  content: string;
  senderId: number;
  senderUsername: string;
  threadParentId?: string;
}

/**
 * Kick timestamps look like "2026-07-22 18:06:16": no T, no zone, and the
 * value is UTC. Parsed as-is they are read as local time, which is why uptime
 * showed as zero. Normalised to ISO so the renderer's duration is right.
 */
function toIsoTimestamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value);
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  return `${match[1]}T${match[2]}Z`;
}

const kickBannerSchema = z
  .object({
    responsive: z.string().nullish(),
    srcset: z.string().nullish(),
    url: z.string().nullish(),
    src: z.string().nullish(),
  })
  .nullish();

const kickCategorySchema = z.object({
  id: z.number().nullish(),
  name: z.string().nullish(),
  slug: z.string().nullish(),
  banner: kickBannerSchema,
});

const kickCategoryListSchema = z.object({
  data: z.array(kickCategorySchema).nullish(),
  current_page: z.number().nullish(),
  next_page_url: z.string().nullish(),
});

const kickCategorySearchSchema = z.object({
  categories: z.array(kickCategorySchema).nullish(),
});

// A live stream from Kick's web API (the one its category grid pages through).
const kickWebStreamSchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  title: z.string().nullish(),
  start_time: z.string().nullish(),
  language: z.string().nullish(),
  is_mature: z.boolean().nullish(),
  viewer_count: z.number().nullish(),
  tags: z.array(z.string()).nullish(),
  thumbnail: z.object({ src: z.string().nullish() }).nullish(),
  channel: z
    .object({
      id: z.number().nullish(),
      slug: z.string().nullish(),
      username: z.string().nullish(),
      profile_pic: z.string().nullish(),
    })
    .nullish(),
  category: z.object({ name: z.string().nullish() }).nullish(),
});

const kickCategoryStreamsSchema = z.object({
  data: z
    .object({
      livestreams: z.array(kickWebStreamSchema).nullish(),
      pagination: z.object({ next_cursor: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

/** Kick's images come as a `srcset` string or a plain URL; take the first URL. */
function firstSrcsetUrl(...candidates: (string | null | undefined)[]): string {
  for (const value of candidates) {
    if (!value) continue;
    const first = value.split(",")[0]?.trim().split(/\s+/)[0];
    if (first) return first;
  }
  return "";
}

/** A Kick subcategory shaped into the shared BrowseCategory. Its numeric id
 *  becomes the id, since that is what the category-streams route filters by. */
function mapKickCategory(entry: z.infer<typeof kickCategorySchema>): BrowseCategory | null {
  if (entry.id == null || !entry.name) return null;
  return {
    id: String(entry.id),
    name: entry.name,
    boxArtUrl: firstSrcsetUrl(
      entry.banner?.responsive,
      entry.banner?.srcset,
      entry.banner?.url,
      entry.banner?.src,
    ),
  };
}

export class KickService {
  private sessionCookie: string | null = null;
  private sessionFetchedAt = 0;
  // Single-flight, so a burst of channel lookups on startup shares one refresh
  // instead of each opening its own request.
  private sessionRequest: Promise<string | null> | null = null;
  private challengeFailedAt = 0;
  private loginWindow: BrowserWindow | null = null;
  private writeCredentialRepairRequest: Promise<KickWriteCredentials | null> | null = null;
  private writeCredentialRepairWindow: BrowserWindow | null = null;
  private readonly detailCache = new Map<
    string,
    { expiresAt: number; thumbnailUrl?: string; startedAt?: string }
  >();

  /**
   * The cookie Streamlink needs to resolve a Kick stream without falling back
   * to its headless-browser challenge solver.
   */
  async getSessionCookie(forceRefresh = false): Promise<string | null> {
    const fresh =
      this.sessionCookie !== null &&
      Date.now() - this.sessionFetchedAt < SESSION_TTL_MS;
    if (fresh && !forceRefresh) return this.sessionCookie;

    if (forceRefresh) {
      this.sessionCookie = null;
      await this.clearStoredCookie();
    }
    this.sessionRequest ??= this.requestSessionCookie().finally(() => {
      this.sessionRequest = null;
    });
    return this.sessionRequest;
  }

  private kickSession(): Session {
    return session.fromPartition(KICK_PARTITION);
  }

  private async readStoredCookie(): Promise<string | null> {
    try {
      const [cookie] = await this.kickSession().cookies.get({
        url: KICK_ORIGIN,
        name: SESSION_COOKIE,
      });
      return cookie?.value ?? null;
    } catch {
      return null;
    }
  }

  private async requestSessionCookie(): Promise<string | null> {
    // A plain HTTP request cannot obtain this. Kick answers 403 and sets only
    // Cloudflare's own cookie; the session cookie is issued after a JS
    // challenge runs. Loading the page in a real Chromium context solves it the
    // way any browser would, which is also how Streamlink's plugin does it —
    // except the browser here is the one already shipped with the app, so
    // nothing extra has to be installed or found on PATH.
    const stored = await this.readStoredCookie();
    if (stored !== null) {
      this.sessionCookie = stored;
      this.sessionFetchedAt = Date.now();
      this.log("reused the stored session cookie");
      return stored;
    }

    if (Date.now() - this.challengeFailedAt < CHALLENGE_FAILURE_BACKOFF_MS) {
      return null;
    }

    const startedAt = Date.now();
    const solved = await this.solveChallenge();
    if (solved !== null) {
      this.sessionCookie = solved;
      this.sessionFetchedAt = Date.now();
      this.challengeFailedAt = 0;
      this.log(`solved the challenge in ${Date.now() - startedAt}ms`);
    } else {
      this.challengeFailedAt = Date.now();
      this.log(
        `challenge produced no ${SESSION_COOKIE} cookie after ${Date.now() - startedAt}ms; ` +
          "requests will continue without one",
      );
    }
    return solved;
  }

  /** Structure only, never values: enough to see a shape change, nothing personal. */
  private describeShape(payload: unknown): string {
    if (Array.isArray(payload)) {
      const first = payload[0];
      const keys =
        typeof first === "object" && first !== null ? Object.keys(first).join(",") : typeof first;
      return `array(${payload.length}) of {${keys}}`;
    }
    if (typeof payload === "object" && payload !== null) {
      return `object {${Object.keys(payload).join(",")}}`;
    }
    return typeof payload;
  }

  private log(message: string): void {
    // Diagnostics only; the resolver's own errors already surface to the user.
    console.log(`[kick] ${message}`);
  }

  private async solveChallenge(): Promise<string | null> {
    // The partition persists, so this normally runs once and later launches
    // reuse the stored cookie rather than loading anything.
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: KICK_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Nothing here is trusted; it is a third-party page rendered purely so
        // its own scripts can complete the handshake.
        webSecurity: true,
        images: false,
      },
    });

    // The page runs bot-detection that opens WebRTC connections to hosts which
    // often do not resolve, filling the console with P2P errors while it is
    // alive. Nothing here needs peer connections, so keep them off the wire.
    window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");

    try {
      await Promise.race([
        window.loadURL(KICK_ORIGIN),
        new Promise((resolve) => setTimeout(resolve, CHALLENGE_TIMEOUT_MS)),
      ]);
      // The cookie is set by script after load, so poll briefly rather than
      // reading once and giving up.
      const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const cookie = await this.readStoredCookie();
        if (cookie !== null) return cookie;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return null;
    } catch {
      return null;
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  /** Drops the stored cookie so the next request solves the challenge again. */
  private async clearStoredCookie(): Promise<void> {
    try {
      await this.kickSession().cookies.remove(KICK_ORIGIN, SESSION_COOKIE);
    } catch {
      // Nothing to clear.
    }
  }

  /**
   * `name=value`, ready for Streamlink's --http-cookie.
   *
   * Resolution must not wait on the challenge. A cached cookie is returned at
   * once; otherwise acquisition starts and this gives up quickly, because
   * Streamlink often resolves without one and holding playback for the full
   * challenge timeout is worse than sending the request unauthenticated. The
   * cookie is then ready for the next stream.
   */
  async getStreamlinkCookie(): Promise<string | null> {
    const pending = this.getSessionCookie();
    const value = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), COOKIE_WAIT_MS)),
    ]);
    // Keep the acquisition running in the background when the wait expired.
    void pending.catch(() => null);
    return value === null ? null : `${SESSION_COOKIE}=${value}`;
  }

  /**
   * Kick's search returns channels without viewer counts or stream titles, so
   * results carry less than Twitch's. The renderer groups the two services
   * rather than interleaving them, which keeps the thinner rows from reading
   * as though they failed to load.
   */
  async search(term: string): Promise<KickChannel[]> {
    const query = term.trim();
    if (query.length === 0) return [];

    const payload = await this.requestJson(
      `/api/search?searched_word=${encodeURIComponent(query)}`,
    );
    if (payload === null) return [];

    const parsed = kickSearchSchema.safeParse(payload);
    if (!parsed.success) return [];

    const results: KickChannel[] = [];
    for (const entry of parsed.data.channels ?? []) {
      const slug = entry.slug;
      if (!slug) continue;
      results.push({
        id: entry.id === undefined ? slug : String(entry.id),
        slug,
        displayName: entry.user?.username ?? slug,
        profileImageUrl: entry.user?.profilePic ?? entry.user?.profile_pic ?? "",
        // Search does not include the chatroom, so opening a result looks the
        // channel up before connecting chat.
        chatroomId: undefined,
        isLive: Boolean(entry.isLive),
        category: entry.recentCategories?.[0]?.name ?? undefined,
        viewerCount: 0,
      });
    }
    return results;
  }

  async getClipPreview(clipId: string): Promise<KickClipPreview | null> {
    if (!/^[A-Za-z0-9_-]{4,160}$/.test(clipId)) return null;

    // The current site uses /play; the older metadata route is retained as a
    // fallback because shared links using both generations still circulate.
    const current = await this.requestJson(
      `/api/v2/clips/${encodeURIComponent(clipId)}/play`,
    );
    const payload =
      current ?? (await this.requestJson(`/api/v2/clips/${encodeURIComponent(clipId)}`));
    const parsed = kickClipSchema.safeParse(payload);
    if (!parsed.success) return null;

    const clip = parsed.data.clip;
    if (!clip.thumbnail_url) return null;
    return {
      id: clip.id === null || clip.id === undefined ? clipId : String(clip.id),
      title: clip.title?.trim() || "Kick clip",
      channelSlug: clip.channel?.slug?.trim() || "Kick",
      thumbnailUrl: clip.thumbnail_url,
      durationSeconds: clip.duration ?? undefined,
      createdAt: clip.created_at ?? undefined,
      viewCount: clip.views ?? undefined,
    };
  }

  /**
   * Kick's category directory. With a query it searches categories; without
   * one it pages through the full list. The returned cursor is the next page.
   */
  async getCategories(query: string, cursor?: string): Promise<BrowsePage<BrowseCategory>> {
    const search = query.trim();
    if (search.length > 0) {
      const payload = await this.requestJson(
        `/api/search?searched_word=${encodeURIComponent(search)}`,
      );
      const parsed = kickCategorySearchSchema.safeParse(payload);
      if (!parsed.success) return { items: [] };
      return {
        items: (parsed.data.categories ?? []).flatMap((entry) => {
          const category = mapKickCategory(entry);
          return category ? [category] : [];
        }),
      };
    }

    const page = cursor ?? "1";
    const payload = await this.requestJson(
      `/api/v1/subcategories?page=${encodeURIComponent(page)}`,
    );
    const parsed = kickCategoryListSchema.safeParse(payload);
    if (!parsed.success) return { items: [] };
    return {
      items: (parsed.data.data ?? []).flatMap((entry) => {
        const category = mapKickCategory(entry);
        return category ? [category] : [];
      }),
      cursor: parsed.data.next_page_url
        ? String((parsed.data.current_page ?? Number(page)) + 1)
        : undefined,
    };
  }

  /**
   * The live channels in a category, highest viewer count first, keyed by the
   * category's numeric id. Paged through the same web API the site uses; the
   * cursor is an opaque token from the previous page.
   */
  async getCategoryStreams(categoryId: string, cursor?: string): Promise<BrowsePage<BrowseStream>> {
    const id = categoryId.trim();
    if (id.length === 0) return { items: [] };

    const params = new URLSearchParams({
      language: "en",
      limit: "24",
      sort: "viewer_count_desc",
      category_id: id,
    });
    if (cursor) params.set("after", cursor);

    let payload: unknown;
    try {
      const response = await this.kickSession().fetch(
        `${KICK_WEB_ORIGIN}/api/v1/livestreams?${params.toString()}`,
        {
          headers: {
            Accept: "application/json",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": this.userAgent(),
            Referer: `${KICK_ORIGIN}/`,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) return { items: [] };
      payload = await response.json();
    } catch {
      return { items: [] };
    }

    const parsed = kickCategoryStreamsSchema.safeParse(payload);
    if (!parsed.success) return { items: [] };

    const items: BrowseStream[] = [];
    for (const stream of parsed.data.data?.livestreams ?? []) {
      const channelSlug = stream.channel?.slug;
      if (!channelSlug) continue;
      items.push({
        id: stream.id == null ? channelSlug : String(stream.id),
        broadcasterId: stream.channel?.id == null ? channelSlug : String(stream.channel.id),
        login: channelSlug,
        displayName: stream.channel?.username ?? channelSlug,
        title: stream.title ?? "",
        category: stream.category?.name ?? "",
        language: stream.language ?? "",
        tags: stream.tags ?? [],
        isMature: Boolean(stream.is_mature),
        profileImageUrl: stream.channel?.profile_pic ?? "",
        thumbnailUrl: stream.thumbnail?.src ?? "",
        viewerCount: stream.viewer_count ?? 0,
        startedAt: toIsoTimestamp(stream.start_time) ?? "",
      });
    }
    const next = parsed.data.data?.pagination?.next_cursor ?? undefined;
    // Only advance when there is both a cursor and something on this page, so
    // the scroll stops at the end instead of refetching the last page.
    return { items, cursor: next && items.length > 0 ? next : undefined };
  }

  private async requestUser(): Promise<KickUser | null> {
    const payload = await this.requestJson("/api/v1/user");
    return this.parseUser(payload);
  }

  private parseUser(payload: unknown): KickUser | null {
    // Signed out this route answers 200 with an empty array, so the shape
    // itself is the signal rather than the status code.
    const parsed = kickUserSchema.safeParse(payload);
    if (!parsed.success || !parsed.data.username) return null;
    return {
      id: parsed.data.id === undefined ? "" : String(parsed.data.id),
      username: parsed.data.username,
      profileImageUrl: parsed.data.profile_pic ?? "",
    };
  }

  /** The signed-in Kick account. Write-only CSRF state is repaired separately. */
  async getUser(): Promise<KickUser | null> {
    // The bearer identifies the account. XSRF-TOKEN is intentionally not a
    // prerequisite here: Google login can issue it after the account session,
    // and treating that brief/repairable state as signed out broke sign-in.
    if ((await this.readSessionToken()) === null) return null;
    return this.requestUser();
  }

  /**
   * Checks a stored login without confusing a network/Kick outage with an
   * expired account. The renderer uses the reason once at startup, then clears
   * the rejected local session so the warning cannot repeat every minute.
   */
  async getAuthState(): Promise<KickAuthState> {
    const [bearer, xsrf] = await Promise.all([
      this.readSessionToken(),
      this.readXsrfToken(),
    ]);
    if (bearer === null && xsrf === null) {
      return { status: "signed-out", account: null };
    }
    // XSRF without an account bearer is stale. The inverse is a valid account
    // whose write cookie may still be initializing after social login.
    if (bearer === null) {
      return { status: "signed-out", account: null, reason: "expired" };
    }

    try {
      const response = await this.kickSession().fetch(`${KICK_ORIGIN}/api/v1/user`, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": this.userAgent(),
          Referer: `${KICK_ORIGIN}/`,
          Authorization: `Bearer ${bearer}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401) {
        return { status: "signed-out", account: null, reason: "expired" };
      }
      // A 403 can be Kick's edge challenge rather than an invalid account.
      if (!response.ok) return { status: "unavailable", account: null };

      const account = this.parseUser(await response.json());
      if (account === null) {
        return { status: "signed-out", account: null, reason: "expired" };
      }
      if (xsrf === null) {
        // Do not hold startup or invalidate a working account while Kick
        // creates its write cookie. A send will still fail closed if repair
        // does not complete.
        void this.repairWriteCredentials().catch(() => undefined);
      }
      return { status: "signed-in", account };
    } catch {
      return { status: "unavailable", account: null };
    }
  }

  /**
   * Public profile details for a chatter. Kick's channel-scoped route adds
   * relationship fields when the current account is signed in; the user route
   * supplies the stable avatar, bio, and creation date. Both are unofficial,
   * so every field is optional and the card degrades gracefully.
   */
  async getChatUserProfile(channel: string, login: string): Promise<ChatUserProfile> {
    const [publicPayload, relationPayload, channelPayload] = await Promise.all([
      this.requestJson(`/api/v1/users/${encodeURIComponent(login)}`),
      this.requestJson(
        `/api/v2/channels/${encodeURIComponent(channel)}/users/${encodeURIComponent(login)}`,
      ),
      this.requestJson(`/api/v2/channels/${encodeURIComponent(login)}`),
    ]);
    const publicResult = kickPublicUserSchema.safeParse(publicPayload);
    const relationResult = kickPublicUserSchema.safeParse(relationPayload);
    const channelResult = kickChannelSchema.safeParse(channelPayload);
    const publicData = publicResult.success ? publicResult.data : undefined;
    const relationData = relationResult.success ? relationResult.data : undefined;
    const channelUser = channelResult.success ? channelResult.data.user : undefined;
    const user =
      publicData?.user ?? relationData?.user ?? publicData ?? relationData;
    const relationship = relationData;
    const id = user?.id ?? publicData?.id ?? relationData?.id ?? channelUser?.id;
    const displayName =
      user?.username ??
      publicData?.username ??
      relationData?.username ??
      channelUser?.username;
    const isFollowing =
      relationship?.is_following ?? relationship?.following ?? undefined;
    const isSubscribed =
      relationship?.is_subscribed ??
      relationship?.subscribed ??
      relationship?.subscription?.is_subscribed ??
      relationship?.subscription?.active ??
      undefined;

    return {
      id: String(id ?? channelUser?.id ?? login),
      login: user?.slug ?? publicData?.slug ?? relationData?.slug ?? login,
      displayName: displayName ?? channelUser?.username ?? login,
      profileImageUrl:
        user?.profile_pic ??
        user?.profile_picture ??
        publicData?.profile_pic ??
        publicData?.profile_picture ??
        channelUser?.profile_pic ??
        "",
      description: user?.bio ?? publicData?.bio ?? channelUser?.bio ?? "",
      createdAt: user?.created_at ?? publicData?.created_at ?? channelUser?.created_at ?? "",
      relationship:
        isFollowing === undefined && isSubscribed === undefined
          ? undefined
          : {
              isFollowing: isFollowing ?? false,
              followedAt:
                relationship?.following_since ?? relationship?.followed_at ?? undefined,
              subscription:
                isSubscribed === undefined
                  ? undefined
                  : {
                      isSubscribed,
                      tier:
                        relationship?.subscription?.tier == null
                          ? undefined
                          : String(relationship.subscription.tier),
                      isGift: relationship?.subscription?.gifted ?? undefined,
                    },
            },
    };
  }

  async getChatColor(): Promise<KickChatColorState> {
    const accountPayload = await this.requestJson("/api/v1/user");
    const account = kickUserSchema.safeParse(accountPayload);
    if (!account.success || account.data.id == null) {
      return { color: "", canUpdate: false };
    }
    const payload = await this.requestJson(
      `/api/internal/v1/chatroom/users/${encodeURIComponent(String(account.data.id))}/identity`,
    );
    const identity = kickIdentitySchema.safeParse(payload);
    return {
      color:
        (identity.success
          ? identity.data.color ?? identity.data.data?.color
          : undefined) ??
        account.data.identity?.color ??
        account.data.chat_color ??
        account.data.color ??
        "",
      canUpdate: true,
    };
  }

  async updateChatColor(color: string): Promise<KickChatColorState> {
    const credentials = await this.readWriteCredentials();
    if (credentials === null) throw new Error("Sign in to Kick to change your color.");

    const path = "/api/internal/v1/chatroom/identity";
    const body = { color };
    const response = await this.kickSession().fetch(`${KICK_ORIGIN}${path}`, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": this.userAgent(),
        Referer: `${KICK_ORIGIN}/`,
        "X-XSRF-TOKEN": credentials.xsrf,
        Authorization: `Bearer ${credentials.bearer}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let status = response.status;
    if (status === 401 || status === 403 || status === 419) {
      status = await this.pageFetch(path, "PUT", credentials.bearer, body);
    }
    if (status === 401 || status === 403 || status === 419) {
      throw new Error("Kick rejected the session. Sign in again.");
    }
    if (status < 200 || status >= 300) {
      throw new Error("Kick would not change the username color.");
    }
    return { color, canUpdate: true };
  }

  /**
   * Channels the signed-in account follows. Kick has no public endpoint for
   * this, so it comes from the site's own paginated route and needs the
   * browser session; signed out it simply yields nothing.
   */
  async getFollowedChannels(): Promise<KickChannel[]> {
    const channels: KickChannel[] = [];
    let cursor: string | null = null;

    // Bounded: a runaway cursor must not loop forever.
    for (let page = 0; page < 10; page += 1) {
      const path: string =
        cursor === null
          ? "/api/v2/channels/followed"
          : `/api/v2/channels/followed?cursor=${encodeURIComponent(cursor)}`;
      const payload: unknown = await this.requestJson(path);
      if (payload === null) break;

      const parsed = kickFollowedSchema.safeParse(
        Array.isArray(payload) ? { channels: payload } : payload,
      );
      if (!parsed.success) {
        this.log(
          `followed list had an unexpected shape: ${this.describeShape(payload)}`,
        );
        break;
      }

      const entries = parsed.data.channels ?? [];
      if (page === 0 && entries.length === 0) {
        this.log(`followed list was empty; payload was ${this.describeShape(payload)}`);
      }

      let rejected = 0;
      for (const raw of entries) {
        // Entries are validated one at a time so a single unexpected record
        // cannot empty the whole list.
        const entry = kickFollowedEntrySchema.safeParse(raw);
        if (!entry.success) {
          rejected += 1;
          continue;
        }
        const slug = entry.data.channel_slug ?? entry.data.slug;
        if (!slug) {
          rejected += 1;
          continue;
        }
        const category =
          typeof entry.data.category === "string"
            ? entry.data.category
            : entry.data.category?.name;
        const isLive = Boolean(entry.data.is_live ?? entry.data.isLive);
        channels.push({
          id: entry.data.id === null || entry.data.id === undefined ? slug : String(entry.data.id),
          slug,
          displayName: entry.data.user_username ?? entry.data.username ?? slug,
          profileImageUrl:
            entry.data.profile_picture ??
            entry.data.profilePic ??
            entry.data.profile_pic ??
            "",
          isLive,
          title: entry.data.session_title ?? undefined,
          category: isLive ? (entry.data.category_name ?? category ?? "") : "Offline",
          viewerCount: entry.data.viewer_count ?? entry.data.viewers ?? 0,
          startedAt: toIsoTimestamp(entry.data.start_time ?? entry.data.created_at),
        });
      }
      if (rejected > 0) {
        this.log(
          `skipped ${rejected} of ${entries.length} followed entries; ` +
            `first looked like ${this.describeShape(entries[0])}`,
        );
      }

      const next = parsed.data.next_cursor;
      if (next === null || next === undefined || next === "" || next === 0) break;
      cursor = String(next);
    }
    await this.fillLiveDetails(channels);
    return channels;
  }

  /**
   * The followed route carries no thumbnail or start time, so live channels are
   * topped up from the channel endpoint, which has both. Offline ones are left
   * alone and each result is cached, so a refresh usually costs nothing.
   */
  private async fillLiveDetails(channels: KickChannel[]): Promise<void> {
    const now = Date.now();
    for (const channel of channels) {
      if (!channel.isLive) continue;

      const cached = this.detailCache.get(channel.slug);
      if (cached && cached.expiresAt > now) {
        channel.thumbnailUrl = cached.thumbnailUrl;
        channel.startedAt = cached.startedAt;
        continue;
      }
      const details = await this.getLivestream(channel.slug);
      if (details === null) continue;
      channel.thumbnailUrl = details.thumbnailUrl;
      channel.startedAt = details.startedAt;
      this.detailCache.set(channel.slug, {
        expiresAt: now + DETAIL_CACHE_TTL_MS,
        thumbnailUrl: details.thumbnailUrl,
        startedAt: details.startedAt,
      });
    }
  }

  /**
   * The live thumbnail and start time from the dedicated livestream route. Its
   * thumbnail is the one that actually loads, unlike the channel endpoint's.
   * Returns null when the channel is offline.
   */
  async getLivestream(
    slug: string,
  ): Promise<{ thumbnailUrl?: string; startedAt?: string } | null> {
    const payload = await this.requestJson(
      `/api/v2/channels/${encodeURIComponent(slug)}/livestream`,
    );
    if (payload === null) return null;
    const parsed = kickLivestreamRouteSchema.safeParse(payload);
    if (!parsed.success || !parsed.data.data) return null;
    return {
      thumbnailUrl: parsed.data.data.thumbnail?.src ?? undefined,
      startedAt: toIsoTimestamp(
        parsed.data.data.start_time ?? parsed.data.data.created_at,
      ),
    };
  }

  /**
   * Posts a chat message. Kick is a Laravel app, so the request needs the CSRF
   * token it issued alongside the session; without it the API answers 419
   * regardless of who is signed in.
   */
  async sendMessage(
    chatroomId: string,
    content: string,
    replyTarget?: KickChatReplyTarget,
  ): Promise<void> {
    const credentials = await this.readWriteCredentials();
    if (credentials === null) throw new Error("Not signed in to Kick.");

    const response = await this.kickSession().fetch(
      `${KICK_ORIGIN}/api/v2/messages/send/${encodeURIComponent(chatroomId)}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": this.userAgent(),
          Referer: `${KICK_ORIGIN}/`,
          "X-XSRF-TOKEN": credentials.xsrf,
          Authorization: `Bearer ${credentials.bearer}`,
        },
        body: JSON.stringify(
          replyTarget
            ? {
                content,
                type: "reply",
                metadata: {
                  original_message: {
                    id: replyTarget.id,
                    content: replyTarget.content,
                  },
                  original_sender: {
                    id: replyTarget.senderId,
                    username: replyTarget.senderUsername,
                  },
                },
                message_ref: String(Date.now()),
                ...(replyTarget.threadParentId
                  ? { thread_parent_id: replyTarget.threadParentId }
                  : {}),
              }
            : {
                content,
                type: "message",
                message_ref: String(Date.now()),
              },
        ),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error("Sign in to Kick to send messages.");
    }
    if (response.status === 419) {
      throw new Error("Kick rejected the session. Sign in again.");
    }
    if (!response.ok) {
      let detail = "";
      try {
        const payload = record(await response.json());
        const data = record(payload?.data);
        const status = record(data?.status);
        detail =
          textValue(payload?.message) ??
          textValue(payload?.error) ??
          textValue(data?.message) ??
          textValue(status?.message) ??
          "";
      } catch {
        // A body is optional on Kick's rate-limit responses.
      }
      if (response.status === 429) {
        throw new Error(detail || "You are sending messages too quickly.");
      }
      throw new Error(detail.slice(0, 200) || "Kick would not accept the message.");
    }
  }

  /**
   * Follows or unfollows a channel. Kick, unlike Twitch, exposes this, so it can
   * be done in the app. Needs the session and the same CSRF token as sending.
   */
  async setFollowing(slug: string, follow: boolean): Promise<void> {
    const bearer = await this.readSessionToken();
    if (bearer === null) throw new Error("Not signed in to Kick.");

    // The follow route is guarded by Kasada, whose x-kpsdk-* tokens are produced
    // by obfuscated page scripts and cannot be reproduced from here. Running the
    // request inside a Kick page lets Kasada's patched fetch attach them, the
    // same way the site's own follow button does.
    const status = await this.pageFetch(
      `/api/v2/channels/${encodeURIComponent(slug)}/follow`,
      follow ? "POST" : "DELETE",
      bearer,
    );

    this.log(`follow ${slug}: ${follow ? "POST" : "DELETE"} returned ${status}`);
    this.detailCache.delete(slug.toLowerCase());
    if (status === 401 || status === 403) {
      throw new Error("Sign in to Kick to follow channels.");
    }
    if (status === 429) {
      throw new Error("Kick is limiting follow requests right now. Try again later.");
    }
    // 409 means already in the requested state, which is success here.
    if (!(status >= 200 && status < 300) && status !== 409) {
      throw new Error("Kick would not change the follow state.");
    }
  }

  /**
   * Runs a write request from inside a hidden Kick page. Endpoints behind
   * Kasada need the x-kpsdk-* headers its script attaches to every fetch on the
   * page, which cannot be generated outside one.
   */
  private async pageFetch(
    path: string,
    method: string,
    bearer: string,
    body?: UnknownRecord,
  ): Promise<number> {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: KICK_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        images: false,
      },
    });
    window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    try {
      await Promise.race([
        window.loadURL(`${KICK_ORIGIN}/`),
        new Promise((resolve) => setTimeout(resolve, CHALLENGE_TIMEOUT_MS)),
      ]);
      // Let Kasada's script initialize and patch fetch before the call.
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      // JSON.stringify escapes the interpolated values so they cannot break out
      // of the script. Cookies are carried by the page; only the bearer, which
      // is HttpOnly and unavailable to page scripts, has to be supplied.
      const script = `(async () => {
        try {
          const response = await fetch(${JSON.stringify(path)}, {
            method: ${JSON.stringify(method)},
            headers: {
              "Accept": "application/json",
              "Content-Type": "application/json",
              "Authorization": "Bearer " + ${JSON.stringify(bearer)},
              "X-App-Platform": "web",
            },
            ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`}
          });
          return response.status;
        } catch (error) {
          return -1;
        }
      })()`;
      const status: unknown = await window.webContents.executeJavaScript(script, true);
      return typeof status === "number" ? status : -1;
    } catch {
      return -1;
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  private async readSessionToken(): Promise<string | null> {
    try {
      const [cookie] = await this.kickSession().cookies.get({
        url: KICK_ORIGIN,
        name: "session_token",
      });
      // Stored URL-encoded; the Bearer header wants the raw "id|secret".
      return cookie ? decodeURIComponent(cookie.value) : null;
    } catch {
      return null;
    }
  }

  private async readXsrfToken(): Promise<string | null> {
    try {
      const [cookie] = await this.kickSession().cookies.get({
        url: KICK_ORIGIN,
        name: "XSRF-TOKEN",
      });
      // Laravel stores it percent-encoded; the header wants the raw value.
      return cookie ? decodeURIComponent(cookie.value) : null;
    } catch {
      return null;
    }
  }

  /**
   * Recent chat, newest first, from the channel's message route. Keyed by the
   * channel id, not the chatroom id the socket subscribes to. Kick's own
   * history, so it needs no third-party service the way Twitch's does.
   */
  async getChatHistory(channelId: string): Promise<KickChatHistoryEntry[]> {
    const payload = await this.requestJson(
      `/api/v2/channels/${encodeURIComponent(channelId)}/messages`,
    );
    if (payload === null) return [];
    const parsed = kickChatHistorySchema.safeParse(payload);
    if (!parsed.success) return [];
    return parsed.data.data?.messages ?? [];
  }

  private async readWriteCredentials(): Promise<KickWriteCredentials | null> {
    const [bearer, xsrf] = await Promise.all([
      this.readSessionToken(),
      this.readXsrfToken(),
    ]);
    return bearer === null || xsrf === null ? null : { bearer, xsrf };
  }

  /**
   * A completed id.kick.com login can briefly exist before kick.com has
   * initialized its own bearer and CSRF cookies. Visiting the site in the same
   * isolated partition finishes that hand-off without exposing either token to
   * the renderer. This is only attempted for an account the user endpoint
   * already recognizes, so an anonymous send does not open a hidden login.
   */
  private async repairWriteCredentials(): Promise<KickWriteCredentials | null> {
    const existing = await this.readWriteCredentials();
    if (existing !== null) return existing;
    this.writeCredentialRepairRequest ??= this.refreshWriteCredentials().finally(() => {
      this.writeCredentialRepairRequest = null;
    });
    return this.writeCredentialRepairRequest;
  }

  private async refreshWriteCredentials(): Promise<KickWriteCredentials | null> {
    if ((await this.requestUser()) === null) return null;

    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: KICK_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        images: false,
      },
    });
    this.writeCredentialRepairWindow = window;
    window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    try {
      await Promise.race([
        window.loadURL(`${KICK_ORIGIN}/`),
        new Promise((resolve) => setTimeout(resolve, CHALLENGE_TIMEOUT_MS)),
      ]);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const credentials = await this.readWriteCredentials();
        if (credentials !== null) return credentials;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return null;
    } catch {
      return null;
    } finally {
      if (!window.isDestroyed()) window.destroy();
      if (this.writeCredentialRepairWindow === window) {
        this.writeCredentialRepairWindow = null;
      }
    }
  }

  /**
   * Kick includes the current pin beside its recent-message response. This is
   * an undocumented website surface, so malformed or changed payloads degrade
   * to no banner instead of breaking chat.
   */
  async getPinnedChatMessage(channelId: string): Promise<TwitchPinnedChatMessage | null> {
    const payload = await this.requestJson(
      `/api/v2/channels/${encodeURIComponent(channelId)}/messages`,
    );
    if (payload === null) return null;
    const parsed = kickChatHistorySchema.safeParse(payload);
    if (!parsed.success) return null;
    const pin = parsed.data.data?.pinned_message;
    const message = pin?.message;
    if (!pin || !message) return null;
    if (pin.finish_at && Date.parse(pin.finish_at) <= Date.now()) return null;

    const fragments: TwitchPinnedChatMessage["fragments"] = [];
    const emotePattern = /\[emote:(\d+):([^\]]+)\]/g;
    let cursor = 0;
    for (const match of message.content.matchAll(emotePattern)) {
      if (match.index > cursor) {
        fragments.push({
          type: "text",
          text: message.content.slice(cursor, match.index),
        });
      }
      fragments.push({
        type: "emote",
        text: match[2],
        emote: {
          id: match[1],
          formats: ["static"],
          imageUrl: `https://files.kick.com/emotes/${match[1]}/fullsize`,
        },
      });
      cursor = match.index + match[0].length;
    }
    if (cursor < message.content.length) {
      fragments.push({ type: "text", text: message.content.slice(cursor) });
    }

    const senderName =
      message.sender?.username ?? message.sender?.slug ?? "Kick user";
    return {
      id: String(message.id),
      senderId:
        message.sender?.id === null || message.sender?.id === undefined
          ? ""
          : String(message.sender.id),
      senderLogin: message.sender?.slug ?? senderName.toLowerCase(),
      senderName,
      pinnedByName:
        pin.pinned_by?.username ?? pin.pinned_by?.slug ?? undefined,
      text: message.content.replace(emotePattern, (_match, _id, name: string) => name),
      fragments,
      startsAt: message.created_at ?? new Date().toISOString(),
      endsAt: pin.finish_at ?? undefined,
    };
  }

  /** The channel's emote sets, plus Kick's global and emoji sets. */
  async getEmoteSets(slug: string): Promise<KickEmoteSet[]> {
    const payload = await this.requestJson(`/emotes/${encodeURIComponent(slug)}`);
    if (payload === null) return [];

    const parsed = kickEmoteSetsSchema.safeParse(payload);
    if (!parsed.success) return [];

    const sets: KickEmoteSet[] = [];
    for (const group of parsed.data) {
      const emotes = (group.emotes ?? [])
        .filter((emote) => emote.id !== undefined && emote.name)
        .map((emote) => ({
          id: String(emote.id),
          name: emote.name as string,
          imageUrl: `https://files.kick.com/emotes/${emote.id}/fullsize`,
          subscribersOnly: Boolean(emote.subscribers_only),
        }));
      if (emotes.length === 0) continue;
      sets.push({
        id: group.id === undefined ? (group.name ?? "set") : String(group.id),
        // The channel's own set is named after the channel; keep that, and let
        // the picker show it as the channel group.
        name: group.name ?? "Kick",
        emotes,
      });
    }
    return sets;
  }

  /**
   * Opens Kick's own sign-in page in a window of its own. Nothing is typed
   * into VioletWire: the user signs in on Kick, in the same partition the API
   * calls already use, so no credential is ever handled here.
   */
  async signIn(): Promise<KickUser | null> {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus();
      return null;
    }

    const window = new BrowserWindow({
      width: 520,
      height: 760,
      title: "Sign in to Kick",
      autoHideMenuBar: true,
      webPreferences: {
        partition: KICK_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.loginWindow = window;
    window.setMenu(null);

    // Kick's dedicated login page rather than the full site. The explicit
    // redirect is required by its current social-login flow (notably Google)
    // so the callback returns through kick.com and initializes that session.
    await window.loadURL(getKickLoginUrl());

    return new Promise<KickUser | null>((resolve) => {
      let settled = false;
      const finish = (user: KickUser | null) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        if (!window.isDestroyed()) window.destroy();
        this.loginWindow = null;
        resolve(user);
      };

      // Account identity is the completion signal. XSRF is write-only state
      // and may arrive slightly later after Google login, so repair it without
      // trapping the user in the auth window or reporting them as signed out.
      const poll = setInterval(() => {
        void this.getUser().then((user) => {
          if (user === null) return;
          void this.repairWriteCredentials().catch(() => undefined);
          finish(user);
        });
      }, 1_500);
      poll.unref();

      window.on("closed", () => {
        // Closing the window without signing in is a cancellation, not an error.
        void this.getUser().then((user) => finish(user));
      });
    });
  }

  /** Clears every Kick login surface; anonymous playback state is re-fetched. */
  async signOut(): Promise<void> {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.destroy();
    if (this.writeCredentialRepairWindow && !this.writeCredentialRepairWindow.isDestroyed()) {
      this.writeCredentialRepairWindow.destroy();
    }
    this.loginWindow = null;
    this.writeCredentialRepairWindow = null;
    this.writeCredentialRepairRequest = null;
    this.sessionCookie = null;
    this.sessionFetchedAt = 0;
    this.sessionRequest = null;
    this.challengeFailedAt = 0;
    const kickSession = this.kickSession();
    try {
      // The dedicated partition contains both kick.com and id.kick.com. An
      // origin-scoped clear left the identity-provider cookies behind, so the
      // next launch silently recreated the website login. Nothing except Kick
      // is stored here, making a full partition clear both safe and complete.
      await kickSession.clearStorageData();
      await kickSession.clearCache();
      await kickSession.flushStorageData();
    } catch {
      // Nothing stored.
    }
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
    const userId = channel.user?.id ?? channel.user_id;
    return {
      id: channel.id === undefined ? slug : String(channel.id),
      userId: userId === null || userId === undefined ? undefined : String(userId),
      slug,
      displayName: channel.user?.username ?? slug,
      profileImageUrl: channel.user?.profile_pic ?? "",
      chatroomId: channel.chatroom?.id === undefined ? undefined : String(channel.chatroom.id),
      following: channel.following ?? undefined,
      subscriberBadges: (channel.subscriber_badges ?? [])
        .filter((badge): badge is { id: number; months: number } =>
          typeof badge.id === "number" && typeof badge.months === "number",
        )
        .map((badge) => ({
          months: badge.months,
          imageUrl: `https://files.kick.com/channel_subscriber_badges/${badge.id}/original`,
        }))
        // Highest month tier first, so matching a sub's months takes the best.
        .sort((left, right) => right.months - left.months),
      restrictions: {
        followersOnly: Boolean(channel.chatroom?.followers_mode),
        followersMinMinutes: channel.chatroom?.following_min_duration ?? undefined,
        subscribersOnly: Boolean(channel.chatroom?.subscribers_mode),
        slowModeSeconds: channel.chatroom?.slow_mode
          ? (channel.chatroom.message_interval ?? undefined)
          : undefined,
        emoteOnly: Boolean(channel.chatroom?.emotes_mode),
      },
      // A null livestream is how Kick reports an offline channel.
      isLive: Boolean(livestream?.is_live),
      title: livestream?.session_title ?? undefined,
      category: livestream?.is_live
        ? (livestream.categories?.[0]?.name ?? undefined)
        : "Offline",
      viewerCount: livestream?.viewer_count ?? 0,
      startedAt: toIsoTimestamp(livestream?.start_time ?? livestream?.created_at),
      // Deliberately omitted: this endpoint's thumbnail host answers 403.
      // getLivestream carries the one that loads.
      thumbnailUrl: undefined,
    };
  }

  /**
   * Retries once with a fresh cookie: a 403 usually means the session rotated
   * rather than that the request was wrong.
   */
  private async requestJson(path: string, retryOnForbidden = true): Promise<unknown> {
    // No Cookie header: the session carries its own jar, and setting one here
    // would override it with the cached anonymous value, which is stale the
    // moment somebody signs in.
    const bearer = await this.readSessionToken();
    try {
      // Node's fetch is refused here. Kick sits behind a check that a plain
      // request cannot pass regardless of the headers or cookie it carries,
      // which is why Streamlink drives a browser for it. Electron's net module
      // issues the request through Chromium instead, on the same partition that
      // solved the challenge, so it carries that context.
      const response = await this.kickSession().fetch(`${KICK_ORIGIN}${path}`, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": this.userAgent(),
          Referer: `${KICK_ORIGIN}/`,
          // Kick authenticates its API with this bearer, not the session
          // cookie, so signed-in fields depend on it being sent.
          ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if ((response.status === 403 || response.status === 401) && retryOnForbidden) {
        this.log(`${path} was refused; re-solving the challenge and retrying once`);
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
