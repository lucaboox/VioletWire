export interface LinkPreview {
  kind: "twitch-clip" | "kick-clip" | "youtube" | "imgur-album";
  title: string;
  author: string;
  thumbnailUrl: string;
  url: string;
  durationSeconds?: number;
  createdAt?: string;
  viewCount?: number;
}
