import { z } from "zod";

export const outgoingChatMessageSchema = z.string().trim().min(1).max(500);
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
  deleted?: boolean;
  historical?: boolean;
}

export function formatChatTimestamp(sentAt: number): string {
  return new Date(sentAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export type ChatConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface ChatBadgeAsset {
  key: string;
  title: string;
  imageUrl: string;
}

export interface TwitchPickerEmote {
  id: string;
  name: string;
  imageUrl: string;
  scope: "global" | "channel";
  subscriptionOnly: boolean;
}

export interface TwitchChatAssets {
  broadcasterId: string;
  badges: ChatBadgeAsset[];
  emotes: TwitchPickerEmote[];
}

export interface ChatApi {
  send(channel: string, message: string): Promise<void>;
  getAssets(channel: string): Promise<TwitchChatAssets>;
  setHistoryLimit(limit: number): void;
  onMessage(listener: (message: ChatMessage) => void): () => void;
  onState(listener: (state: ChatConnectionState) => void): () => void;
}
