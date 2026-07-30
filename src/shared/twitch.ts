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

export const twitchNamedChatColorSchema = z.enum([
  "blue",
  "blue_violet",
  "cadet_blue",
  "chocolate",
  "coral",
  "dodger_blue",
  "firebrick",
  "golden_rod",
  "green",
  "hot_pink",
  "orange_red",
  "red",
  "sea_green",
  "spring_green",
  "yellow_green",
]);
export const twitchChatColorInputSchema = z.union([
  twitchNamedChatColorSchema,
  z.string().regex(/^#[0-9a-f]{6}$/i, "Choose a valid six-digit color."),
]);
export type TwitchChatColorInput = z.infer<typeof twitchChatColorInputSchema>;

export interface TwitchChatColorState {
  color: string;
  canUpdate: boolean;
}

export interface TwitchPinnedChatFragment {
  type: "text" | "emote" | "cheermote" | "mention";
  text: string;
  emote?: {
    id: string;
    formats: string[];
    imageUrl?: string;
  };
}

export interface TwitchPinnedChatMessage {
  id: string;
  senderId: string;
  senderLogin: string;
  senderName: string;
  /** Absent when the provider does not disclose who created the pin. */
  pinnedByName?: string;
  text: string;
  fragments: TwitchPinnedChatFragment[];
  startsAt: string;
  endsAt?: string;
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
  viewerCount?: number;
  startedAt?: string;
  language?: string;
  tags?: string[];
  isMature?: boolean;
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
  getPinnedChatMessage(broadcasterId: string): Promise<TwitchPinnedChatMessage | null>;
  getChatColor(): Promise<TwitchChatColorState>;
  updateChatColor(color: TwitchChatColorInput): Promise<TwitchChatColorState>;
  createClip(channel: string): Promise<ClipCreationResult>;
  openChannel(channel: string): Promise<void>;
}
