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
}

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

export interface ChatApi {
  send(channel: string, message: string, replyParentMessageId?: string): Promise<void>;
  getAssets(channel: string): Promise<TwitchChatAssets>;
  setHistoryLimit(limit: number): void;
  onMessage(listener: (message: ChatMessage) => void): () => void;
  onState(listener: (state: ChatConnectionState) => void): () => void;
  onRestrictions(listener: (restrictions: ChatRestrictions) => void): () => void;
}
