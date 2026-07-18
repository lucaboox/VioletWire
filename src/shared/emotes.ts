import { z } from "zod";

export const emoteProviderSchema = z.enum(["7tv", "ffz", "bttv"]);
export type EmoteProvider = z.infer<typeof emoteProviderSchema>;

export interface EmoteImageVariant {
  url: string;
  width: number;
  height: number;
  format: string;
  scale: number;
}

export interface ProviderEmote {
  id: string;
  name: string;
  provider: EmoteProvider;
  animated: boolean;
  modifier?: boolean;
  modifierFlags?: number;
  variants: EmoteImageVariant[];
}

export interface EmoteSetResult {
  provider: EmoteProvider;
  scope: "global" | "channel";
  emotes: ProviderEmote[];
  cachedAt: number;
  stale: boolean;
}

export interface EmoteApi {
  getSevenTvGlobal(): Promise<EmoteSetResult>;
  getSevenTvChannel(broadcasterId: string): Promise<EmoteSetResult>;
  getFfzGlobal(): Promise<EmoteSetResult>;
  getFfzChannel(broadcasterId: string): Promise<EmoteSetResult>;
  getBttvGlobal(): Promise<EmoteSetResult>;
  getBttvChannel(broadcasterId: string): Promise<EmoteSetResult>;
  clearCache(): Promise<void>;
}
