import { z } from "zod";

export const outgoingChatMessageSchema = z.string().trim().min(1).max(500);
export const chatReplyParentIdSchema = z.string().uuid();
export const chatHistoryLimitSchema = z.number().int().min(20).max(100);

export interface TwitchChatEmoteRange {
  id: string;
  start: number;
  end: number;
  /**
   * Where the image lives, when it is not Twitch's. Twitch sends only an id and
   * the renderer builds its CDN URL from it; other services host their emotes
   * elsewhere, so they supply the URL directly.
   */
  imageUrl?: string;
  provider?: "twitch" | "kick";
}

export interface ChatMessage {
  id: string;
  channel: string;
  login: string;
  displayName: string;
  color: string;
  text: string;
  badges: string[];
  /** Pre-resolved badges (Kick), used in place of the keyed `badges` when set. */
  badgeAssets?: ChatBadgeAsset[];
  sentAt: number;
  twitchEmotes: TwitchChatEmoteRange[];
  notice?: {
    type:
      | "sub"
      | "resub"
      | "subgift"
      | "submysterygift"
      | "giftpaidupgrade"
      | "anongiftpaidupgrade"
      | "raid"
      | "bitsbadgetier"
      | "other";
    systemMessage: string;
    cumulativeMonths?: number;
    streakMonths?: number;
    recipientDisplayName?: string;
    giftCount?: number;
    tier?: string;
  };
  reply?: {
    parentMessageId: string;
    parentUserLogin: string;
    parentDisplayName: string;
    parentMessageBody: string;
    threadMessageId?: string;
    threadUserLogin?: string;
  };
  deleted?: boolean;
  moderation?: {
    type: "message-deleted" | "timeout" | "ban";
    durationSeconds?: number;
  };
  historical?: boolean;
  /**
   * Locally published after Twitch accepts an outgoing message. The
   * authoritative chat copy with the same id replaces it when it arrives.
   */
  pending?: boolean;
  /** IRC "/me" message: rendered in the sender's color, Twitch-style. */
  action?: boolean;
}

export function formatChatTimestamp(sentAt: number): string {
  return new Date(sentAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

// Break an arbitrary timeout length into its two most significant units, e.g.
// 90 → "1m 30s", 3661 → "1h 1m", 180000 → "2d 2h". The previous formatter only
// converted exact multiples, so any non-round duration showed raw seconds.
export function formatTimeoutDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const units: Array<[number, string]> = [
    [86_400, "d"],
    [3_600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  const parts: string[] = [];
  let remaining = seconds;
  for (const [size, label] of units) {
    if (parts.length >= 2) break;
    if (remaining >= size) {
      parts.push(`${Math.floor(remaining / size)}${label}`);
      remaining %= size;
    }
  }
  return parts.length > 0 ? parts.join(" ") : "0s";
}

export function formatModerationAction(message: ChatMessage): string {
  if (message.moderation?.type === "timeout") {
    return `timed out for ${formatTimeoutDuration(message.moderation.durationSeconds ?? 0)}`;
  }
  if (message.moderation?.type === "ban") return "permanently banned";
  return "deleted";
}

// True when `message` @-mentions `login` (or is a reply to them). `login` is
// expected already lowercased; an empty login (signed out) never matches, and
// the viewer's own messages are excluded.
export function messageMentionsLogin(message: ChatMessage, login: string): boolean {
  if (!login || message.login.toLowerCase() === login) return false;
  if (message.reply?.parentUserLogin.toLowerCase() === login) return true;
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)@${escaped}(?=$|\\s|[.,!?;:])`, "i").test(message.text);
}

export type ChatConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/**
 * A channel's active chat modes, so the composer can explain why a message
 * might be refused. Which of these a viewer actually meets (follow age, sub
 * status) is not always knowable, so this describes the room, not the viewer.
 */
export interface ChatRestrictions {
  followersOnly: boolean;
  /** Minutes of following required, when the channel sets one. */
  followersMinMinutes?: number;
  subscribersOnly: boolean;
  /** Seconds between messages in slow mode. */
  slowModeSeconds?: number;
  emoteOnly: boolean;
}

export const NO_CHAT_RESTRICTIONS: ChatRestrictions = {
  followersOnly: false,
  subscribersOnly: false,
  emoteOnly: false,
};

export interface ChatBadgeAsset {
  key: string;
  title: string;
  imageUrl: string;
  imageUrls?: string[];
  // Kick's built-in badges have no image in its API. Recognised ones are drawn
  // from a named glyph; the rest show as a small coloured chip.
  glyph?: string;
  label?: string;
  color?: string;
}

/**
 * Kick badge types VioletWire draws from Kick's own glyph artwork rather than a
 * coloured chip. This is the single source of truth: the main process reads it
 * to decide glyph-versus-chip, and the renderer's KickBadgeGlyph must carry the
 * artwork for exactly these types (its map is typed against this list, so a new
 * entry here fails the build until the SVG is pasted in). Anything not listed
 * still falls back to a chip.
 */
export const KICK_GLYPH_BADGE_TYPES = ["moderator", "verified", "sub_gifter", "vip"] as const;
export type KickGlyphBadge = (typeof KICK_GLYPH_BADGE_TYPES)[number];

export interface TwitchPickerEmote {
  id: string;
  name: string;
  imageUrl: string;
  scope: "global" | "channel";
  subscriptionOnly: boolean;
  ownerId?: string;
  ownerName?: string;
  ownerImageUrl?: string;
  categoryId?: string;
  categoryName?: string;
}

export interface TwitchChatAssets {
  broadcasterId: string;
  badges: ChatBadgeAsset[];
  emotes: TwitchPickerEmote[];
}

/** A display chat can be stood against, as the placement picker draws it. */
export interface ChatWindowDisplay {
  id: number;
  primary: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  /** What its reported size was divided by, so real sizes can be recovered. */
  scaleFactor: number;
}

export interface ChatApi {
  send(channel: string, message: string, replyParentMessageId?: string): Promise<void>;
  getAssets(channel: string): Promise<TwitchChatAssets>;
  setHistoryLimit(limit: number): void;
  onMessage(listener: (message: ChatMessage) => void): () => void;
  onState(listener: (state: ChatConnectionState) => void): () => void;
  onRestrictions(listener: (restrictions: ChatRestrictions) => void): () => void;
  /** Displays chat's own window can be stood against, and how to do it. */
  getDisplays(): Promise<ChatWindowDisplay[]>;
  placeWindow(displayId: number, side: "left" | "right"): Promise<void>;
}
