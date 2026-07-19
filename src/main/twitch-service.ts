import { app, safeStorage, shell } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  twitchClientIdSchema,
  twitchStreamSchema,
  twitchUserSchema,
  type BrowseCategory,
  type BrowsePage,
  type BrowseStream,
  type ChatUserProfile,
  type ClipCreationResult,
  type FollowedChannel,
  type SearchChannelResult,
  type StreamMetadata,
  type TwitchAccount,
  type TwitchAuthState,
  type TwitchDeviceAuthorization,
  type TwitchSearchResults,
} from "../shared/twitch";
import type { TwitchChatAssets } from "../shared/chat";

// Twitch documents Client IDs as public identifiers that may be embedded in
// client applications. VioletWire's public Device Code client never uses a secret.
const bundledTwitchClientId = "muthgxeegar3t0hj2qwm0ozocqbt8o";

const scopes = [
  "user:read:follows",
  "user:read:subscriptions",
  "clips:edit",
  "user:read:chat",
  "user:write:chat",
  "user:read:emotes",
] as const;

const tokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  scopes: z.array(z.string()),
  expiresAt: z.number(),
});

const deviceResponseSchema = z.object({
  device_code: z.string(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
  user_code: z.string(),
  verification_uri: z.string().url(),
});

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  scope: z.array(z.string()).default([]),
});

const validateResponseSchema = z.object({
  client_id: z.string(),
  login: z.string(),
  user_id: z.string(),
  scopes: z.array(z.string()),
  expires_in: z.number(),
});

const followedResponseSchema = z.object({
  data: z.array(
    z.object({
      broadcaster_id: z.string(),
      broadcaster_login: z.string(),
      broadcaster_name: z.string(),
      followed_at: z.string(),
    }),
  ),
  pagination: z.object({ cursor: z.string().optional() }).default({}),
});

const streamsResponseSchema = z.object({
  data: z.array(twitchStreamSchema),
  pagination: z.object({ cursor: z.string().optional() }).default({}),
});

const categoriesResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      box_art_url: z.string(),
    }),
  ),
  pagination: z.object({ cursor: z.string().optional() }).default({}),
});

const searchChannelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      broadcaster_login: z.string(),
      display_name: z.string(),
      thumbnail_url: z.string(),
      title: z.string(),
      game_name: z.string(),
      is_live: z.boolean(),
    }),
  ),
  pagination: z.object({ cursor: z.string().optional() }).default({}),
});

const usersResponseSchema = z.object({ data: z.array(twitchUserSchema) });
const subscriptionResponseSchema = z.object({
  data: z.array(
    z.object({
      tier: z.string(),
      is_gift: z.boolean(),
    }),
  ),
});
const ivrSubageResponseSchema = z.object({
  statusHidden: z.boolean().optional().default(false),
  meta: z.object({ tier: z.string().optional() }).nullable().optional(),
  cumulative: z.object({ months: z.number().int().nonnegative().optional().default(0) }).optional(),
  followedAt: z.string().nullable().optional(),
});
const clipResponseSchema = z.object({
  data: z.array(z.object({ id: z.string(), edit_url: z.string().url() })).min(1),
});
const sendChatResponseSchema = z.object({
  data: z.array(
    z.object({
      message_id: z.string().optional(),
      is_sent: z.boolean(),
      drop_reason: z
        .object({ code: z.string(), message: z.string() })
        .nullable()
        .optional(),
    }),
  ),
});

// Cached chat assets are shared between callers; hand out copies so a caller
// mutating its result cannot corrupt what later callers receive.
function cloneChatAssets(assets: TwitchChatAssets): TwitchChatAssets {
  return {
    broadcasterId: assets.broadcasterId,
    badges: assets.badges.map((badge) => ({
      ...badge,
      imageUrls: badge.imageUrls ? [...badge.imageUrls] : undefined,
    })),
    emotes: assets.emotes.map((emote) => ({ ...emote })),
  };
}

function resizeTwitchBoxArt(url: string, width = 570, height = 760): string {
  return url
    .replace("{width}", String(width))
    .replace("{height}", String(height))
    .replace(/-\d+x\d+(\.[a-z]+)$/i, `-${width}x${height}$1`);
}
const badgeResponseSchema = z.object({
  data: z.array(
    z.object({
      set_id: z.string(),
      versions: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          image_url_1x: z.string().url().optional(),
          image_url_2x: z.string().url(),
          image_url_4x: z.string().url().optional(),
        }),
      ),
    }),
  ),
});
const emoteResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      images: z.object({ url_2x: z.string().url() }),
      emote_type: z.string().optional(),
      tier: z.string().optional(),
    }),
  ),
});
const userEmoteResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      owner_id: z.string(),
      format: z.array(z.string()).default(["static"]),
      scale: z.array(z.string()).default(["1.0"]),
      theme_mode: z.array(z.string()).default(["dark"]),
      emote_type: z.string(),
      tier: z.string().optional(),
    }),
  ),
  template: z.string().url(),
  pagination: z.object({ cursor: z.string().optional() }).default({}),
});

type StoredToken = z.infer<typeof tokenSchema>;

interface PendingDeviceAuthorization extends TwitchDeviceAuthorization {
  deviceCode: string;
  expiresAt: number;
}

class TwitchRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Twitch requires hourly token validation; revalidating slightly earlier keeps
// the app inside that window without a network round trip per Helix request.
export const VALIDATION_LIFETIME = 55 * 60_000;
const CHAT_ASSETS_LIFETIME = 10 * 60_000;
const SESSION_CHANGED_MESSAGE =
  "The Twitch session changed; the stale result was discarded.";

// Only a confirmed-invalid session may erase saved credentials; transient
// network or server failures must leave them untouched.
function isAuthInvalidError(error: unknown): boolean {
  if (error instanceof TwitchRequestError) {
    return error.status === 400 || error.status === 401 || error.status === 403;
  }
  return (
    error instanceof Error &&
    error.message === "The saved Twitch session belongs to another application."
  );
}

export class TwitchService {
  private pendingDevice: PendingDeviceAuthorization | null = null;
  private signInController: AbortController | null = null;
  private token: StoredToken | null = null;
  private account: TwitchAccount | null = null;
  private validatedAt = 0;
  private authCheck: Promise<void> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  // Bumped on sign-out and on installing a newly authorized token, so
  // in-flight validation/refresh work from a previous session is discarded
  // instead of restoring stale credentials.
  private sessionGeneration = 0;
  private validationTimer: NodeJS.Timeout | null = null;
  private readonly chatAssetsCache = new Map<
    string,
    { expiresAt: number; result: Promise<TwitchChatAssets> }
  >();

  private get tokenPath(): string {
    return path.join(app.getPath("userData"), "twitch-auth.bin");
  }

  async initialize(): Promise<void> {
    // Remove VioletWire's retired user-configurable Client ID file. Client IDs are
    // public application identifiers and VioletWire now ships its registered one.
    await fs.rm(path.join(app.getPath("userData"), "twitch-config.json"), { force: true });
    this.token = await this.readToken();
    if (!this.token) return;
    try {
      await this.ensureAuthenticated();
    } catch (error) {
      if (isAuthInvalidError(error)) await this.clearToken();
    }
  }

  async getAuthState(): Promise<TwitchAuthState> {
    if (!this.token) return { status: "signed-out", account: null };
    try {
      await this.ensureAuthenticated();
      return this.account
        ? { status: "signed-in", account: this.account }
        : { status: "signed-out", account: null };
    } catch (error) {
      if (isAuthInvalidError(error)) {
        await this.clearToken();
        return { status: "signed-out", account: null };
      }
      // Transient failure: keep the saved session and report the best-known
      // state instead of signing the user out.
      return this.account
        ? { status: "signed-in", account: this.account }
        : { status: "signed-out", account: null };
    }
  }

  async beginSignIn(): Promise<TwitchDeviceAuthorization> {
    const clientId = await this.requireClientId();
    this.cancelSignIn();
    const body = new URLSearchParams({ client_id: clientId, scopes: scopes.join(" ") });
    const response = await fetch("https://id.twitch.tv/oauth2/device", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await this.readJson(response);
    if (!response.ok) throw new TwitchRequestError(this.errorMessage(payload, "Unable to start Twitch sign-in."), response.status);
    const device = deviceResponseSchema.parse(payload);
    this.pendingDevice = {
      deviceCode: device.device_code,
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      expiresIn: device.expires_in,
      interval: device.interval,
      expiresAt: Date.now() + device.expires_in * 1000,
    };
    this.signInController = new AbortController();
    await shell.openExternal(device.verification_uri);
    return {
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      expiresIn: device.expires_in,
      interval: device.interval,
    };
  }

  async completeSignIn(): Promise<TwitchAuthState> {
    const pending = this.pendingDevice;
    const controller = this.signInController;
    if (!pending || !controller) throw new Error("Start Twitch sign-in first.");
    const clientId = await this.requireClientId();

    try {
      while (Date.now() < pending.expiresAt) {
        await this.delay(pending.interval * 1000, controller.signal);
        const body = new URLSearchParams({
          client_id: clientId,
          scopes: scopes.join(" "),
          device_code: pending.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
        const response = await fetch("https://id.twitch.tv/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal: controller.signal,
        });
        const payload = await this.readJson(response);
        if (!response.ok) {
          if (this.errorMessage(payload, "").toLowerCase().includes("authorization_pending")) continue;
          throw new TwitchRequestError(this.errorMessage(payload, "Twitch sign-in failed."), response.status);
        }
        const received = tokenResponseSchema.parse(payload);
        // A newly authorized token starts a fresh session; anything still in
        // flight for the previous one must not overwrite it.
        this.sessionGeneration += 1;
        this.stopValidationTimer();
        this.token = {
          accessToken: received.access_token,
          refreshToken: received.refresh_token,
          scopes: received.scope,
          expiresAt: Date.now() + received.expires_in * 1000,
        };
        this.validatedAt = 0;
        // A replacement authorization can add scopes such as
        // user:read:emotes. Do not serve chat assets produced under the old
        // authorization after the new token is installed.
        this.chatAssetsCache.clear();
        await this.writeToken(this.token);
        this.account = await this.fetchAccount();
        this.scheduleValidation();
        return { status: "signed-in", account: this.account };
      }
      throw new Error("The Twitch sign-in code expired. Please try again.");
    } finally {
      this.pendingDevice = null;
      this.signInController = null;
    }
  }

  cancelSignIn(): void {
    this.signInController?.abort();
    this.signInController = null;
    this.pendingDevice = null;
  }

  async signOut(): Promise<TwitchAuthState> {
    this.cancelSignIn();
    await this.clearToken();
    return (await this.getClientId())
      ? { status: "signed-out", account: null }
      : {
          status: "unconfigured",
          account: null,
          message: "Add your Twitch application Client ID in Settings before signing in.",
        };
  }

  async getFollowedChannels(): Promise<FollowedChannel[]> {
    const account = await this.requireAccount();
    const followed = await this.helixAll(
      `/channels/followed?user_id=${encodeURIComponent(account.id)}&first=100`,
      followedResponseSchema,
    );
    const live = await this.helixAll(
      `/streams/followed?user_id=${encodeURIComponent(account.id)}&first=100`,
      streamsResponseSchema,
    );
    const liveById = new Map(live.map((stream) => [stream.user_id, stream]));
    const profiles = await this.getUsersByIds(followed.map((item) => item.broadcaster_id));
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

    return followed
      .map((item) => {
        const stream = liveById.get(item.broadcaster_id);
        const profile = profileById.get(item.broadcaster_id);
        return {
          id: item.broadcaster_id,
          login: item.broadcaster_login,
          displayName: item.broadcaster_name,
          category: stream?.game_name ?? "Offline",
          title: stream?.title,
          language: stream?.language,
          tags: stream?.tags,
          isMature: stream?.is_mature,
          profileImageUrl: profile?.profile_image_url ?? "",
          thumbnailUrl: stream?.thumbnail_url.replace("{width}", "640").replace("{height}", "360"),
          viewerCount: stream?.viewer_count ?? 0,
          startedAt: stream?.started_at,
          isLive: Boolean(stream),
        };
      })
      .sort((left, right) => Number(right.isLive) - Number(left.isLive) || right.viewerCount - left.viewerCount);
  }

  async getBrowseCategories(
    query = "",
    after?: string,
  ): Promise<BrowsePage<BrowseCategory>> {
    const trimmedQuery = query.trim();
    const parameters = new URLSearchParams({ first: "30" });
    if (after) parameters.set("after", after);
    if (trimmedQuery) parameters.set("query", trimmedQuery);
    const endpoint = trimmedQuery ? "/search/categories" : "/games/top";
    const response = await this.helix(
      `${endpoint}?${parameters.toString()}`,
      categoriesResponseSchema,
    );
    return {
      items: response.data.map((category) => ({
        id: category.id,
        name: category.name,
        boxArtUrl: resizeTwitchBoxArt(category.box_art_url),
      })),
      cursor: response.pagination.cursor,
    };
  }

  async getCategoryStreams(
    gameId: string,
    after?: string,
  ): Promise<BrowsePage<BrowseStream>> {
    const parameters = new URLSearchParams({ game_id: gameId, first: "30" });
    if (after) parameters.set("after", after);
    const response = await this.helix(
      `/streams?${parameters.toString()}`,
      streamsResponseSchema,
    );
    const profiles = await this.getUsersByIds(response.data.map((stream) => stream.user_id));
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    return {
      items: response.data.map((stream) => ({
        id: stream.id,
        broadcasterId: stream.user_id,
        login: stream.user_login,
        displayName: stream.user_name,
        title: stream.title,
        category: stream.game_name,
        language: stream.language,
        tags: stream.tags,
        isMature: stream.is_mature,
        profileImageUrl: profileById.get(stream.user_id)?.profile_image_url ?? "",
        thumbnailUrl: stream.thumbnail_url
          .replace("{width}", "640")
          .replace("{height}", "360"),
        viewerCount: stream.viewer_count,
        startedAt: stream.started_at,
      })),
      cursor: response.pagination.cursor,
    };
  }

  async search(query: string): Promise<TwitchSearchResults> {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 2) return { channels: [], categories: [] };
    const encodedQuery = encodeURIComponent(trimmedQuery);
    const [channelResponse, categoryResponse] = await Promise.all([
      this.helix(
        `/search/channels?query=${encodedQuery}&first=6&live_only=false`,
        searchChannelsResponseSchema,
      ),
      this.helix(
        `/search/categories?query=${encodedQuery}&first=4`,
        categoriesResponseSchema,
      ),
    ]);
    const channels: SearchChannelResult[] = channelResponse.data.map((channel) => ({
      id: channel.id,
      login: channel.broadcaster_login,
      displayName: channel.display_name,
      profileImageUrl: channel.thumbnail_url,
      title: channel.title,
      category: channel.is_live ? channel.game_name : "",
      isLive: channel.is_live,
    }));
    return {
      channels,
      categories: categoryResponse.data.map((category) => ({
        id: category.id,
        name: category.name,
        boxArtUrl: resizeTwitchBoxArt(category.box_art_url),
      })),
    };
  }

  async getStreamMetadata(channel: string): Promise<StreamMetadata | null> {
    await this.ensureAuthenticated();
    const users = await this.helix(`/users?login=${encodeURIComponent(channel)}`, usersResponseSchema);
    const broadcaster = users.data[0];
    if (!broadcaster) return null;
    const streams = await this.helix(
      `/streams?user_id=${encodeURIComponent(broadcaster.id)}`,
      streamsResponseSchema,
    );
    const stream = streams.data[0];
    const metadata: StreamMetadata = {
      broadcasterId: broadcaster.id,
      login: broadcaster.login,
      displayName: broadcaster.display_name,
      profileImageUrl: broadcaster.profile_image_url,
      description: broadcaster.description,
      isLive: Boolean(stream),
      title: stream?.title,
      categoryId: stream?.game_id,
      category: stream?.game_name,
      viewerCount: stream?.viewer_count,
      startedAt: stream?.started_at,
      language: stream?.language,
      tags: stream?.tags,
      isMature: stream?.is_mature,
    };

    if (this.account) {
      const follow = await this.helix(
        `/channels/followed?user_id=${encodeURIComponent(this.account.id)}&broadcaster_id=${encodeURIComponent(broadcaster.id)}`,
        followedResponseSchema,
      );
      metadata.isFollowed = follow.data.length > 0;
      try {
        const subscription = await this.helix(
          `/subscriptions/user?broadcaster_id=${encodeURIComponent(broadcaster.id)}&user_id=${encodeURIComponent(this.account.id)}`,
          subscriptionResponseSchema,
        );
        const details = subscription.data[0];
        metadata.subscription = details
          ? { isSubscribed: true, tier: details.tier, isGift: details.is_gift }
          : { isSubscribed: false };
      } catch (error) {
        if (error instanceof TwitchRequestError && error.status === 404) {
          metadata.subscription = { isSubscribed: false };
        } else {
          throw error;
        }
      }
    }
    return metadata;
  }

  async getChatUserProfile(channel: string, login: string): Promise<ChatUserProfile> {
    // Chatterino uses IVR's public subage endpoint for public user-card
    // relationship data. Twitch Helix deliberately limits those fields to the
    // authenticated user, so keep IVR's best-effort response clearly separate.
    const subageRequest = this.getIvrSubage(login, channel);
    await this.ensureAuthenticated();
    const [channelUsers, targetUsers, subage] = await Promise.all([
      this.helix(`/users?login=${encodeURIComponent(channel)}`, usersResponseSchema),
      this.helix(`/users?login=${encodeURIComponent(login)}`, usersResponseSchema),
      subageRequest,
    ]);
    const broadcaster = channelUsers.data[0];
    const target = targetUsers.data[0];
    if (!broadcaster || !target) throw new Error("The Twitch user could not be found.");

    const profile: ChatUserProfile = {
      id: target.id,
      login: target.login,
      displayName: target.display_name,
      profileImageUrl: target.profile_image_url,
      description: target.description,
      createdAt: target.created_at,
      ...(subage ? { subage } : {}),
    };

    // Twitch only permits a user token to query its own follow/subscription
    // relationship. Do not imply that arbitrary chatter relationships are
    // available through the public API.
    if (this.account?.id === target.id) {
      const follow = await this.helix(
        `/channels/followed?user_id=${encodeURIComponent(target.id)}&broadcaster_id=${encodeURIComponent(broadcaster.id)}`,
        followedResponseSchema,
      );
      let subscription: NonNullable<ChatUserProfile["relationship"]>["subscription"];
      try {
        const response = await this.helix(
          `/subscriptions/user?broadcaster_id=${encodeURIComponent(broadcaster.id)}&user_id=${encodeURIComponent(target.id)}`,
          subscriptionResponseSchema,
        );
        const details = response.data[0];
        subscription = details
          ? { isSubscribed: true, tier: details.tier, isGift: details.is_gift }
          : { isSubscribed: false };
      } catch (error) {
        if (error instanceof TwitchRequestError && error.status === 404) {
          subscription = { isSubscribed: false };
        } else {
          throw error;
        }
      }
      profile.relationship = {
        isFollowing: follow.data.length > 0,
        followedAt: follow.data[0]?.followed_at,
        subscription,
      };
    }
    return profile;
  }

  private async getIvrSubage(
    login: string,
    channel: string,
  ): Promise<ChatUserProfile["subage"] | undefined> {
    try {
      const response = await fetch(
        `https://api.ivr.fi/v2/twitch/subage/${encodeURIComponent(login)}/${encodeURIComponent(channel)}`,
        { headers: { Accept: "application/json" } },
      );
      if (!response.ok) return undefined;
      const payload = ivrSubageResponseSchema.parse(await this.readJson(response));
      const months = payload.cumulative?.months ?? 0;
      return {
        ...(payload.followedAt ? { followingSince: payload.followedAt } : {}),
        subscription: {
          isHidden: payload.statusHidden,
          isSubscribed: Boolean(payload.meta?.tier),
          ...(payload.meta?.tier ? { tier: payload.meta.tier } : {}),
          cumulativeMonths: months,
        },
      };
    } catch {
      // The card remains useful with Twitch's public profile data if IVR is
      // temporarily unavailable. Never surface or log a third-party failure.
      return undefined;
    }
  }

  async createClip(channel: string): Promise<ClipCreationResult> {
    await this.requireAccount();
    const metadata = await this.getStreamMetadata(channel);
    if (!metadata?.isLive) throw new Error("Clips can only be created while the channel is live.");
    const result = await this.helix(
      `/clips?broadcaster_id=${encodeURIComponent(metadata.broadcasterId)}`,
      clipResponseSchema,
      { method: "POST" },
    );
    const clip = { id: result.data[0].id, editUrl: result.data[0].edit_url };
    await shell.openExternal(clip.editUrl);
    return clip;
  }

  async sendChatMessage(
    channel: string,
    message: string,
    replyParentMessageId?: string,
  ): Promise<void> {
    const account = await this.requireAccount();
    const users = await this.helix(
      `/users?login=${encodeURIComponent(channel)}`,
      usersResponseSchema,
    );
    const broadcaster = users.data[0];
    if (!broadcaster) throw new Error("Twitch channel was not found.");
    const result = await this.helix("/chat/messages", sendChatResponseSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        broadcaster_id: broadcaster.id,
        sender_id: account.id,
        message,
        ...(replyParentMessageId
          ? { reply_parent_message_id: replyParentMessageId }
          : {}),
      }),
    });
    const delivery = result.data[0];
    if (!delivery?.is_sent) {
      throw new Error(delivery?.drop_reason?.message ?? "Twitch did not send the chat message.");
    }
  }

  async getChatAssets(channel: string): Promise<TwitchChatAssets> {
    const login = channel.trim().toLowerCase();
    const cached = this.chatAssetsCache.get(login);
    if (cached && cached.expiresAt > Date.now()) {
      return cloneChatAssets(await cached.result);
    }
    if (cached) this.chatAssetsCache.delete(login);
    const result = this.fetchChatAssets(login);
    const entry = { expiresAt: Date.now() + CHAT_ASSETS_LIFETIME, result };
    this.chatAssetsCache.set(login, entry);
    result.catch(() => {
      // Failed lookups must stay retryable instead of caching the error.
      if (this.chatAssetsCache.get(login) === entry) this.chatAssetsCache.delete(login);
    });
    return cloneChatAssets(await result);
  }

  private async fetchChatAssets(channel: string): Promise<TwitchChatAssets> {
    const users = await this.helix(
      `/users?login=${encodeURIComponent(channel)}`,
      usersResponseSchema,
    );
    const broadcaster = users.data[0];
    if (!broadcaster) throw new Error("Twitch channel was not found.");
    const [globalBadges, channelBadges, globalEmotes, channelEmotes] = await Promise.all([
      this.helix("/chat/badges/global", badgeResponseSchema),
      this.helix(
        `/chat/badges?broadcaster_id=${encodeURIComponent(broadcaster.id)}`,
        badgeResponseSchema,
      ),
      this.helix("/chat/emotes/global", emoteResponseSchema),
      this.helix(
        `/chat/emotes?broadcaster_id=${encodeURIComponent(broadcaster.id)}`,
        emoteResponseSchema,
      ),
    ]);
    const badges = new Map<string, TwitchChatAssets["badges"][number]>();
    for (const set of [...globalBadges.data, ...channelBadges.data]) {
      for (const version of set.versions) {
        const key = `${set.set_id}/${version.id}`;
        badges.set(key, {
          key,
          title: version.title,
          imageUrl: version.image_url_2x,
          imageUrls: [
            version.image_url_2x,
            version.image_url_4x,
            version.image_url_1x,
          ].filter((url, index, urls): url is string =>
            Boolean(url) && urls.indexOf(url) === index),
        });
      }
    }
    const emotes = new Map<string, TwitchChatAssets["emotes"][number]>();
    // Channel emotes come first so they remain visible before the picker applies
    // its display limit. Global emotes fill in any remaining names.
    for (const emote of channelEmotes.data) {
      if (emotes.has(emote.name)) continue;
      emotes.set(emote.name, {
        id: emote.id,
        name: emote.name,
        imageUrl: emote.images.url_2x,
        scope: "channel",
        subscriptionOnly: emote.emote_type === "subscriptions" || Boolean(emote.tier),
      });
    }
    for (const emote of globalEmotes.data) {
      if (emotes.has(emote.name)) continue;
      emotes.set(emote.name, {
        id: emote.id,
        name: emote.name,
        imageUrl: emote.images.url_2x,
        scope: "global",
        subscriptionOnly: false,
      });
    }
    if (this.token?.scopes.includes("user:read:emotes") && this.account) {
      try {
        const available = await this.getAvailableUserEmotes(
          this.account.id,
          broadcaster.id,
        );
        if (available.length > 0) {
          emotes.clear();
          for (const emote of available) emotes.set(emote.id, emote);
        }
      } catch (error) {
        // Available user emotes are an authenticated enhancement. A malformed
        // owner ID or temporary failure must not take down badges and the
        // channel/global emotes that were already loaded successfully.
        console.warn("Unable to load the complete Twitch emote library:", error);
      }
    }
    return {
      broadcasterId: broadcaster.id,
      badges: [...badges.values()],
      emotes: [...emotes.values()],
    };
  }

  private async getAvailableUserEmotes(
    userId: string,
    broadcasterId: string,
  ): Promise<TwitchChatAssets["emotes"]> {
    const data: z.infer<typeof userEmoteResponseSchema>["data"] = [];
    let template = "";
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({
        user_id: userId,
        broadcaster_id: broadcasterId,
      });
      if (cursor) query.set("after", cursor);
      const response = await this.helix(
        `/chat/emotes/user?${query.toString()}`,
        userEmoteResponseSchema,
      );
      data.push(...response.data);
      template = response.template;
      cursor = response.pagination.cursor;
    } while (cursor);

    const ownerIds = [...new Set(
      data
        .map((emote) => emote.owner_id)
        .filter((id): id is string => /^\d+$/.test(id) && id !== "0"),
    )];
    const owners = new Map(
      (await this.getUsersByIds(ownerIds)).map((owner) => [owner.id, owner]),
    );
    return data.map((emote) => {
      const owner = owners.get(emote.owner_id);
      const format = emote.format.includes("animated") ? "animated" : "static";
      const theme = emote.theme_mode.includes("dark") ? "dark" : emote.theme_mode[0] ?? "dark";
      const scale = emote.scale.includes("2.0") ? "2.0" : emote.scale.at(-1) ?? "1.0";
      return {
        id: emote.id,
        name: emote.name,
        imageUrl: template
          .replace("{{id}}", encodeURIComponent(emote.id))
          .replace("{{format}}", format)
          .replace("{{theme_mode}}", theme)
          .replace("{{scale}}", scale),
        scope: !emote.owner_id || emote.owner_id === "0" ? "global" : "channel",
        subscriptionOnly: emote.emote_type === "subscriptions" || Boolean(emote.tier),
        ownerId: emote.owner_id,
        ownerName: owner?.display_name,
        ownerImageUrl: owner?.profile_image_url,
      };
    });
  }

  async openSubscription(channel: string): Promise<void> {
    await shell.openExternal(`https://www.twitch.tv/subs/${encodeURIComponent(channel)}`);
  }

  async openChannel(channel: string): Promise<void> {
    await shell.openExternal(`https://www.twitch.tv/${encodeURIComponent(channel)}`);
  }

  private getClientId(): string {
    const environmentClientId = process.env.TWITCH_CLIENT_ID?.trim();
    if (environmentClientId && twitchClientIdSchema.safeParse(environmentClientId).success) {
      return environmentClientId;
    }
    return bundledTwitchClientId;
  }

  private requireClientId(): string {
    return this.getClientId();
  }

  private async requireAccount(): Promise<TwitchAccount> {
    await this.ensureAuthenticated();
    if (!this.account) throw new Error("Sign in with Twitch to use this feature.");
    return this.account;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.token) throw new Error("Sign in with Twitch to use this feature.");
    if (
      this.account &&
      this.validatedAt + VALIDATION_LIFETIME > Date.now() &&
      this.token.expiresAt > Date.now() + 60_000
    ) {
      return;
    }
    // Single-flight: concurrent callers share one validate/refresh round trip.
    if (!this.authCheck) {
      const pending = this.performAuthCheck().finally(() => {
        // Guarded so a sign-out that already detached this check cannot
        // clear a newer session's in-flight authentication.
        if (this.authCheck === pending) this.authCheck = null;
      });
      this.authCheck = pending;
    }
    return this.authCheck;
  }

  private async performAuthCheck(): Promise<void> {
    const generation = this.sessionGeneration;
    if (!this.token) throw new Error("Sign in with Twitch to use this feature.");
    const clientId = this.requireClientId();
    if (this.token.expiresAt <= Date.now() + 60_000) await this.refreshToken(clientId);
    if (this.sessionGeneration !== generation || !this.token) {
      throw new Error(SESSION_CHANGED_MESSAGE);
    }

    let response = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${this.token.accessToken}` },
    });
    if (response.status === 401) {
      await this.refreshToken(clientId);
      if (this.sessionGeneration !== generation || !this.token) {
        throw new Error(SESSION_CHANGED_MESSAGE);
      }
      response = await fetch("https://id.twitch.tv/oauth2/validate", {
        headers: { Authorization: `OAuth ${this.token.accessToken}` },
      });
    }
    const payload = await this.readJson(response);
    if (!response.ok) throw new TwitchRequestError("Your Twitch session is no longer valid.", response.status);
    const validation = validateResponseSchema.parse(payload);
    if (validation.client_id !== clientId) throw new Error("The saved Twitch session belongs to another application.");
    if (this.sessionGeneration !== generation || !this.token) {
      throw new Error(SESSION_CHANGED_MESSAGE);
    }
    this.token.expiresAt = Date.now() + validation.expires_in * 1000;
    this.validatedAt = Date.now();
    this.account ??= await this.fetchAccount();
    this.scheduleValidation();
  }

  private refreshToken(clientId: string): Promise<void> {
    // Twitch rotates refresh tokens: a second concurrent refresh would submit
    // an already-consumed token and invalidate the session. Share one attempt.
    if (!this.refreshInFlight) {
      const pending = this.performTokenRefresh(clientId).finally(() => {
        if (this.refreshInFlight === pending) this.refreshInFlight = null;
      });
      this.refreshInFlight = pending;
    }
    return this.refreshInFlight;
  }

  private async performTokenRefresh(clientId: string): Promise<void> {
    const generation = this.sessionGeneration;
    const tokenAtStart = this.token;
    if (!tokenAtStart) throw new Error("There is no Twitch session to refresh.");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokenAtStart.refreshToken,
      client_id: clientId,
    });
    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await this.readJson(response);
    if (!response.ok) throw new TwitchRequestError(this.errorMessage(payload, "Unable to refresh Twitch sign-in."), response.status);
    const received = tokenResponseSchema.parse(payload);
    if (this.sessionGeneration !== generation || this.token !== tokenAtStart) {
      // The session was signed out or replaced while this refresh was in
      // flight; installing or persisting the result would resurrect it.
      throw new Error(SESSION_CHANGED_MESSAGE);
    }
    this.token = {
      accessToken: received.access_token,
      refreshToken: received.refresh_token,
      scopes: received.scope,
      expiresAt: Date.now() + received.expires_in * 1000,
    };
    this.validatedAt = 0;
    await this.writeToken(this.token);
  }

  private scheduleValidation(): void {
    if (this.validationTimer) return;
    const timer = setInterval(() => {
      if (!this.token) return;
      void this.ensureAuthenticated().catch((error: unknown) => {
        // Keep credentials through transient outages, but promptly erase a
        // token Twitch has explicitly rejected.
        if (isAuthInvalidError(error)) {
          void this.clearToken().catch(() => undefined);
        }
      });
    }, VALIDATION_LIFETIME);
    timer.unref?.();
    this.validationTimer = timer;
  }

  private stopValidationTimer(): void {
    if (this.validationTimer) clearInterval(this.validationTimer);
    this.validationTimer = null;
  }

  private async fetchAccount(): Promise<TwitchAccount> {
    const response = await this.helix("/users", usersResponseSchema, undefined, false);
    const user = response.data[0];
    if (!user) throw new Error("Twitch did not return the signed-in user.");
    return {
      id: user.id,
      login: user.login,
      displayName: user.display_name,
      profileImageUrl: user.profile_image_url,
    };
  }

  private async getUsersByIds(ids: string[]): Promise<z.infer<typeof twitchUserSchema>[]> {
    const uniqueIds = [...new Set(ids.filter((id) => /^\d+$/.test(id)))];
    const users: z.infer<typeof twitchUserSchema>[] = [];
    for (let index = 0; index < uniqueIds.length; index += 100) {
      const query = uniqueIds
        .slice(index, index + 100)
        .map((id) => `id=${encodeURIComponent(id)}`)
        .join("&");
      const response = await this.helix(`/users?${query}`, usersResponseSchema);
      users.push(...response.data);
    }
    return users;
  }

  private async helixAll<T>(
    initialPath: string,
    schema: z.ZodType<{ data: T[]; pagination: { cursor?: string } }>,
  ): Promise<T[]> {
    const all: T[] = [];
    let requestPath: string | null = initialPath;
    while (requestPath) {
      const response: { data: T[]; pagination: { cursor?: string } } = await this.helix(
        requestPath,
        schema,
      );
      all.push(...response.data);
      const cursor: string | undefined = response.pagination.cursor;
      if (!cursor) break;
      const separator = initialPath.includes("?") ? "&" : "?";
      requestPath = `${initialPath}${separator}after=${encodeURIComponent(cursor)}`;
    }
    return all;
  }

  private async helix<T>(
    requestPath: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
    validateFirst = true,
    retryOnUnauthorized = true,
  ): Promise<T> {
    if (validateFirst) await this.ensureAuthenticated();
    if (!this.token) throw new Error("Sign in with Twitch to use this feature.");
    const clientId = this.requireClientId();
    const requestToken = this.token;
    const response = await fetch(`https://api.twitch.tv/helix${requestPath}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${requestToken.accessToken}`,
        "Client-Id": clientId,
        ...init?.headers,
      },
    });
    if (response.status === 401 && retryOnUnauthorized) {
      if (this.token === requestToken) {
        // The cached validation is no longer trustworthy. Refresh once before
        // the single retry; a second 401 propagates as-is.
        this.validatedAt = 0;
        await this.refreshToken(clientId);
      }
      // Otherwise another request already replaced the token while this 401
      // was in flight — retry once with the current token, no extra refresh.
      return this.helix(requestPath, schema, init, validateFirst, false);
    }
    const payload = await this.readJson(response);
    if (!response.ok) {
      throw new TwitchRequestError(this.errorMessage(payload, `Twitch request failed (${response.status}).`), response.status);
    }
    return schema.parse(payload);
  }

  private async readToken(): Promise<StoredToken | null> {
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      const encrypted = await fs.readFile(this.tokenPath);
      return tokenSchema.parse(JSON.parse(safeStorage.decryptString(encrypted)));
    } catch {
      return null;
    }
  }

  private async writeToken(token: StoredToken): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows protected storage is unavailable; Twitch credentials were not saved.");
    }
    const directory = path.dirname(this.tokenPath);
    await fs.mkdir(directory, { recursive: true });
    // Write-then-rename so a crash or concurrent reader can never observe a
    // partially written credential file.
    const temporaryPath = path.join(
      directory,
      `twitch-auth-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      await fs.writeFile(temporaryPath, safeStorage.encryptString(JSON.stringify(token)), {
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.tokenPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private async clearToken(): Promise<void> {
    // Invalidate the session before touching disk so in-flight validation or
    // refresh work discards its result instead of restoring credentials.
    this.sessionGeneration += 1;
    this.stopValidationTimer();
    const pendingRefresh = this.refreshInFlight;
    const pendingCheck = this.authCheck;
    this.refreshInFlight = null;
    this.authCheck = null;
    this.token = null;
    this.account = null;
    this.validatedAt = 0;
    this.chatAssetsCache.clear();
    // Let detached in-flight work settle (the generation bump discards its
    // result) so a delayed refresh cannot recreate the file removed below.
    await Promise.allSettled([pendingRefresh, pendingCheck]);
    try {
      await fs.unlink(this.tokenPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Twitch returned an invalid response (${response.status}).`);
    }
  }

  private errorMessage(payload: unknown, fallback: string): string {
    if (typeof payload === "object" && payload !== null && "message" in payload) {
      const message = (payload as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    return fallback;
  }

  private delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, milliseconds);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          reject(new DOMException("Sign-in cancelled.", "AbortError"));
        },
        { once: true },
      );
    });
  }
}
