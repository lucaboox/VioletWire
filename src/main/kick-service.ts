import { BrowserWindow, session, type Session } from "electron";
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

// Kick sends far more than this; only the fields the app renders are declared,
// and everything is optional so a shape change degrades a single card rather
// than failing the whole response.
const kickLivestreamSchema = z.object({
  id: z.number().optional(),
  is_live: z.boolean().optional(),
  viewer_count: z.number().optional(),
  session_title: z.string().optional(),
  created_at: z.string().optional(),
  start_time: z.string().optional(),
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

// Search entries are a different, thinner shape than the channel endpoint's:
// live state is `isLive` rather than a nested livestream, and there is no
// chatroom, title, or viewer count.
const kickSearchSchema = z.object({
  channels: z
    .array(
      z.object({
        id: z.number().optional(),
        slug: z.string().optional(),
        isLive: z.boolean().optional(),
        user: z
          .object({
            username: z.string().optional(),
            profilePic: z.string().nullable().optional(),
            profile_pic: z.string().nullable().optional(),
          })
          .optional(),
        recentCategories: z
          .array(z.object({ name: z.string().optional() }))
          .optional(),
      }),
    )
    .optional(),
});

// Signed out, /api/v1/user answers with an empty array rather than an error,
// so identity is decided by whether a username came back.
const kickUserSchema = z.object({
  id: z.number().optional(),
  username: z.string().optional(),
  profile_pic: z.string().nullable().optional(),
});

// The followed list is its own shape again: live state sits on the entry
// rather than in a nested livestream.
const kickFollowedSchema = z.object({
  channels: z
    .array(
      z.object({
        id: z.number().optional(),
        slug: z.string().optional(),
        user_username: z.string().optional(),
        username: z.string().optional(),
        profile_pic: z.string().nullable().optional(),
        profilePic: z.string().nullable().optional(),
        is_live: z.boolean().optional(),
        isLive: z.boolean().optional(),
        viewer_count: z.number().optional(),
        viewers: z.number().optional(),
        session_title: z.string().optional(),
        category_name: z.string().optional(),
        category: z.union([z.string(), z.object({ name: z.string().optional() })]).optional(),
        start_time: z.string().optional(),
      }),
    )
    .optional(),
  next_cursor: z.union([z.string(), z.number()]).nullable().optional(),
});

// Emote sets: the channel's own, then Global and Emoji.
const kickEmoteSetsSchema = z.array(
  z.object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    emotes: z
      .array(
        z.object({
          id: z.number().optional(),
          name: z.string().optional(),
          subscribers_only: z.boolean().optional(),
        }),
      )
      .optional(),
  }),
);

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
  private challengeFailedAt = 0;
  private loginWindow: BrowserWindow | null = null;

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
        category: entry.recentCategories?.[0]?.name,
        viewerCount: 0,
      });
    }
    return results;
  }

  /** The signed-in Kick account, or null when signed out. */
  async getUser(): Promise<KickUser | null> {
    const payload = await this.requestJson("/api/v1/user");
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

      const parsed = kickFollowedSchema.safeParse(payload);
      if (!parsed.success) break;

      for (const entry of parsed.data.channels ?? []) {
        const slug = entry.slug;
        if (!slug) continue;
        const category =
          typeof entry.category === "string" ? entry.category : entry.category?.name;
        channels.push({
          id: entry.id === undefined ? slug : String(entry.id),
          slug,
          displayName: entry.user_username ?? entry.username ?? slug,
          profileImageUrl: entry.profilePic ?? entry.profile_pic ?? "",
          isLive: Boolean(entry.is_live ?? entry.isLive),
          title: entry.session_title,
          category: entry.category_name ?? category,
          viewerCount: entry.viewer_count ?? entry.viewers ?? 0,
          startedAt: entry.start_time,
        });
      }

      const next = parsed.data.next_cursor;
      if (next === null || next === undefined || next === "" || next === 0) break;
      cursor = String(next);
    }
    return channels;
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

    await window.loadURL(`${KICK_ORIGIN}/`);

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

      // Kick's sign-in has no redirect to intercept, so completion is detected
      // by the account endpoint starting to answer.
      const poll = setInterval(() => {
        void this.getUser().then((user) => {
          if (user !== null) finish(user);
        });
      }, 1_500);
      poll.unref();

      window.on("closed", () => {
        // Closing the window without signing in is a cancellation, not an error.
        void this.getUser().then((user) => finish(user));
      });
    });
  }

  /** Clears the Kick session, leaving the anonymous cookie to be re-fetched. */
  async signOut(): Promise<void> {
    this.sessionCookie = null;
    this.sessionFetchedAt = 0;
    try {
      await this.kickSession().clearStorageData({
        origin: KICK_ORIGIN,
        storages: ["cookies", "localstorage", "indexdb"],
      });
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
      startedAt: livestream?.start_time ?? livestream?.created_at,
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
          ...(cookie === null ? {} : { Cookie: `${SESSION_COOKIE}=${cookie}` }),
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
