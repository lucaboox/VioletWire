export interface LinkPreview {
  kind: "twitch-clip" | "youtube";
  title: string;
  author: string;
  thumbnailUrl: string;
  url: string;
  durationSeconds?: number;
  createdAt?: string;
  viewCount?: number;
}
