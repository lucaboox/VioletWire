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
          image_url_2x: z.string().url(),
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

export class TwitchService {
  private pendingDevice: PendingDeviceAuthorization | null = null;
  private signInController: AbortController | null = null;
  private token: StoredToken | null = null;
  private account: TwitchAccount | null = null;

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
    } catch {
      await this.clearToken();
    }
  }

  async getAuthState(): Promise<TwitchAuthState> {
    if (!this.token) return { status: "signed-out", account: null };
    try {
      await this.ensureAuthenticated();
      return this.account
        ? { status: "signed-in", account: this.account }
        : { status: "signed-out", account: null };
    } catch {
      await this.clearToken();
      return { status: "signed-out", account: null };
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
        this.token = {
          accessToken: received.access_token,
          refreshToken: received.refresh_token,
          scopes: received.scope,
          expiresAt: Date.now() + received.expires_in * 1000,
        };
        await this.writeToken(this.token);
        this.account = await this.fetchAccount();
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
      isLive: Boolean(stream),
      title: stream?.title,
      category: stream?.game_name,
      viewerCount: stream?.viewer_count,
      startedAt: stream?.started_at,
      language: stream?.language,
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

  async sendChatMessage(channel: string, message: string): Promise<void> {
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
      }),
    });
    const delivery = result.data[0];
    if (!delivery?.is_sent) {
      throw new Error(delivery?.drop_reason?.message ?? "Twitch did not send the chat message.");
    }
  }

  async getChatAssets(channel: string): Promise<TwitchChatAssets> {
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
        badges.set(key, { key, title: version.title, imageUrl: version.image_url_2x });
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
    return {
      broadcasterId: broadcaster.id,
      badges: [...badges.values()],
      emotes: [...emotes.values()],
    };
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
    const clientId = await this.requireClientId();
    if (this.token.expiresAt <= Date.now() + 60_000) await this.refreshToken(clientId);

    let response = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${this.token.accessToken}` },
    });
    if (response.status === 401) {
      await this.refreshToken(clientId);
      response = await fetch("https://id.twitch.tv/oauth2/validate", {
        headers: { Authorization: `OAuth ${this.token.accessToken}` },
      });
    }
    const payload = await this.readJson(response);
    if (!response.ok) throw new TwitchRequestError("Your Twitch session is no longer valid.", response.status);
    const validation = validateResponseSchema.parse(payload);
    if (validation.client_id !== clientId) throw new Error("The saved Twitch session belongs to another application.");
    this.token.expiresAt = Date.now() + validation.expires_in * 1000;
    this.account ??= await this.fetchAccount();
  }

  private async refreshToken(clientId: string): Promise<void> {
    if (!this.token) throw new Error("There is no Twitch session to refresh.");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.token.refreshToken,
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
    this.token = {
      accessToken: received.access_token,
      refreshToken: received.refresh_token,
      scopes: received.scope,
      expiresAt: Date.now() + received.expires_in * 1000,
    };
    await this.writeToken(this.token);
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
    const uniqueIds = [...new Set(ids)];
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
  ): Promise<T> {
    if (validateFirst) await this.ensureAuthenticated();
    if (!this.token) throw new Error("Sign in with Twitch to use this feature.");
    const clientId = await this.requireClientId();
    const response = await fetch(`https://api.twitch.tv/helix${requestPath}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token.accessToken}`,
        "Client-Id": clientId,
        ...init?.headers,
      },
    });
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
    await fs.mkdir(path.dirname(this.tokenPath), { recursive: true });
    await fs.writeFile(this.tokenPath, safeStorage.encryptString(JSON.stringify(token)), { mode: 0o600 });
  }

  private async clearToken(): Promise<void> {
    this.token = null;
    this.account = null;
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
