import { z } from "zod";

export const outgoingChatMessageSchema = z.string().trim().min(1).max(500);
export const chatReplyParentIdSchema = z.string().uuid();
export const chatHistoryLimitSchema = z.number().int().min(20).max(100);

export interface TwitchChatEmoteRange {
  id: string;
  start: number;
  end: number;
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

export function formatModerationAction(message: ChatMessage): string {
  if (message.moderation?.type === "timeout") {
    const seconds = message.moderation.durationSeconds ?? 0;
    if (seconds >= 86_400 && seconds % 86_400 === 0) return `timed out for ${seconds / 86_400}d`;
    if (seconds >= 3_600 && seconds % 3_600 === 0) return `timed out for ${seconds / 3_600}h`;
    if (seconds >= 60 && seconds % 60 === 0) return `timed out for ${seconds / 60}m`;
    return `timed out for ${seconds}s`;
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
}
