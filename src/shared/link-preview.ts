export interface LinkPreview {
  kind: "twitch-clip" | "kick-clip" | "youtube" | "imgur-album" | "generic";
  title: string;
  author: string;
  thumbnailUrl?: string;
  url: string;
  description?: string;
  durationSeconds?: number;
  createdAt?: string;
  viewCount?: number;
}
