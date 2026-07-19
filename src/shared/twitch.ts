import { z } from "zod";

export const twitchClientIdSchema = z
  .string()
  .trim()
  .min(5, "Enter the Client ID from the Twitch developer console.")
  .max(64)
  .regex(/^[a-z0-9]+$/i, "The Twitch Client ID contains invalid characters.");

export const twitchUserSchema = z.object({
  id: z.string(),
  login: z.string(),
  display_name: z.string(),
  profile_image_url: z.string().url(),
  description: z.string().optional().default(""),
  created_at: z.string().optional().default(""),
});

export const twitchStreamSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  user_login: z.string(),
  user_name: z.string(),
  game_id: z.string(),
  game_name: z.string(),
  title: z.string(),
  viewer_count: z.number().int().nonnegative(),
  started_at: z.string(),
  language: z.string(),
  tags: z
    .array(z.string())
    .nullish()
    .transform((tags) => tags ?? []),
  thumbnail_url: z.string(),
  is_mature: z.boolean().optional().default(false),
});

export interface TwitchAccount {
  id: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
}

export type TwitchAuthState =
  | { status: "unconfigured"; account: null; message: string }
  | { status: "signed-out"; account: null }
  | { status: "signed-in"; account: TwitchAccount };

export interface TwitchDeviceAuthorization {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface FollowedChannel {
  id: string;
  login: string;
  displayName: string;
  category: string;
  title?: string;
  language?: string;
  tags?: string[];
  isMature?: boolean;
  profileImageUrl: string;
  thumbnailUrl?: string;
  viewerCount: number;
  startedAt?: string;
  isLive: boolean;
}

export interface BrowseCategory {
  id: string;
  name: string;
  boxArtUrl: string;
}

export interface BrowseStream {
  id: string;
  broadcasterId: string;
  login: string;
  displayName: string;
  title: string;
  category: string;
  language: string;
  tags: string[];
  isMature: boolean;
  profileImageUrl: string;
  thumbnailUrl: string;
  viewerCount: number;
  startedAt: string;
}

export interface BrowsePage<T> {
  items: T[];
  cursor?: string;
}

export interface SearchChannelResult {
  id: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
  title: string;
  category: string;
  isLive: boolean;
}

export interface TwitchSearchResults {
  channels: SearchChannelResult[];
  categories: BrowseCategory[];
}

export interface StreamMetadata {
  broadcasterId: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
  description?: string;
  isLive: boolean;
  title?: string;
  categoryId?: string;
  category?: string;
  viewerCount?: number;
  startedAt?: string;
  language?: string;
  tags?: string[];
  isMature?: boolean;
  isFollowed?: boolean;
  subscription?: {
    isSubscribed: boolean;
    tier?: string;
    isGift?: boolean;
  };
}

export interface ClipCreationResult {
  id: string;
  editUrl: string;
}

export interface ChatUserProfile {
  id: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
  description: string;
  createdAt: string;
  /**
   * Public relationship details supplied by IVR.fi's Twitch subage endpoint.
   * Twitch Helix intentionally does not expose these details for arbitrary
   * chatters, so this is kept separate from the authenticated-user relation.
   */
  subage?: {
    followingSince?: string;
    subscription: {
      isHidden: boolean;
      isSubscribed: boolean;
      tier?: string;
      cumulativeMonths: number;
    };
  };
  relationship?: {
    isFollowing: boolean;
    followedAt?: string;
    subscription?: {
      isSubscribed: boolean;
      tier?: string;
      isGift?: boolean;
    };
  };
}

export interface PlaybackSessionState {
  linked: boolean;
  login?: string;
  message?: string;
}

export interface TwitchClipPreview {
  url: string;
  broadcasterName: string;
  title: string;
  viewCount: number;
  createdAt: string;
  thumbnailUrl: string;
  durationSeconds: number;
}

export interface TwitchApi {
  getAuthState(): Promise<TwitchAuthState>;
  beginSignIn(): Promise<TwitchDeviceAuthorization>;
  completeSignIn(): Promise<TwitchAuthState>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<TwitchAuthState>;
  getPlaybackSessionState(): Promise<PlaybackSessionState>;
  linkPlaybackSession(): Promise<PlaybackSessionState>;
  unlinkPlaybackSession(): Promise<PlaybackSessionState>;
  getFollowedChannels(): Promise<FollowedChannel[]>;
  getBrowseCategories(query?: string, after?: string): Promise<BrowsePage<BrowseCategory>>;
  getCategoryStreams(gameId: string, after?: string): Promise<BrowsePage<BrowseStream>>;
  search(query: string): Promise<TwitchSearchResults>;
  getStreamMetadata(channel: string): Promise<StreamMetadata | null>;
  getChatUserProfile(channel: string, login: string): Promise<ChatUserProfile>;
  createClip(channel: string): Promise<ClipCreationResult>;
  openSubscription(channel: string): Promise<void>;
  openChannel(channel: string): Promise<void>;
}
