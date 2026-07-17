import { z } from "zod";

export const emoteProviderSchema = z.enum(["7tv"]);

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
  provider: "7tv";
  animated: boolean;
  variants: EmoteImageVariant[];
}

export interface EmoteSetResult {
  provider: "7tv";
  scope: "global" | "channel";
  emotes: ProviderEmote[];
  cachedAt: number;
  stale: boolean;
}

export interface EmoteApi {
  getSevenTvGlobal(): Promise<EmoteSetResult>;
  getSevenTvChannel(broadcasterId: string): Promise<EmoteSetResult>;
  clearCache(): Promise<void>;
}
